// Headless self-improving AI-vs-AI runner for the Auto Battle tab.
//
// Runs real Pokémon Showdown battles between two learning bots in the VGC 2026 Reg M-B format,
// back-to-back and as fast as the engine allows ("turbo"). Nothing is rendered per turn — the
// output is a running win/tie/games tally, each side's current "power" (skill), and, per side,
// the top 3 *winning* 4-of-6 Team Preview selections (the four Pokémon that side brought). This
// is deliberately separate from the interactive Battle tab's BattleController (engine.ts).
//
// The bots are an *arms race*: game 1 is fully random, and after every game both sides ramp up in
// power (the loser fast, the winner slowly) — power only ever increases, with no ceiling. Power
// drives the shared reasoning heuristic (ai.ts ReasoningAI): below 1 it mixes in random moves;
// at/above 1 it always takes its best-scored move and keeps sharpening how hard it prioritizes
// KO-ing the opponent's most dangerous Pokémon, learned from that opponent's move tendencies
// across games. Team Preview is randomized (and recorded) so selections vary and can be ranked.

import "./node-shim"; // must precede any @pkmn import — defines Node globals for the browser
import { BattleStreams, Dex, toID } from "@pkmn/sim";
import { ReasoningAI } from "./ai";
import { FORMATS } from "./formats";
import { installChampionsStats } from "./champions-stats";

installChampionsStats(); // Reg M-B (Champions): 1 EV = +1 stat; idempotent.

const TEAM_SIZE = FORMATS.vgcregmb.teamSize; // bring N (4 for Reg M-B)

// Power ramp per game. Loser climbs fast, winner slowly; power only ever increases and has no
// ceiling — past 1.0 the bot already plays the heuristic's best move every turn (mistakeRate
// floors at 0), and the extra power keeps sharpening how hard it prioritizes KO-ing the
// opponent's most dangerous Pokémon as its learned model grows.
const LOSE_STEP = 0.15;
const WIN_STEP = 0.04;

export interface ComboStat {
  combo: string; // the 4 brought Pokémon, sorted + joined: "A + B + C + D" (order-independent)
  games: number; // games this selection was brought
  wins: number; // games this selection won
}

export interface Tally {
  blue: number; // p1 wins
  red: number; // p2 wins
  ties: number;
  games: number;
  powerBlue: number; // 0..∞, current skill/strength
  powerRed: number;
  topBlue: ComboStat[]; // Blue's top winning 4-of-6 selections (by win rate)
  topRed: ComboStat[]; // Red's top winning 4-of-6 selections
}

export type GameResult = "blue" | "red" | "tie";

// speciesId -> moveId -> times that species was seen using that move (opponent tendencies).
type Book = Record<string, Record<string, number>>;

interface GameOutcome {
  result: GameResult;
  blueCombo: string | null; // sorted "A + B + C + D" of the four Blue brought, if captured
  redCombo: string | null;
  obsBlue: Book; // what Blue observed of Red this game (Red's moves)
  obsRed: Book; // what Red observed of Blue this game (Blue's moves)
}

const P1_NAME = "Blue";
const P2_NAME = "Red";

// "Pikachu, L50, M" -> "Pikachu"
function cleanName(details: string): string {
  return (details || "").split(",")[0].trim();
}

// A reasoning bot whose strength is set by `power` (0 = fully random, 1 = full heuristic, and up
// with no cap). It records the opponent's move tendencies into `obs`, biases toward KO-ing the
// opponent's most dangerous Pokémon using the accumulated `book`, and brings a RANDOM Team
// Preview selection (recording which four, so selections can be ranked by win rate).
class LearningBot extends ReasoningAI {
  selectedCombo: string | null = null;
  private readonly power: number;
  private readonly book: Book;
  private readonly obs: Book;

  constructor(stream: any, side: "p1" | "p2", power: number, book: Book, obs: Book) {
    // mistakeRate floors at 0 once power reaches 1 (always takes the best move); power beyond
    // that keeps growing foeWeight below rather than affecting move-vs-random choice.
    super(stream, () => {}, { mistakeRate: Math.max(0, 1 - power), side });
    this.power = power;
    this.book = book;
    this.obs = obs;
  }

  protected override chooseTeamPreview(team: any[]): string {
    const n = team.length;
    const idx = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = n - 1; i > 0; i--) {
      const j = this.prng.random(i + 1);
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const pick = idx.slice(0, Math.min(TEAM_SIZE, n));
    // `team` is the request's side.pokemon; each entry carries a `details` string.
    this.selectedCombo = pick
      .map((i) => cleanName((team[i - 1] && (team[i - 1].details || team[i - 1].ident)) || ""))
      .filter(Boolean)
      .sort()
      .join(" + ");
    return "team " + pick.join("");
  }

  // Record every move the OPPONENT makes, keyed by their active species, into this game's obs.
  protected override track(line: string) {
    super.track(line);
    if (!line.startsWith("|move|")) return;
    const parts = line.split("|"); // ["", "move", "p2a: Foe", "Move Name", ...]
    const pos = parts[2] ?? "";
    if (pos.slice(0, 2) !== this.foeSide) return;
    const slot = pos.charAt(2) === "b" ? 1 : 0;
    const sp = this.activeSp[this.foeSide][slot];
    const mv = toID(parts[3] ?? "");
    if (!sp || !mv) return;
    const bucket = (this.obs[toID(sp)] ??= {});
    bucket[mv] = (bucket[mv] || 0) + 1;
  }

  // The strongest base power the book has ever seen this species use, scaled to 0..1.
  private knownThreat(species: string): number {
    const moves = this.book[toID(species)];
    if (!moves) return 0;
    let bestMv = "";
    let best = 0;
    for (const [mv, c] of Object.entries(moves)) if (c > best) ((best = c), (bestMv = mv));
    const bp = bestMv ? Dex.moves.get(bestMv).basePower || 0 : 0;
    return Math.min(1, bp / 120);
  }

  // Scale up the importance of hitting a foe by how dangerous we've learned it is (× power).
  protected override foeWeight(species: string): number {
    return 1 + this.power * this.knownThreat(species);
  }
}

function mergeBook(dst: Book, src: Book) {
  for (const [sp, moves] of Object.entries(src)) {
    const d = (dst[sp] ??= {});
    for (const [mv, n] of Object.entries(moves)) d[mv] = (d[mv] || 0) + n;
  }
}

// All selections ranked by win rate (tiebreak: more wins — i.e. larger sample — then name). The
// UI shows the top 3; the full list is kept so a Stop → Start resume doesn't lose the rest.
function sortByWinRate(map: Map<string, { games: number; wins: number }>): ComboStat[] {
  const rate = (c: { games: number; wins: number }) => (c.games ? c.wins / c.games : 0);
  return Array.from(map.entries())
    .map(([combo, { games, wins }]) => ({ combo, games, wins }))
    .sort((x, y) => rate(y) - rate(x) || y.wins - x.wins || x.combo.localeCompare(y.combo));
}

interface ControllerOpts {
  onUpdate: (tally: Tally) => void;
  p1Team: string; // packed team Blue plays (from the Reg M-B registry)
  p2Team: string; // packed team Red plays
}

export class AutoBattleController {
  private readonly onUpdate: (tally: Tally) => void;
  private readonly p1Team: string;
  private readonly p2Team: string;
  private readonly formatid = FORMATS.vgcregmb.engineFormat;
  private stopped = true;
  private destroyed = false;
  private looping = false;

  private counts = { blue: 0, red: 0, ties: 0, games: 0 };
  private powerBlue = 0;
  private powerRed = 0;
  private readonly bookBlue: Book = {}; // Blue's learned model of Red
  private readonly bookRed: Book = {}; // Red's learned model of Blue
  // Per side: selection combo -> { games brought, games won }.
  private readonly comboBlue = new Map<string, { games: number; wins: number }>();
  private readonly comboRed = new Map<string, { games: number; wins: number }>();
  private lastEmit = 0;

  // The stream of the game currently in flight, so stop()/destroy() can tear it down and let
  // the in-flight `for await` resolve.
  private activeStreams: ReturnType<typeof BattleStreams.getPlayerStreams> | null = null;

  constructor(opts: ControllerOpts) {
    this.onUpdate = opts.onUpdate;
    this.p1Team = opts.p1Team;
    this.p2Team = opts.p2Team;
  }

  /** Begin (or resume) the loop. Power and learning carry over from where they left off. */
  start() {
    if (this.destroyed || this.looping) return;
    this.stopped = false;
    this.looping = true;
    void this.runLoop();
  }

  /** Pause the loop; the in-flight game is abandoned. Power/learning are kept for resume. */
  stop() {
    this.stopped = true;
    this.endActive();
    this.emit(true);
  }

  /** Clear the tally, power, and learning back to a fresh arms race (only meaningful stopped). */
  reset() {
    this.counts = { blue: 0, red: 0, ties: 0, games: 0 };
    this.powerBlue = 0;
    this.powerRed = 0;
    for (const k of Object.keys(this.bookBlue)) delete this.bookBlue[k];
    for (const k of Object.keys(this.bookRed)) delete this.bookRed[k];
    this.comboBlue.clear();
    this.comboRed.clear();
    this.emit(true);
  }

  /** Halt permanently and stop emitting (e.g. on React unmount). */
  destroy() {
    this.destroyed = true;
    this.stopped = true;
    this.endActive();
  }

  getTally(): Tally {
    return this.snapshot();
  }

  private endActive() {
    const s = this.activeStreams;
    this.activeStreams = null;
    if (!s) return;
    try {
      void s.omniscient.writeEnd();
    } catch {
      /* already torn down */
    }
  }

  private bump(power: number, step: number): number {
    return power + step; // no ceiling — power only ever grows
  }

  private async runLoop() {
    try {
      while (!this.stopped && !this.destroyed) {
        const o = await this.runGame();
        if (this.stopped || this.destroyed) break;

        // Result + tally.
        if (o.result === "blue") this.counts.blue++;
        else if (o.result === "red") this.counts.red++;
        else this.counts.ties++;
        this.counts.games++;

        // Each side's selection played one game; the winning side's selection also won it.
        this.recordCombo(this.comboBlue, o.blueCombo, o.result === "blue");
        this.recordCombo(this.comboRed, o.redCombo, o.result === "red");

        // Learn: fold this game's observations into each side's persistent model.
        mergeBook(this.bookBlue, o.obsBlue);
        mergeBook(this.bookRed, o.obsRed);

        // Ramp power — loser fast, winner slow, ties nudge both; never decreases, no cap.
        if (o.result === "blue") {
          this.powerBlue = this.bump(this.powerBlue, WIN_STEP);
          this.powerRed = this.bump(this.powerRed, LOSE_STEP);
        } else if (o.result === "red") {
          this.powerRed = this.bump(this.powerRed, WIN_STEP);
          this.powerBlue = this.bump(this.powerBlue, LOSE_STEP);
        } else {
          this.powerBlue = this.bump(this.powerBlue, WIN_STEP);
          this.powerRed = this.bump(this.powerRed, WIN_STEP);
        }

        this.emit(false);
        // Yield so the UI stays responsive even when many games run per second.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.looping = false;
      this.endActive();
      this.emit(true);
    }
  }

  private recordCombo(
    map: Map<string, { games: number; wins: number }>,
    combo: string | null,
    won: boolean
  ) {
    if (!combo) return;
    const cur = map.get(combo) ?? { games: 0, wins: 0 };
    cur.games++;
    if (won) cur.wins++;
    map.set(combo, cur);
  }

  /** Play one full game to completion (or until stopped). Resolves with winner, selections, learning. */
  private async runGame(): Promise<GameOutcome> {
    const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
    this.activeStreams = streams;

    // What each side observes of the other this game (merged into the books afterwards).
    const obsBlue: Book = {};
    const obsRed: Book = {};

    // Bots built at the current power level; a fresh PRNG each game keeps play varied.
    const ai1 = new LearningBot(streams.p1, "p1", this.powerBlue, this.bookBlue, obsBlue);
    const ai2 = new LearningBot(streams.p2, "p2", this.powerRed, this.bookRed, obsRed);
    void ai1.start();
    void ai2.start();

    void streams.omniscient.write(
      `>start ${JSON.stringify({ formatid: this.formatid })}\n` +
        `>player p1 ${JSON.stringify({ name: P1_NAME, team: this.p1Team })}\n` +
        `>player p2 ${JSON.stringify({ name: P2_NAME, team: this.p2Team })}`
    );

    let result: GameResult = "tie";
    try {
      for await (const chunk of streams.omniscient) {
        if (this.stopped || this.destroyed) break;
        let done = false;
        for (const line of chunk.split("\n")) {
          if (line.startsWith("|win|")) {
            const winner = line.slice("|win|".length).trim();
            result = winner === P1_NAME ? "blue" : winner === P2_NAME ? "red" : "tie";
            done = true;
            break;
          }
          if (line === "|tie" || line.startsWith("|tie|")) {
            result = "tie";
            done = true;
            break;
          }
        }
        if (done) break;
      }
    } catch {
      // stream torn down on stop/destroy — treat as no result (loop will exit on the flag)
    } finally {
      if (this.activeStreams === streams) this.activeStreams = null;
      try {
        void streams.omniscient.writeEnd();
      } catch {
        /* noop */
      }
    }
    return { result, blueCombo: ai1.selectedCombo, redCombo: ai2.selectedCombo, obsBlue, obsRed };
  }

  private snapshot(): Tally {
    return {
      ...this.counts,
      powerBlue: this.powerBlue,
      powerRed: this.powerRed,
      topBlue: sortByWinRate(this.comboBlue),
      topRed: sortByWinRate(this.comboRed),
    };
  }

  // Throttle UI updates to ~4x/sec so a turbo loop doesn't flood React with renders. `force`
  // (stop/reset/final) always emits.
  private emit(force: boolean) {
    if (this.destroyed) return; // never emit after unmount
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.onUpdate(this.snapshot());
  }
}
