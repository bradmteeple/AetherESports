// Behavioral model of the human player (p1), learned across games AND within the current game, so the
// Level 3 Monte Carlo AI can play EXPLOITATIVELY — anticipating how you tend to play, including your
// "reads" (e.g. a habit of switching out when the AI has the better matchup). The model is a coarse,
// TYPE-based tendency profile so it transfers across games even when the teams differ (Random Battle),
// while a within-game copy (weighted higher) captures what you're doing right now.
//
// The profile is fed into the search as a prior over p1's actions (see mcts.ts): with data, the AI's
// best response is computed against the player it is actually facing; with none, it falls back to
// game-theoretic equilibrium.

import "./node-shim"; // must precede any @pkmn import
import { Dex, toID } from "@pkmn/sim";

// Action categories we bucket a committed p1 choice into. These are the axes a "read" lives on:
// do you switch under pressure, shield with Protect, chip with status, or commit to an attack.
export type ActionCat = "switch" | "protect" | "status" | "attack";
const CATS: ActionCat[] = ["switch", "protect", "status", "attack"];

// sig -> category -> count. `sig` is a coarse matchup bucket (see bucketFor) so tendencies generalize.
export interface OpponentModel {
  games: number;
  actions: Record<string, Partial<Record<ActionCat, number>>>;
}

const KEY = "aether-opp-model";

export function emptyModel(): OpponentModel {
  return { games: 0, actions: {} };
}

export function loadModel(): OpponentModel {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const m = JSON.parse(raw);
      return { games: m.games || 0, actions: m.actions || {} };
    }
  } catch {
    /* localStorage unavailable */
  }
  return emptyModel();
}

export function saveModel(m: OpponentModel) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

// Type-chart multiplier (kept local so this module stays independent of mcts.ts).
function typeEff(atkType: string, defTypes: string[]): number {
  for (const t of defTypes) if (!Dex.getImmunity(atkType, t)) return 0;
  let exp = 0;
  for (const t of defTypes) exp += Dex.getEffectiveness(atkType, t);
  return Math.pow(2, exp);
}

// Best super-effective potential of an attacker's STAB types vs a defender.
function stabThreat(atkTypes: string[], defTypes: string[]): number {
  return atkTypes.reduce((mx, t) => Math.max(mx, typeEff(t, defTypes)), 0);
}

// A coarse, transferable matchup bucket for `side`'s active mon vs the foe's active: whether the mon
// threatens the foe (STAB SE) and whether it is itself threatened. Four buckets: "t{0|1}v{0|1}".
// `t` = I threaten the foe, `v` = I'm vulnerable to the foe. Reads cluster by bucket (e.g. players
// switch far more often from "safe-but-can't-threaten" or "vulnerable" spots).
export function bucketFor(battle: any, side: "p1" | "p2", slot = 0): string | null {
  const me = battle?.[side]?.active?.[slot];
  const foeSide = side === "p1" ? "p2" : "p1";
  const foe = battle?.[foeSide]?.active?.[0];
  if (!me || !foe || me.fainted || foe.fainted) return null;
  const myTypes: string[] = me.types ?? [];
  const foeTypes: string[] = foe.types ?? [];
  const threaten = stabThreat(myTypes, foeTypes) >= 2 ? 1 : 0;
  const vulnerable = stabThreat(foeTypes, myTypes) >= 2 ? 1 : 0;
  return `t${threaten}v${vulnerable}`;
}

// A Protect-like move: fully shields the user for the turn (a common "read" answer to a big hit).
function isProtect(moveId: string): boolean {
  const mv = Dex.moves.get(moveId);
  return !!(mv?.stallingMove || mv?.volatileStatus === "protect" || /protect|detect|spikyshield|kingsshield|banefulbunker|silktrap|burningbulwark|obstruct|maxguard/.test(toID(moveId)));
}

// Classify one committed slot choice ("move 3", "switch 2", "move 1 mega") into an action category,
// using the acting mon's move list to tell attack / status / protect apart.
export function classify(battle: any, side: "p1" | "p2", slot: number, choice: string): ActionCat | null {
  const c = (choice || "").trim();
  if (!c || c === "pass") return null;
  if (c.startsWith("switch")) return "switch";
  const m = /^move\s+(\d+)/.exec(c);
  if (!m) return null;
  const mon = battle?.[side]?.active?.[slot];
  const moveId = mon?.moves?.[parseInt(m[1], 10) - 1];
  if (!moveId) return "attack";
  if (isProtect(moveId)) return "protect";
  const mv = Dex.moves.get(moveId);
  return mv?.category === "Status" ? "status" : "attack";
}

// Fold a whole committed p1 choice string (possibly "a, b" in doubles) into the model, keyed by each
// acting slot's bucket. `weight` lets the caller count this-game observations more heavily.
export function record(model: OpponentModel, battle: any, side: "p1" | "p2", choice: string, weight = 1) {
  const slots = (choice || "").split(",").map((s) => s.trim());
  slots.forEach((slotChoice, slot) => {
    const cat = classify(battle, side, slot, slotChoice);
    if (!cat) return;
    const sig = bucketFor(battle, side, slot);
    if (!sig) return;
    const bucket = (model.actions[sig] ??= {});
    bucket[cat] = (bucket[cat] || 0) + weight;
  });
}

// Merge `b` into `a` (used to overlay the higher-weighted current-game model onto the persisted one).
export function mergeModels(a: OpponentModel, b: OpponentModel): OpponentModel {
  const out: OpponentModel = { games: a.games, actions: {} };
  for (const src of [a, b]) {
    for (const [sig, cats] of Object.entries(src.actions)) {
      const dst = (out.actions[sig] ??= {});
      for (const cat of CATS) if (cats[cat]) dst[cat] = (dst[cat] || 0) + cats[cat]!;
    }
  }
  return out;
}

// Total observations recorded — drives how much the search trusts the model over equilibrium.
export function sampleCount(model: OpponentModel): number {
  let n = 0;
  for (const cats of Object.values(model.actions))
    for (const cat of CATS) n += cats[cat] || 0;
  return n;
}

// How strongly to bias p1's search strategy toward the model (0 = pure equilibrium, capped < 1 so the
// AI never entirely stops respecting game theory). Grows with the number of observations.
export function priorWeight(model: OpponentModel): number {
  const n = sampleCount(model);
  return Math.min(0.7, n / (n + 20));
}

// Prior distribution over one factor's legal tokens for the current matchup bucket: split the bucket's
// category mass across the tokens of that category. Returns uniform when the bucket is unseen.
export function tokenPrior(model: OpponentModel, battle: any, side: "p1" | "p2", slot: number, tokens: string[]): number[] {
  const n = tokens.length;
  if (!n) return [];
  const sig = bucketFor(battle, side, slot);
  const cats = sig ? model.actions[sig] : undefined;
  const uniform = tokens.map(() => 1 / n);
  if (!cats) return uniform;
  const total = CATS.reduce((s, c) => s + (cats[c] || 0), 0);
  if (total <= 0) return uniform;

  // Category of each token, and how many tokens share each category (to divide the mass evenly).
  const tokCat = tokens.map((t) => classify(battle, side, slot, t));
  const perCat: Record<string, number> = {};
  for (const c of tokCat) if (c) perCat[c] = (perCat[c] || 0) + 1;

  const raw = tokens.map((_t, i) => {
    const c = tokCat[i];
    if (!c) return 0;
    const mass = (cats[c] || 0) / total; // observed probability of this category
    return perCat[c] ? mass / perCat[c] : 0;
  });
  let sum = raw.reduce((s, v) => s + v, 0);
  if (sum <= 1e-9) return uniform;
  // Any category with tokens but zero observed mass still deserves a sliver, so nothing is impossible.
  const floor = 0.02 / n;
  const withFloor = raw.map((v) => v + floor);
  sum = withFloor.reduce((s, v) => s + v, 0);
  return withFloor.map((v) => v / sum);
}
