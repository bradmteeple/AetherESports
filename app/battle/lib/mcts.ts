// Monte Carlo search for the Auto Battle AI.
//
// At every decision (Team Preview, each turn, each forced switch) we run a Monte Carlo search over
// a FORKED copy of the real Pokémon Showdown simulator. Pokémon turns are SIMULTANEOUS-move, so we
// treat the choice as a small matrix game and solve it with regret matching — the output is a MIXED
// strategy over actions (a distribution), not always a single move. Chance (damage rolls, crits,
// speed ties, secondary effects) is averaged by re-seeding the fork's RNG every iteration and
// playing out to the end. "Mega Evolve now / not now" is just an ordinary action in the set, so the
// search discovers Mega timing on its own — there are no hand-coded Mega rules here.
//
// Substrate (verified): @pkmn/sim exposes a forkable Battle — drive it with setPlayer/choose/
// commitChoices, read legal actions off `side.activeRequest`, deep-copy with
// State.serializeBattle/deserializeBattle, re-seed with PRNG, and detect the end via battle.ended.

import "./node-shim"; // must precede any @pkmn import
import { Battle, State, PRNG, Dex, toID } from "@pkmn/sim";
import { installSimSerializationFix } from "./sim-fix";

installSimSerializationFix(); // keep State refs valid under production minification (before any fork)

// Accuracy-first defaults. These trade time for quality; the search is meant to "run for a while".
export const DEFAULTS = {
  turnBudget: 250, // iterations per in-battle decision (one search covers both sides)
  teamBudget: 450, // iterations for the (larger) Team Preview decision
  rolloutTurnCap: 40, // playout depth cap before falling back to a neutral HP eval
  megaRolloutProb: 0.5, // chance the light rollout policy Mega Evolves when able (varied timing)
};

const P1 = "p1";
const P2 = "p2";
type SideID = "p1" | "p2";
const other = (s: SideID): SideID => (s === "p1" ? "p2" : "p1");

// A tiny deterministic-ish RNG wrapper so search/rollouts don't touch Math.random directly (kept
// separate from the battle PRNG, which drives the simulation's chance events).
export type Rng = () => number;

// ---- Type-chart damage estimate (rollout policy only; NOT used for the real decision) -----------

function typeEff(atkType: string, defTypes: string[]): number {
  for (const t of defTypes) if (!Dex.getImmunity(atkType, t)) return 0;
  let exp = 0;
  for (const t of defTypes) exp += Dex.getEffectiveness(atkType, t);
  return Math.pow(2, exp);
}

// ---- Legal-action enumeration (the search's action set per side) --------------------------------

interface Factor {
  tokens: string[]; // candidate choice tokens for this decision slot
}
interface SideDecision {
  kind: "teampreview" | "move" | "switch";
  factors: Factor[]; // one regret-matching learner each
  slotMap: (number | null)[]; // per active slot → factor index, or null to "pass" (move/switch only)
}

function combos4(n: number): number[][] {
  // All 4-subsets of [1..n] (n is 6 for Reg M-B → 15 subsets).
  const out: number[][] = [];
  for (let a = 1; a <= n; a++)
    for (let b = a + 1; b <= n; b++)
      for (let c = b + 1; c <= n; c++)
        for (let d = c + 1; d <= n; d++) out.push([a, b, c, d]);
  return out;
}

// Team-preview selections: which 4 of 6, and which 2 of those 4 lead (order matters for slot a/b).
function teamPreviewTokens(n: number): string[] {
  const tokens: string[] = [];
  for (const set of combos4(n)) {
    for (let i = 0; i < set.length; i++) {
      for (let j = 0; j < set.length; j++) {
        if (i === j) continue;
        const leads = [set[i], set[j]];
        const rest = set.filter((x) => x !== set[i] && x !== set[j]);
        tokens.push("team " + [...leads, ...rest].join(""));
      }
    }
  }
  return tokens;
}

function aliveActiveIdx(side: any): number[] {
  return [0, 1].filter((k) => side.active[k] && side.active[k].hp > 0 && !side.active[k].fainted);
}

// Candidate tokens for one active slot in a move request: every usable move × every legal target,
// each also offered as a " mega" variant when the mon can Mega Evolve, plus every legal switch.
function moveSlotTokens(battle: any, side: SideID, req: any, slotIdx: number): string[] {
  const s = battle[side];
  const a = req.active[slotIdx];
  const tokens: string[] = [];
  const foe = battle[other(side)];
  const foeAlive = aliveActiveIdx(foe);
  const allyIdx = slotIdx ^ 1;
  const allyAlive = s.active[allyIdx] && s.active[allyIdx].hp > 0 && !s.active[allyIdx].fainted;

  (a.moves || []).forEach((m: any, mi0: number) => {
    if (m.disabled) return;
    const mi = mi0 + 1;
    const tgt = m.target;
    let targetSuffixes: string[] = [];
    if (tgt === "normal" || tgt === "any" || tgt === "adjacentFoe") {
      targetSuffixes = (foeAlive.length ? foeAlive : [0]).map((k) => " " + (k + 1));
    } else if (tgt === "adjacentAlly") {
      if (!allyAlive) return;
      targetSuffixes = [" -" + (allyIdx + 1)];
    } else if (tgt === "adjacentAllyOrSelf") {
      targetSuffixes = [" -" + (slotIdx + 1)];
      if (allyAlive) targetSuffixes.push(" -" + (allyIdx + 1));
    } else {
      targetSuffixes = [""]; // self / spread / field — no target argument
    }
    for (const suf of targetSuffixes) {
      tokens.push("move " + mi + suf);
      if (a.canMegaEvo) tokens.push("move " + mi + suf + " mega");
    }
  });

  if (!a.trapped) {
    s.pokemon.forEach((p: any, pi: number) => {
      if (!p.isActive && !p.fainted) tokens.push("switch " + (pi + 1));
    });
  }
  if (!tokens.length) tokens.push("move 1"); // Struggle / no legal move fallback
  return tokens;
}

function sideDecision(battle: any, side: SideID): SideDecision | null {
  const req = battle[side].activeRequest;
  if (!req || req.wait) return null;

  if (req.teamPreview) {
    const n = battle[side].pokemon.length;
    return { kind: "teampreview", factors: [{ tokens: teamPreviewTokens(n) }], slotMap: [] };
  }

  if (req.forceSwitch) {
    const s = battle[side];
    const factors: Factor[] = [];
    const slotMap: (number | null)[] = [];
    req.forceSwitch.forEach((need: boolean, i: number) => {
      if (!need) {
        slotMap.push(null);
        return;
      }
      const tokens: string[] = [];
      s.pokemon.forEach((p: any, pi: number) => {
        if (!p.isActive && !p.fainted) tokens.push("switch " + (pi + 1));
      });
      if (!tokens.length) tokens.push("pass");
      slotMap.push(factors.length);
      factors.push({ tokens });
    });
    return { kind: "switch", factors, slotMap };
  }

  if (req.active) {
    const factors: Factor[] = [];
    const slotMap: (number | null)[] = [];
    req.active.forEach((a: any, i: number) => {
      const mon = battle[side].active[i];
      if (!a || !mon || mon.fainted) {
        slotMap.push(null);
        return;
      }
      slotMap.push(factors.length);
      factors.push({ tokens: moveSlotTokens(battle, side, req, i) });
    });
    return { kind: "move", factors, slotMap };
  }
  return null;
}

// Assemble a full side choice string from one sampled token per factor, enforcing the once-per-turn
// Mega constraint and preventing two slots from switching to the same benched Pokémon.
function assemble(dec: SideDecision, picks: string[]): string {
  if (dec.kind === "teampreview") return picks[0];
  const slotToks = dec.slotMap.map((fi) => (fi == null ? "pass" : picks[fi]));
  let megaSeen = false;
  for (let i = 0; i < slotToks.length; i++) {
    if (slotToks[i].endsWith(" mega")) {
      if (megaSeen) slotToks[i] = slotToks[i].slice(0, -5);
      else megaSeen = true;
    }
  }
  const usedSwitch = new Set<string>();
  for (let i = 0; i < slotToks.length; i++) {
    const mm = /^switch (\d+)/.exec(slotToks[i]);
    if (mm) {
      if (usedSwitch.has(mm[1])) slotToks[i] = "pass";
      else usedSwitch.add(mm[1]);
    }
  }
  return slotToks.join(", ");
}

// ---- Applying choices + terminal detection ------------------------------------------------------

function sideActs(side: any): boolean {
  return !!side.activeRequest && !side.activeRequest.wait;
}

// Submit each acting side's choice and advance one step. Falls back to the engine's default choice
// if a (rare) assembled string is rejected. Returns false if committing threw (a rare @pkmn/sim
// end-state quirk when a doubles slot goes null) so callers can treat the position as terminal
// instead of wedging.
function applyChoices(battle: any, choices: { p1?: string; p2?: string }): boolean {
  try {
    for (const sid of [P1, P2] as SideID[]) {
      const c = choices[sid];
      if (c == null) continue;
      let ok = false;
      try {
        ok = battle.choose(sid, c);
      } catch {
        ok = false;
      }
      if (!ok) {
        try {
          battle[sid].clearChoice();
        } catch {
          /* noop */
        }
        try {
          battle.choose(sid, "default");
        } catch {
          /* noop */
        }
      }
    }
    if (!battle.allChoicesDone()) {
      for (const sid of [P1, P2] as SideID[]) {
        if (sideActs(battle[sid]) && !battle[sid].isChoiceDone()) {
          try {
            battle.choose(sid, "default");
          } catch {
            /* noop */
          }
        }
      }
    }
    if (battle.allChoicesDone()) battle.commitChoices();
    return true;
  } catch {
    return false;
  }
}

function terminalValue(battle: any): number {
  // p1's perspective: win = 1, tie = 0.5, loss = 0. (p1 is named "Blue", p2 "Red".)
  if (battle.winner === "Blue" || battle.winner === battle.p1?.name) return 1;
  if (battle.winner === "Red" || battle.winner === battle.p2?.name) return 0;
  return 0.5;
}

// Neutral leaf evaluation if a rollout hits the depth cap: share of total remaining HP.
function evalState(battle: any): number {
  const frac = (side: any) => {
    let cur = 0,
      max = 0;
    for (const p of side.pokemon) {
      cur += Math.max(0, p.hp);
      max += p.maxhp || 1;
    }
    return max ? cur / max : 0;
  };
  const a = frac(battle.p1);
  const b = frac(battle.p2);
  return a + b > 0 ? a / (a + b) : 0.5;
}

// ---- Light rollout policy (playouts only) -------------------------------------------------------

function bestDamageToken(battle: any, side: SideID, slotIdx: number, req: any, rng: Rng): string {
  const s = battle[side];
  const a = req.active[slotIdx];
  const foe = battle[other(side)];
  const foeAlive = aliveActiveIdx(foe);
  const myTypes: string[] = s.active[slotIdx]?.types ?? [];
  let best = "";
  let bestScore = -1;
  const consider = (tok: string, score: number) => {
    if (score > bestScore || (score === bestScore && rng() < 0.5)) {
      bestScore = score;
      best = tok;
    }
  };
  (a.moves || []).forEach((m: any, mi0: number) => {
    if (m.disabled) return;
    const mi = mi0 + 1;
    const mv = Dex.moves.get(m.id || m.move);
    const tgt = m.target;
    if (mv.category === "Status") {
      consider("move " + mi, 5); // low baseline so status is used occasionally
      return;
    }
    const stab = myTypes.includes(mv.type) ? 1.5 : 1;
    if (tgt === "normal" || tgt === "any" || tgt === "adjacentFoe") {
      const targets = foeAlive.length ? foeAlive : [0];
      for (const k of targets) {
        const dt = foe.active[k]?.types ?? [];
        const score = (mv.basePower || 0) * stab * typeEff(mv.type, dt);
        consider("move " + mi + " " + (k + 1), score);
      }
    } else {
      // spread / self / field: score against the best foe matchup
      let eff = 1;
      for (const k of foeAlive) eff = Math.max(eff, typeEff(mv.type, foe.active[k]?.types ?? []));
      consider("move " + mi, (mv.basePower || 0) * stab * eff);
    }
  });
  if (!best) best = "move 1";
  if (a.canMegaEvo && best.startsWith("move ") && rng() < DEFAULTS.megaRolloutProb) best += " mega";
  return best;
}

function lightChoice(battle: any, side: SideID, rng: Rng): string {
  const s = battle[side];
  const req = s.activeRequest;
  if (req.teamPreview) {
    const n = s.pokemon.length;
    const idx = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return "team " + idx.slice(0, Math.min(4, n)).join("");
  }
  if (req.forceSwitch) {
    const bench: number[] = [];
    s.pokemon.forEach((p: any, pi: number) => {
      if (!p.isActive && !p.fainted) bench.push(pi + 1);
    });
    const toks = req.forceSwitch.map((need: boolean) => {
      if (!need) return "pass";
      if (!bench.length) return "pass";
      const j = bench.splice(Math.floor(rng() * bench.length), 1)[0];
      return "switch " + j;
    });
    return toks.join(", ");
  }
  if (req.active) {
    let megaUsed = false;
    const toks = req.active.map((a: any, i: number) => {
      const mon = s.active[i];
      if (!a || !mon || mon.fainted) return "pass";
      let tok = bestDamageToken(battle, side, i, req, rng);
      if (tok.endsWith(" mega")) {
        if (megaUsed) tok = tok.slice(0, -5);
        else megaUsed = true;
      }
      return tok;
    });
    return toks.join(", ");
  }
  return "default";
}

function playout(battle: any, rng: Rng, cap: number): number {
  let turns = 0;
  while (!battle.ended && turns < cap) {
    const ok = applyChoices(battle, {
      p1: sideActs(battle.p1) ? lightChoice(battle, P1, rng) : undefined,
      p2: sideActs(battle.p2) ? lightChoice(battle, P2, rng) : undefined,
    });
    if (!ok) break; // sim end-state quirk → score the position we reached
    if (battle.requestState === "move") turns++;
  }
  return battle.ended ? terminalValue(battle) : evalState(battle);
}

// ---- Regret-matching learner (per factor) -------------------------------------------------------

interface Learner {
  acts: string[];
  R: Map<string, number>; // cumulative regret (RM+, floored at 0)
  S: Map<string, number>; // cumulative strategy weight (for the average / output strategy)
  N: Map<string, number>; // times each action was sampled
  W: Map<string, number>; // sum of rollout values when each action was sampled
  V: number; // running mean value to this side (baseline for un-sampled actions)
  n: number;
}

function rmStrategy(L: Learner): number[] {
  let sum = 0;
  const pos = L.acts.map((a) => {
    const r = Math.max(0, L.R.get(a) || 0);
    sum += r;
    return r;
  });
  if (sum <= 1e-9) return L.acts.map(() => 1 / L.acts.length);
  return pos.map((r) => r / sum);
}

function avgStrategy(L: Learner): number[] {
  let sum = 0;
  const s = L.acts.map((a) => {
    const v = L.S.get(a) || 0;
    sum += v;
    return v;
  });
  if (sum <= 1e-9) return L.acts.map(() => 1 / L.acts.length);
  return s.map((v) => v / sum);
}

function sample(acts: string[], probs: number[], rng: Rng): number {
  let r = rng();
  for (let i = 0; i < acts.length; i++) {
    r -= probs[i];
    if (r <= 0) return i;
  }
  return acts.length - 1;
}

// ---- Serialization / forking --------------------------------------------------------------------

// `snapshot` MUST be a JSON string: State.serializeBattle returns an object that ALIASES the live
// battle's arrays (log, queue, …), so deserializing from that object would let forks mutate the
// root. Round-tripping through a string fully detaches every fork.
function forkFrom(snapshot: string): any {
  const b = State.deserializeBattle(snapshot);
  b.resetRNG(null); // roll a fresh chance seed so iterations average over the RNG distribution
  return b;
}

// ---- The search ---------------------------------------------------------------------------------

export interface SideResult {
  choice: string; // the sampled full choice string for this side
  strategy: number[][]; // per factor: the mixed strategy (probabilities aligned with `acts`)
  acts: string[][]; // per factor: the action labels
}
export type SearchResult = { p1?: SideResult; p2?: SideResult };

/**
 * Solve the current decision by Monte Carlo search: sample joint actions via regret matching, play
 * each fork out to the end (chance re-seeded every iteration), and update regrets from the outcome.
 * Returns, per acting side, a mixed strategy and a choice sampled from its equilibrium average.
 */
export function search(root: any, rng: Rng, budget: number): SearchResult {
  const decisions: Partial<Record<SideID, SideDecision>> = {};
  const learners: Partial<Record<SideID, Learner[]>> = {};
  for (const sid of [P1, P2] as SideID[]) {
    const d = sideDecision(root, sid);
    if (!d) continue;
    decisions[sid] = d;
    learners[sid] = d.factors.map((f) => ({
      acts: f.tokens,
      R: new Map(),
      S: new Map(),
      N: new Map(),
      W: new Map(),
      V: 0.5,
      n: 0,
    }));
  }
  const acting = (Object.keys(decisions) as SideID[]).filter((s) => decisions[s]);
  if (!acting.length) return {};

  const snapshot = JSON.stringify(State.serializeBattle(root)); // string → forks fully isolated

  for (let it = 0; it < budget; it++) {
    const fork = forkFrom(snapshot);
    const picks: Partial<Record<SideID, number[]>> = {};
    const sigmas: Partial<Record<SideID, number[][]>> = {};
    const choice: { p1?: string; p2?: string } = {};

    for (const sid of acting) {
      const Ls = learners[sid]!;
      const sig = Ls.map((L) => rmStrategy(L));
      const pk = Ls.map((L, fi) => sample(L.acts, sig[fi], rng));
      sigmas[sid] = sig;
      picks[sid] = pk;
      choice[sid] = assemble(
        decisions[sid]!,
        pk.map((idx, fi) => Ls[fi].acts[idx])
      );
    }

    const applied = applyChoices(fork, choice);
    const v = applied ? playout(fork, rng, DEFAULTS.rolloutTurnCap) : evalState(fork);

    for (const sid of acting) {
      const val = sid === P1 ? v : 1 - v;
      const Ls = learners[sid]!;
      Ls.forEach((L, fi) => {
        const chosen = L.acts[picks[sid]![fi]];
        L.N.set(chosen, (L.N.get(chosen) || 0) + 1);
        L.W.set(chosen, (L.W.get(chosen) || 0) + val);
        L.n++;
        L.V += (val - L.V) / L.n; // running node value; the baseline for un-sampled actions
        const sig = sigmas[sid]![fi];
        // Estimated value of each action (mean rollout value; un-sampled fall back to the baseline).
        const Q = L.acts.map((a) => {
          const n = L.N.get(a) || 0;
          return n > 0 ? (L.W.get(a) || 0) / n : L.V;
        });
        const ev = L.acts.reduce((s, _a, i) => s + sig[i] * Q[i], 0); // value under current strategy
        L.acts.forEach((a, ai) => {
          // CFR-style regret: how much better action a is than playing the current strategy.
          L.R.set(a, Math.max(0, (L.R.get(a) || 0) + (Q[ai] - ev)));
          L.S.set(a, (L.S.get(a) || 0) + sig[ai]);
        });
      });
    }
  }

  const out: SearchResult = {};
  for (const sid of acting) {
    const Ls = learners[sid]!;
    const strat = Ls.map((L) => avgStrategy(L));
    const pk = Ls.map((L, fi) => sample(L.acts, strat[fi], rng));
    out[sid] = {
      choice: assemble(
        decisions[sid]!,
        pk.map((idx, fi) => Ls[fi].acts[idx])
      ),
      strategy: strat,
      acts: Ls.map((L) => L.acts),
    };
  }
  return out;
}

// ---- Battle construction helper (bare Battle, no streams) ---------------------------------------

export function createBattle(formatid: string, p1Team: string, p2Team: string, seed?: any): any {
  const battle = new Battle({ formatid: formatid as any, seed });
  battle.setPlayer(P1, { name: "Blue", team: p1Team });
  battle.setPlayer(P2, { name: "Red", team: p2Team });
  return battle;
}

export { PRNG, toID };
