// A lightweight *reasoning* opponent for the Battle tab.
//
// Extends Showdown's RandomPlayerAI (reusing its team-preview / forced-switch / doubles
// choice-assembly), but overrides move selection: it scores each candidate move by
// base power × type effectiveness × STAB, picks the best move (and best target in doubles),
// and records a plain-English rationale. Those rationales are reported per turn so the UI
// can show "why the Rival AI made the move it made".

import "./node-shim"; // must precede any @pkmn import — defines Node globals for the browser
import { RandomPlayerAI, Dex } from "@pkmn/sim";

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

export class ReasoningAI extends RandomPlayerAI {
  private turn = 0;
  private reqActiveLen = 1;
  private slotCursor = 0;
  private reasons: string[] = [];
  private activeSp: Record<Side, (string | null)[]> = { p1: [null, null], p2: [null, null] };
  private readonly report: (turn: number, reasons: string[]) => void;

  constructor(
    playerStream: any,
    report: (turn: number, reasons: string[]) => void,
    seed?: any
  ) {
    super(playerStream, { move: 1.0, seed: seed ?? null });
    this.report = report;
  }

  override receiveLine(line: string) {
    super.receiveLine(line);
    this.track(line);
  }

  private pos(ident: string): { side: Side | ""; slot: number } {
    const m = /^(p[12])([a-c])/.exec(ident || "");
    if (!m) return { side: "", slot: 0 };
    const slot = m[2] === "b" ? 1 : m[2] === "c" ? 2 : 0;
    return { side: m[1] as Side, slot };
  }

  private track(line: string) {
    if (!line.startsWith("|")) return;
    const parts = line.split("|"); // ["", cmd, ...]
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
    super.receiveRequest(request);
    if (this.reasons.length) this.report(this.turn, [...this.reasons]);
  }

  // Foe (from the AI's perspective) is p1; return alive active mons with their slot index.
  private foes(): { slot: number; species: string; types: string[] }[] {
    const out: { slot: number; species: string; types: string[] }[] = [];
    this.activeSp.p1.forEach((sp, i) => {
      if (!sp) return;
      const s = Dex.species.get(sp);
      out.push({ slot: i, species: sp, types: s.types ?? [] });
    });
    return out;
  }

  private effectiveness(moveType: string, foeTypes: string[]): number {
    // 0 if immune, else 2^(sum of type-chart exponents)
    for (const t of foeTypes) {
      if (!Dex.getImmunity(moveType, t)) return 0;
    }
    let exp = 0;
    for (const t of foeTypes) exp += Dex.getEffectiveness(moveType, t);
    return Math.pow(2, exp);
  }

  override chooseMove(active: any, moves: { choice: string; move: any }[]): string {
    const slot = this.slotCursor++;
    const doubles = this.reqActiveLen > 1;
    const mySpecies = this.activeSp.p2[slot] || "";
    const myTypes = mySpecies ? Dex.species.get(mySpecies).types ?? [] : [];
    const foes = this.foes();

    interface Scored {
      choice: string;
      score: number;
      rationale: string;
    }
    const scored: Scored[] = moves.map(({ choice, move }) => {
      const mv = Dex.moves.get(move.move);
      const name = mv.name || move.move;
      const who = mySpecies || "Rival AI";

      if (mv.category === "Status") {
        const hint = STATUS_HINTS[mv.id];
        return {
          choice,
          score: 25,
          rationale: `${who} used ${name} ${hint ?? "for utility"}.`,
        };
      }

      const stab = myTypes.includes(mv.type) ? 1.5 : 1;
      const bp = mv.basePower || 60; // variable-power moves treated as ~60

      // Best foe target for this move.
      const targeted = ["normal", "any", "adjacentFoe"].includes(move.target);
      let best: { mult: number; foe?: (typeof foes)[number] } = { mult: 1 };
      if (foes.length) {
        best = { mult: -1 };
        for (const f of foes) {
          const mult = this.effectiveness(mv.type, f.types);
          if (mult > best.mult) best = { mult, foe: f };
        }
      }
      const mult = best.mult < 0 ? 1 : best.mult;
      const score = bp * mult * stab;

      // Rewrite the target only for foe-targeting moves in doubles; otherwise keep the
      // parent's ready-made choice string (handles ally/self/spread targeting correctly).
      let finalChoice = choice;
      if (doubles && targeted && best.foe) {
        finalChoice = `move ${move.slot} ${best.foe.slot + 1}${move.zMove ? " zmove" : ""}`;
      }

      const target = best.foe?.species;
      const rationale =
        `${who} used ${name}` +
        (target ? ` on ${target}` : "") +
        ` — ${effWord(mult)}` +
        (stab > 1 && mult > 0 ? ", boosted by STAB" : "") +
        ".";

      return { choice: finalChoice, score, rationale };
    });

    scored.sort((a, b) => b.score - a.score);
    const pick = scored[0];
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
