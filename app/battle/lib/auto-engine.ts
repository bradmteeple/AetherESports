// Auto Battle controller.
//
// Two AIs play VGC 2026 Reg M-B, back to back. Each decision is made by a Monte Carlo search that
// looks ahead over a forked copy of the real Showdown simulator (see mcts.ts): it treats the
// simultaneous move choice as a small game and plays a MIXED strategy, averages over the RNG, and
// weighs "Mega Evolve now vs later" as ordinary actions — nothing about Mega timing is hand-coded.
//
// The search is heavy and deliberately runs slowly for accuracy, so the game loop lives in a Web
// Worker (mcts-worker.ts). This controller is the main-thread client: it forwards start/stop/reset,
// and folds each finished game the worker sends back into the running tally, the win-rate selection
// columns, the learned opponent-threat model (for the game plan), and the replay window. Those
// aggregates stay here so getReplay()/bluePlan() remain synchronous for the page.

import { FORMATS } from "./formats";
import { analyzeBluePlan } from "./game-plan-analyze";
import type { PlanData } from "./game-plan";
import type { WorkerGame, WorkerMsg } from "./mcts-worker";

type Book = Record<string, Record<string, number>>;

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
  searching: boolean; // is the searcher currently thinking?
  turn: number; // current game's turn (progress indicator)
  sims: number; // search iterations spent on the last decision
  topBlue: ComboStat[]; // Blue's top winning 4-of-6 selections (by win rate)
  topRed: ComboStat[]; // Red's top winning 4-of-6 selections
  replayMin: number | null; // smallest game number still available to replay (null if none)
  replayMax: number | null; // latest game number available to replay
}

export type GameResult = "blue" | "red" | "tie";

// A finished game's play-by-play, kept so the user can type a number and watch that battle back.
export interface GameLog {
  n: number; // 1-indexed game number (matches Tally.games at the moment it finished)
  result: GameResult;
  blueLead: string | null; // "A + B" of the two Blue led with
  redLead: string | null; // "A + B" of the two Red led with
  lines: string[]; // raw Showdown protocol lines (public battle log)
}

// How many recent games to keep full logs for. A VGC log is a few KB; this caps replay memory at
// a few MB while covering far more than a user would scroll back to after pressing Stop.
const REPLAY_CAP = 500;

function mergeBook(dst: Book, src: Book) {
  for (const [sp, moves] of Object.entries(src)) {
    const d = (dst[sp] ??= {});
    for (const [mv, n] of Object.entries(moves)) d[mv] = (d[mv] || 0) + n;
  }
}

// All selections ranked by win rate (tiebreak: more wins — i.e. larger sample — then name).
function sortByWinRate(map: Map<string, { games: number; wins: number }>): ComboStat[] {
  const rate = (c: { games: number; wins: number }) => (c.games ? c.wins / c.games : 0);
  return Array.from(map.entries())
    .map(([combo, { games, wins }]) => ({ combo, games, wins }))
    .sort((x, y) => rate(y) - rate(x) || y.wins - x.wins || x.combo.localeCompare(y.combo));
}

// By raw frequency — used for "the Red leads you face most", where sample size decides relevance.
function sortByGames(map: Map<string, { games: number; wins: number }>): ComboStat[] {
  return Array.from(map.entries())
    .map(([combo, { games, wins }]) => ({ combo, games, wins }))
    .sort((x, y) => y.games - x.games || x.combo.localeCompare(y.combo));
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
  private destroyed = false;
  private running = false;

  private counts = { blue: 0, red: 0, ties: 0, games: 0 };
  private turn = 0;
  private sims = 0;
  private readonly bookBlue: Book = {}; // Blue's learned model of Red (for the game plan)
  private readonly bookRed: Book = {};
  private readonly comboBlue = new Map<string, { games: number; wins: number }>();
  private readonly comboRed = new Map<string, { games: number; wins: number }>();
  // Lead pairs, always counted from BLUE's perspective (did Blue win?).
  private readonly blueLeads = new Map<string, { games: number; wins: number }>();
  private readonly redLeads = new Map<string, { games: number; wins: number }>();
  // Rolling window of the most recent games' logs (oldest first), so Stop → "view battle N" works.
  private readonly replays: GameLog[] = [];
  private lastEmit = 0;

  private worker: Worker | null = null;

  constructor(opts: ControllerOpts) {
    this.onUpdate = opts.onUpdate;
    this.p1Team = opts.p1Team;
    this.p2Team = opts.p2Team;
    // The worker owns the heavy search loop; it's created lazily on first start().
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./mcts-worker.ts", import.meta.url));
      this.worker.onmessage = (e: MessageEvent<WorkerMsg>) => this.onMessage(e.data);
    }
    return this.worker;
  }

  /** Begin (or resume) the loop. Tally and learning carry over from where they left off. */
  start() {
    if (this.destroyed || this.running) return;
    this.running = true;
    const w = this.ensureWorker();
    w.postMessage({ type: "start", p1Team: this.p1Team, p2Team: this.p2Team, formatid: this.formatid });
    this.emit(true);
  }

  /** Pause after the in-flight game finishes. Tally/learning are kept for resume. */
  stop() {
    this.running = false;
    this.worker?.postMessage({ type: "stop" });
    this.emit(true);
  }

  /** Clear the tally and learning back to a fresh run (only meaningful while stopped). */
  reset() {
    this.counts = { blue: 0, red: 0, ties: 0, games: 0 };
    this.turn = 0;
    this.sims = 0;
    for (const k of Object.keys(this.bookBlue)) delete this.bookBlue[k];
    for (const k of Object.keys(this.bookRed)) delete this.bookRed[k];
    this.comboBlue.clear();
    this.comboRed.clear();
    this.blueLeads.clear();
    this.redLeads.clear();
    this.replays.length = 0;
    this.worker?.postMessage({ type: "reset" });
    this.emit(true);
  }

  /** Halt permanently and tear the worker down (e.g. on React unmount). */
  destroy() {
    this.destroyed = true;
    this.running = false;
    this.worker?.terminate();
    this.worker = null;
  }

  getTally(): Tally {
    return this.snapshot();
  }

  /** The stored play-by-play for game `n`, or null if it's out of the kept window. */
  getReplay(n: number): GameLog | null {
    return this.replays.find((r) => r.n === n) ?? null;
  }

  /** Blue's game plan vs Red, derived from the run so far (best selection, learned threats). */
  bluePlan(blueName: string, redName: string): PlanData {
    return analyzeBluePlan({
      blueTeamPacked: this.p1Team,
      blueTeamName: blueName,
      redTeamName: redName,
      blueWins: this.counts.blue,
      redWins: this.counts.red,
      games: this.counts.games,
      combos: sortByWinRate(this.comboBlue),
      blueLeads: sortByWinRate(this.blueLeads),
      redLeads: sortByGames(this.redLeads),
      book: this.bookBlue,
    });
  }

  private onMessage(msg: WorkerMsg) {
    if (this.destroyed) return;
    if (msg.type === "progress") {
      this.turn = msg.turn;
      this.sims = msg.sims;
      this.emit(false);
    } else if (msg.type === "game") {
      this.recordGame(msg);
      this.emit(false);
    } else if (msg.type === "stopped") {
      this.emit(true);
    }
  }

  private recordGame(o: WorkerGame) {
    if (o.result === "blue") this.counts.blue++;
    else if (o.result === "red") this.counts.red++;
    else this.counts.ties++;
    this.counts.games++;

    // Each side's selection played one game; the winning side's selection also won it.
    this.recordCombo(this.comboBlue, o.blueCombo, o.result === "blue");
    this.recordCombo(this.comboRed, o.redCombo, o.result === "red");
    // Lead pairs — both tracked from Blue's perspective.
    this.recordCombo(this.blueLeads, o.blueLead, o.result === "blue");
    this.recordCombo(this.redLeads, o.redLead, o.result === "blue");

    // Rolling replay window (evict the oldest past the cap).
    this.replays.push({
      n: this.counts.games,
      result: o.result,
      blueLead: o.blueLead,
      redLead: o.redLead,
      lines: o.lines,
    });
    if (this.replays.length > REPLAY_CAP) this.replays.shift();

    // Fold this game's observations into each side's learned model (feeds the game plan).
    mergeBook(this.bookBlue, o.obsBlue);
    mergeBook(this.bookRed, o.obsRed);
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

  private snapshot(): Tally {
    return {
      ...this.counts,
      searching: this.running,
      turn: this.turn,
      sims: this.sims,
      topBlue: sortByWinRate(this.comboBlue),
      topRed: sortByWinRate(this.comboRed),
      replayMin: this.replays[0]?.n ?? null,
      replayMax: this.replays[this.replays.length - 1]?.n ?? null,
    };
  }

  // Throttle UI updates to ~4x/sec; `force` (start/stop/reset/final) always emits.
  private emit(force: boolean) {
    if (this.destroyed) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.onUpdate(this.snapshot());
  }
}
