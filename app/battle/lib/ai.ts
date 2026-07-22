// Reasoning opponents for the Battle tab.
//
// ReasoningAI scores each candidate move by base power × type effectiveness × STAB, picks the
// best (and best target in doubles), and records a plain-English rationale. A `mistakeRate`
// weakens it (Level 1) by sometimes taking a random move. AdaptiveAI (Level 3) extends it with
// cross-game learning persisted in localStorage: it remembers the player's move tendencies and a
// per-game skill ramp, biasing toward KO-ing the player's most-dangerous Pokémon.

import "./node-shim"; // must precede any @pkmn import — defines Node globals for the browser
import { RandomPlayerAI, Dex, toID } from "@pkmn/sim";
import { matchupValue, type Matchup } from "./matchup";

type Side = "p1" | "p2";

const STATUS_HINTS: Record<string, string> = {
  protect: "to shield itself this turn",
  detect: "to shield itself this turn",
  spikyshield: "to shield itself and chip contact attackers",
  fakeout: "for a free flinch",
  spore: "to put your Pokémon to sleep",
  sleeppowder: "to put your Pokémon to sleep",
  hypnosis: "to put your Pokémon to sleep",
  willowisp: "to burn and weaken your attacker",
  thunderwave: "to paralyze and slow your Pokémon",
  tailwind: "to double its team's Speed",
  trickroom: "to invert the Speed order in its favor",
  ragepowder: "to redirect attacks onto itself",
  followme: "to redirect attacks onto itself",
  helpinghand: "to boost its partner's damage",
  swordsdance: "to sharply raise its Attack",
  nastyplot: "to sharply raise its Sp. Atk",
  dragondance: "to raise its Attack and Speed",
  calmmind: "to raise its Sp. Atk and Sp. Def",
  reflect: "to halve incoming physical damage",
  lightscreen: "to halve incoming special damage",
  substitute: "to set up a Substitute",
  recover: "to restore its HP",
  roost: "to restore its HP",
};

function cleanName(details: string): string {
  return (details || "").split(",")[0].trim();
}

// Inclusive integer range [start, end] (mirrors the RandomPlayerAI helper).
function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

function effWord(mult: number): string {
  if (mult === 0) return "no effect";
  if (mult >= 4) return `${mult}× super effective`;
  if (mult > 1) return `super effective (${mult}×)`;
  if (mult === 1) return "neutral damage";
  return `not very effective (${mult}×)`;
}

interface MoveCtx {
  mySpecies: string;
  myTypes: string[];
  foes: { slot: number; species: string; types: string[] }[];
  doubles: boolean;
}

interface Scored {
  choice: string;
  score: number;
  rationale: string;
}

export class ReasoningAI extends RandomPlayerAI {
  protected turn = 0;
  protected reqActiveLen = 1;
  protected slotCursor = 0;
  protected reasons: string[] = [];
  protected activeSp: Record<Side, (string | null)[]> = { p1: [null, null], p2: [null, null] };
  protected actingSpecies = ""; // the mon whose move is currently being scored (for foeWeight)
  protected readonly mistakeRate: number;
  // Which side this AI plays. Defaults to p2 (the Battle tab's Rival AI); the Auto Battle
  // self-play runner sets it per side so "my" species and "foes" resolve correctly.
  protected readonly side: Side;
  private readonly report: (turn: number, reasons: string[]) => void;

  constructor(
    playerStream: any,
    report: (turn: number, reasons: string[]) => void,
    opts: { mistakeRate?: number; seed?: any; side?: Side } = {}
  ) {
    // mega: 1 => Mega Evolve whenever a held Mega Stone allows it (base RandomPlayerAI appends
    // " mega" to our chosen move in receiveRequest). Gen 9 has no dynamax/ultra, so this only
    // ever means "Mega Evolve when able".
    super(playerStream, { move: 1.0, mega: 1, seed: opts.seed ?? null });
    this.report = report;
    this.mistakeRate = opts.mistakeRate ?? 0;
    this.side = opts.side ?? "p2";
  }

  protected get foeSide(): Side {
    return this.side === "p1" ? "p2" : "p1";
  }

  override receiveLine(line: string) {
    super.receiveLine(line);
    this.track(line);
  }

  protected pos(ident: string): { side: Side | ""; slot: number } {
    const m = /^(p[12])([a-c])/.exec(ident || "");
    if (!m) return { side: "", slot: 0 };
    const slot = m[2] === "b" ? 1 : m[2] === "c" ? 2 : 0;
    return { side: m[1] as Side, slot };
  }

  protected track(line: string) {
    if (!line.startsWith("|")) return;
    const parts = line.split("|");
    const cmd = parts[1];
    if (cmd === "turn") {
      this.turn = parseInt(parts[2], 10) || this.turn;
    } else if (cmd === "switch" || cmd === "drag" || cmd === "replace") {
      const { side, slot } = this.pos(parts[2]);
      if (side) this.activeSp[side][slot] = cleanName(parts[3] || "");
    } else if (cmd === "faint") {
      const { side, slot } = this.pos(parts[2]);
      if (side) this.activeSp[side][slot] = null;
    }
  }

  // Fully handle the request (instead of the random base): switch out of losing matchups, pick
  // the best replacement after a faint, take the best-scored move, and Mega Evolve when able.
  override receiveRequest(request: any) {
    this.reasons = [];
    this.slotCursor = 0;
    this.reqActiveLen = request?.active?.length ?? 1;
    this.beforeChoices(request);

    if (request?.wait) {
      // nothing to choose
    } else if (request?.forceSwitch) {
      this.chooseForceSwitch(request);
    } else if (request?.teamPreview) {
      this.choose(this.chooseTeamPreview(request.side.pokemon));
    } else if (request?.active) {
      this.chooseActions(request);
    }

    if (this.reasons.length) this.report(this.turn, [...this.reasons]);
  }

  // Replacement after a faint (or any forced switch): send out the best matchup, not a random mon.
  private chooseForceSwitch(request: any) {
    const pokemon = request.side.pokemon;
    const chosen: number[] = [];
    const choices = (request.forceSwitch as any[]).map((mustSwitch, i) => {
      if (!mustSwitch) return "pass";
      const canSwitch = range(1, 6).filter(
        (j) =>
          pokemon[j - 1] &&
          (j > request.forceSwitch.length || pokemon[i].reviving) &&
          !chosen.includes(j) &&
          !pokemon[j - 1].condition.endsWith(" fnt") === !pokemon[i].reviving
      );
      if (!canSwitch.length) return "pass";
      const target = this.chooseSwitch(
        undefined,
        canSwitch.map((slot) => ({ slot, pokemon: pokemon[slot - 1] }))
      );
      chosen.push(target);
      return `switch ${target}`;
    });
    this.choose(choices.join(", "));
  }

  // Per active slot: pivot out of a clearly-losing matchup, else take the best move — Mega
  // Evolving when able (only one Pokémon may Mega Evolve per turn).
  private chooseActions(request: any) {
    const pokemon = request.side.pokemon;
    const doubles = request.active.length > 1;
    const chosen: number[] = [];
    let megaUsed = false;

    const choices = (request.active as any[]).map((active, i) => {
      if (pokemon[i].condition.endsWith(" fnt") || pokemon[i].commanding) return "pass";

      const list = active.moves ?? [];
      const hasAlly = pokemon.length > 1 && !(pokemon[i ^ 1]?.condition ?? "").endsWith(" fnt");
      let usable = range(1, list.length)
        .filter((j) => !list[j - 1].disabled)
        .map((j) => ({ slot: j, move: list[j - 1].move, target: list[j - 1].target, zMove: false }));
      const withAlly = usable.filter((m) => m.target !== "adjacentAlly" || hasAlly);
      usable = withAlly.length ? withAlly : usable;

      // Build the base choice string with a valid default target (scoreMove overrides the target
      // for foe-targeted attacks; ally/self targets are kept as-is).
      const moves = usable.map((m) => {
        let mv = `move ${m.slot}`;
        if (doubles) {
          if (["normal", "any", "adjacentFoe"].includes(m.target)) mv += ` ${1 + this.prng.random(2)}`;
          else if (m.target === "adjacentAlly") mv += ` -${(i ^ 1) + 1}`;
          else if (m.target === "adjacentAllyOrSelf") mv += hasAlly ? ` -${1 + this.prng.random(2)}` : ` -${i + 1}`;
        }
        return { choice: mv, move: m };
      });

      const canSwitch = range(1, 6).filter(
        (j) =>
          pokemon[j - 1] &&
          !pokemon[j - 1].active &&
          !chosen.includes(j) &&
          !pokemon[j - 1].condition.endsWith(" fnt")
      );
      const switches = active.trapped ? [] : canSwitch;

      // Voluntary pivot — only when switching is clearly the best play.
      const pivot = this.shouldSwitch(i, moves, switches, pokemon);
      if (pivot != null) {
        chosen.push(pivot);
        const sp = cleanName(pokemon[pivot - 1]?.details || "");
        if (sp) this.reasons.push(`Rival AI pivots to ${sp}.`);
        return `switch ${pivot}`;
      }

      if (!moves.length) {
        if (switches.length) {
          const t = this.chooseSwitch(
            active,
            switches.map((slot) => ({ slot, pokemon: pokemon[slot - 1] }))
          );
          chosen.push(t);
          return `switch ${t}`;
        }
        return "pass";
      }

      const r = this.moveChoiceForSlot(active, moves, i);
      this.reasons.push(r.rationale);
      let choice = r.choice;
      if (active.canMegaEvo && !megaUsed) {
        choice += " mega";
        megaUsed = true;
      }
      return choice;
    });

    this.choose(choices.join(", "));
  }

  private moveChoiceForSlot(
    active: any,
    moves: { choice: string; move: any }[],
    slot: number
  ): { choice: string; rationale: string } {
    const doubles = this.reqActiveLen > 1;
    const mySpecies = this.activeSp[this.side][slot] || "";
    this.actingSpecies = mySpecies; // scoreMove → foeWeight reads this to consult the matchup chart
    const myTypes = mySpecies ? Dex.species.get(mySpecies).types ?? [] : [];
    const ctx: MoveCtx = { mySpecies, myTypes, foes: this.foes(), doubles };
    const scored = moves.map(({ choice, move }) => this.scoreMove(choice, move, ctx));
    const best = scored.slice().sort((a, b) => b.score - a.score)[0];
    const mistake = this.mistakeRate > 0 && this.prng.random() < this.mistakeRate;
    const pick = (mistake ? scored[this.prng.random(scored.length)] : best) ?? best;
    return { choice: pick.choice, rationale: pick.rationale };
  }

  // Net type matchup of a Pokémon (by its types) vs the current foes: how hard it hits them minus
  // how hard they hit it, using best super-effective coverage on each side.
  protected matchup(
    _mySpecies: string,
    myTypes: string[],
    foes: { species: string; types: string[] }[]
  ): number {
    let s = 0;
    for (const f of foes) {
      const off = myTypes.reduce((mx, t) => Math.max(mx, this.effectiveness(t, f.types)), 0);
      const def = f.types.reduce((mx, t) => Math.max(mx, this.effectiveness(t, myTypes)), 0);
      s += off - def;
    }
    return s;
  }

  // Best super-effective potential of an attacker's STAB types vs a defender (× STAB).
  protected typeThreat(atkTypes: string[], defTypes: string[]): number {
    return atkTypes.reduce((mx, t) => Math.max(mx, this.effectiveness(t, defTypes)), 0) * 1.5;
  }

  // Best super-effective multiplier the active mon can actually deal this turn from its moves.
  protected bestOffense(
    moves: { choice: string; move: any }[],
    myTypes: string[],
    foes: { types: string[] }[]
  ): number {
    let best = 0;
    for (const { move } of moves) {
      const mv = Dex.moves.get(move.move);
      if (mv.category === "Status") continue;
      const stab = myTypes.includes(mv.type) ? 1.5 : 1;
      for (const f of foes) best = Math.max(best, this.effectiveness(mv.type, f.types) * stab);
    }
    return best;
  }

  // A pivot is the best play only when the active mon (slot i) is threatened by a super-effective
  // hit, can't hit back hard this turn (walled), AND a benched mon hard-answers the threat —
  // resisting it and threatening it back. Otherwise it stays in and attacks.
  protected shouldSwitch(
    i: number,
    moves: { choice: string; move: any }[],
    switches: number[],
    pokemon: any[]
  ): number | null {
    if (!switches.length) return null;
    if (this.mistakeRate > 0 && this.prng.random() < this.mistakeRate) return null;
    const foes = this.foes();
    if (!foes.length) return null;
    const myName = this.activeSp[this.side][i] || cleanName(pokemon[i]?.details || "");
    const myTypes = myName ? Dex.species.get(myName).types ?? [] : [];

    // In danger? (a foe threatens a super-effective STAB hit)
    const worst = foes
      .map((f) => ({ f, t: this.typeThreat(f.types, myTypes) }))
      .sort((a, b) => b.t - a.t)[0];
    if (!worst || worst.t < 2) return null; // safe → attacking is fine
    // Can I hit back super-effectively this turn? Then stay and pressure.
    if (this.bestOffense(moves, myTypes, foes) >= 2) return null;

    // Walled + threatened: bring the best hard answer to the biggest threat, if we have one.
    const threat = worst.f;
    let bestSlot = -1;
    let bestVal = 0;
    for (const s of switches) {
      const nm = cleanName(pokemon[s - 1]?.details || "");
      const tt = nm ? Dex.species.get(nm).types ?? [] : [];
      const incoming = this.typeThreat(threat.types, tt); // how hard the threat hits the switch-in
      const pressure = tt.reduce((mx, t) => Math.max(mx, this.effectiveness(t, threat.types)), 0);
      if (incoming <= 1 && pressure >= 2 && pressure - incoming > bestVal) {
        bestVal = pressure - incoming;
        bestSlot = s;
      }
    }
    return bestSlot > 0 ? bestSlot : null;
  }

  /** Hook for subclasses to push a leading note before per-slot choices are made. */
  protected beforeChoices(_request: any) {}

  protected foes(): { slot: number; species: string; types: string[] }[] {
    const out: { slot: number; species: string; types: string[] }[] = [];
    this.activeSp[this.foeSide].forEach((sp, i) => {
      if (!sp) return;
      const s = Dex.species.get(sp);
      out.push({ slot: i, species: sp, types: s.types ?? [] });
    });
    return out;
  }

  protected effectiveness(moveType: string, foeTypes: string[]): number {
    for (const t of foeTypes) {
      if (!Dex.getImmunity(moveType, t)) return 0;
    }
    let exp = 0;
    for (const t of foeTypes) exp += Dex.getEffectiveness(moveType, t);
    return Math.pow(2, exp);
  }

  /** Relative importance of hitting a given foe. Base: all foes equal. */
  protected foeWeight(_foeSpecies: string): number {
    return 1;
  }

  protected scoreMove(choice: string, move: any, ctx: MoveCtx): Scored {
    const mv = Dex.moves.get(move.move);
    const name = mv.name || move.move;
    const who = ctx.mySpecies || "Rival AI";

    if (mv.category === "Status") {
      const hint = STATUS_HINTS[mv.id];
      return { choice, score: 25, rationale: `${who} used ${name} ${hint ?? "for utility"}.` };
    }

    const stab = ctx.myTypes.includes(mv.type) ? 1.5 : 1;
    const bp = mv.basePower || 60;
    const targeted = ["normal", "any", "adjacentFoe"].includes(move.target);

    let bestMult = 1;
    let bestFoe: MoveCtx["foes"][number] | undefined;
    let bestScore = bp * 1 * stab;
    if (ctx.foes.length) {
      bestScore = -1;
      for (const f of ctx.foes) {
        const mult = this.effectiveness(mv.type, f.types);
        const w = bp * mult * stab * this.foeWeight(f.species);
        if (w > bestScore) {
          bestScore = w;
          bestMult = mult;
          bestFoe = f;
        }
      }
    }

    let finalChoice = choice;
    if (ctx.doubles && targeted && bestFoe) {
      finalChoice = `move ${move.slot} ${bestFoe.slot + 1}${move.zMove ? " zmove" : ""}`;
    }

    const target = bestFoe?.species;
    const rationale =
      `${who} used ${name}` +
      (target ? ` on ${target}` : "") +
      ` — ${effWord(bestMult)}` +
      (stab > 1 && bestMult > 0 ? ", boosted by STAB" : "") +
      ".";

    return { choice: finalChoice, score: bestScore, rationale };
  }

  override chooseMove(active: any, moves: { choice: string; move: any }[]): string {
    const slot = this.slotCursor++;
    const doubles = this.reqActiveLen > 1;
    const mySpecies = this.activeSp[this.side][slot] || "";
    const myTypes = mySpecies ? Dex.species.get(mySpecies).types ?? [] : [];
    const ctx: MoveCtx = { mySpecies, myTypes, foes: this.foes(), doubles };

    const scored = moves.map(({ choice, move }) => this.scoreMove(choice, move, ctx));
    const best = scored.slice().sort((a, b) => b.score - a.score)[0];
    const mistake = this.mistakeRate > 0 && this.prng.random() < this.mistakeRate;
    const pick = (mistake ? scored[this.prng.random(scored.length)] : best) ?? best;

    this.reasons.push(pick.rationale);
    return pick.choice;
  }

  // Pick the switch-in with the best type matchup vs the current foes (random when weakened).
  override chooseSwitch(active: any, switches: { slot: number; pokemon: any }[]): number {
    const foes = this.foes();
    const skilled = this.mistakeRate === 0 || this.prng.random() >= this.mistakeRate;
    let slot: number;
    if (foes.length && skilled) {
      let bestSlot = switches[0]?.slot ?? 0;
      let bestScore = -Infinity;
      for (const s of switches) {
        const nm = cleanName(s.pokemon?.details || "");
        const tt = nm ? Dex.species.get(nm).types ?? [] : [];
        const sc = this.matchup(nm, tt, foes);
        if (sc > bestScore) ((bestScore = sc), (bestSlot = s.slot));
      }
      slot = bestSlot;
    } else {
      slot = super.chooseSwitch(active, switches);
    }
    const sp = cleanName(switches.find((s) => s.slot === slot)?.pokemon?.details || "");
    if (sp) this.reasons.push(`Rival AI sent out ${sp}.`);
    return slot;
  }
}

// ------------------------------------------------------------------ Adaptive (Level 3) --------

interface Book {
  games: number;
  moves: Record<string, Record<string, number>>; // speciesId -> moveId -> count
}

const BOOK_KEY = "aether-ai-book";

function loadBook(): Book {
  try {
    const raw = localStorage.getItem(BOOK_KEY);
    if (raw) {
      const b = JSON.parse(raw);
      return { games: b.games || 0, moves: b.moves || {} };
    }
  } catch {
    /* localStorage unavailable */
  }
  return { games: 0, moves: {} };
}

function saveBook(b: Book) {
  try {
    localStorage.setItem(BOOK_KEY, JSON.stringify(b));
  } catch {
    /* ignore */
  }
}

/**
 * Level 3: full-strength heuristic that improves every game.
 * - Skill ramps with the number of games played (persisted).
 * - Learns the player's move tendencies per species across games and biases toward KO-ing the
 *   player's most-dangerous Pokémon.
 */
export class AdaptiveAI extends ReasoningAI {
  private book: Book;
  private skill: number;
  private gameMoves: Record<string, Record<string, number>> = {};
  private saved = false;
  private noted = false;
  // Optional pre-battle matchup chart the player set (AI mon vs your mon, from the AI's view).
  private readonly chart?: Matchup;

  constructor(
    playerStream: any,
    report: (turn: number, reasons: string[]) => void,
    opts: { matchup?: Matchup; seed?: any } = {}
  ) {
    super(playerStream, report, { mistakeRate: 0, seed: opts.seed });
    this.chart = opts.matchup;
    this.book = loadBook();
    this.skill = Math.max(0.2, Math.min(1, this.book.games / 8));
  }

  // Net chart rating of an AI mon vs the current foes (0 when no chart / all-neutral).
  private chartSum(aiSpecies: string, foes: { species: string }[]): number {
    if (!this.chart) return 0;
    return foes.reduce((a, f) => a + matchupValue(this.chart, aiSpecies, f.species), 0);
  }

  protected override track(line: string) {
    super.track(line);
    if (!line.startsWith("|")) return;
    const parts = line.split("|");
    const cmd = parts[1];
    if (cmd === "move") {
      const { side, slot } = this.pos(parts[2]);
      if (side === this.foeSide) {
        const sp = this.activeSp[this.foeSide][slot] || "";
        const mv = toID(parts[3] || "");
        if (sp && mv) {
          const id = toID(sp);
          const bucket = (this.gameMoves[id] ??= {});
          bucket[mv] = (bucket[mv] || 0) + 1;
        }
      }
    } else if (cmd === "win" || cmd === "tie") {
      this.persist();
    }
  }

  private persist() {
    if (this.saved) return;
    this.saved = true;
    for (const [sp, mvs] of Object.entries(this.gameMoves)) {
      const dst = (this.book.moves[sp] ??= {});
      for (const [mv, n] of Object.entries(mvs)) dst[mv] = (dst[mv] || 0) + n;
    }
    this.book.games += 1;
    saveBook(this.book);
  }

  private bestKnownMove(foeSpecies: string): { id: string; bp: number } | null {
    const book = this.book.moves[toID(foeSpecies)];
    if (!book) return null;
    let id = "";
    let n = 0;
    for (const [mv, c] of Object.entries(book)) if (c > n) ((n = c), (id = mv));
    if (!id) return null;
    return { id, bp: Dex.moves.get(id).basePower || 0 };
  }

  private threatOf(foeSpecies: string): number {
    const best = this.bestKnownMove(foeSpecies);
    return best ? Math.min(1, best.bp / 120) : 0;
  }

  // Target priority: keep the learned threat weight, then bias toward foes the acting AI mon is
  // rated favorable against (+1 → ×1.5, −1 → ×0.6), so it presses its good matchups.
  protected override foeWeight(foeSpecies: string): number {
    const base = 1 + this.skill * this.threatOf(foeSpecies);
    const m = matchupValue(this.chart, this.actingSpecies, foeSpecies);
    return base * (m > 0 ? 1.5 : m < 0 ? 0.6 : 1);
  }

  // Switch-in / voluntary-pivot target: blend the player's chart into the type-matchup score so a
  // favorable-rated mon is preferred (weight 3 lets a clear +1/−1 override close type calls).
  protected override matchup(
    mySpecies: string,
    myTypes: string[],
    foes: { species: string; types: string[] }[]
  ): number {
    return super.matchup(mySpecies, myTypes, foes) + 3 * this.chartSum(mySpecies, foes);
  }

  // Proactive retreat: if the chart says the active mon is losing (net < 0) and a benched mon is
  // rated strictly better (and at least even), pivot to it. Otherwise defer to the type-based logic.
  protected override shouldSwitch(
    i: number,
    moves: { choice: string; move: any }[],
    switches: number[],
    pokemon: any[]
  ): number | null {
    if (this.chart && switches.length) {
      const foes = this.foes();
      if (foes.length) {
        const myName = this.activeSp[this.side][i] || cleanName(pokemon[i]?.details || "");
        const mySum = this.chartSum(myName, foes);
        if (mySum < 0) {
          let bestSlot = -1;
          let bestSum = mySum;
          for (const s of switches) {
            const sum = this.chartSum(cleanName(pokemon[s - 1]?.details || ""), foes);
            if (sum > bestSum) ((bestSum = sum), (bestSlot = s));
          }
          if (bestSlot > 0 && bestSum >= 0) return bestSlot;
        }
      }
    }
    return super.shouldSwitch(i, moves, switches, pokemon);
  }

  protected override beforeChoices(request: any) {
    if (this.noted || !request?.active || this.skill < 0.35) return;
    let top: { species: string } | null = null;
    let topThreat = 0;
    for (const f of this.foes()) {
      const t = this.threatOf(f.species);
      if (t > topThreat) ((topThreat = t), (top = f));
    }
    if (top && topThreat > 0) {
      const best = this.bestKnownMove(top.species);
      const mvName = best ? Dex.moves.get(best.id).name || best.id : "its best move";
      this.reasons.push(
        `Learned from past games: your ${top.species} likes ${mvName} — prioritizing it.`
      );
      this.noted = true;
    }
  }
}
