// Reasoning opponents for the Battle tab.
//
// ReasoningAI scores each candidate move by base power × type effectiveness × STAB, picks the
// best (and best target in doubles), and records a plain-English rationale. A `mistakeRate`
// weakens it (Level 1) by sometimes taking a random move. AdaptiveAI (Level 3) extends it with
// cross-game learning persisted in localStorage: it remembers the player's move tendencies and a
// per-game skill ramp, biasing toward KO-ing the player's most-dangerous Pokémon.

import "./node-shim"; // must precede any @pkmn import — defines Node globals for the browser
import { RandomPlayerAI, Dex, toID } from "@pkmn/sim";

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

  override receiveRequest(request: any) {
    this.reasons = [];
    this.slotCursor = 0;
    this.reqActiveLen = request?.active?.length ?? 1;
    this.beforeChoices(request);
    super.receiveRequest(request);
    if (this.reasons.length) this.report(this.turn, [...this.reasons]);
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

  override chooseSwitch(active: any, switches: { slot: number; pokemon: any }[]): number {
    const slot = super.chooseSwitch(active, switches);
    const p = switches.find((s) => s.slot === slot);
    const sp = p ? cleanName(p.pokemon.details) : "";
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

  constructor(playerStream: any, report: (turn: number, reasons: string[]) => void, seed?: any) {
    super(playerStream, report, { mistakeRate: 0, seed });
    this.book = loadBook();
    this.skill = Math.max(0.2, Math.min(1, this.book.games / 8));
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

  protected override foeWeight(foeSpecies: string): number {
    return 1 + this.skill * this.threatOf(foeSpecies);
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
