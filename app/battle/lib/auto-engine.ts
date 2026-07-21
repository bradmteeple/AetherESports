// Auto Battle controller.
//
// Two AIs play VGC 2026 Reg M-B, back to back. Each decision is made by a Monte Carlo search that
// looks ahead over a forked copy of the real Showdown simulator (see mcts.ts): it treats the
// simultaneous move choice as a small game and plays a MIXED strategy, averages over the RNG, and
// weighs "Mega Evolve now vs later" as ordinary actions — nothing about Mega timing is hand-coded.
//
// The search is heavy and deliberately runs slowly for accuracy, so the game loop lives in a Web
// Worker (mcts-worker.ts). This controller is the main-thread client: it forwards start/stop/reset,
// folds each finished game into the running tally, tracks the top winning "combinations" (a specific
// lead pair + back pair) and their winning replays, and keeps a rolling window of game logs so any
// battle can be watched back. Those aggregates live here so getTally()/getReplay() are synchronous.

import { FORMATS } from "./formats";
import type { WorkerGame, WorkerMsg } from "./mcts-worker";

// A winning "combination" for Blue: a specific lead pair + back pair (the exact 4 brought, split into
// the two that led and the two held in the back). Ranked by how many games it won.
export interface ComboWin {
  lead: string; // "A + B" — the two Pokémon led with
  back: string; // "C + D" — the two brought but not led
  games: number; // games this exact combination was brought
  wins: number; // games this combination won
  replays: number[]; // winning game numbers still in the replay window (watchable), newest first
}

export interface Tally {
  blue: number; // p1 wins
  red: number; // p2 wins
  ties: number;
  games: number;
  searching: boolean; // is the searcher currently thinking?
  turn: number; // current game's turn (progress indicator)
  sims: number; // search iterations spent on the last decision
  topCombos: ComboWin[]; // Blue's top 2 winning combinations (by wins)
  replayMin: number | null; // smallest game number still available to replay (null if none)
  replayMax: number | null; // latest game number available to replay
  error: string | null; // set if the worker couldn't run the matchup (e.g. an unrunnable team)
}

export type GameResult = "blue" | "red" | "tie";

// A finished game's play-by-play, kept so any battle can be watched back.
export interface GameLog {
  n: number; // 1-indexed game number (matches Tally.games at the moment it finished)
  result: GameResult;
  blueCombo: string | null; // "A + B + C + D" of the four Blue brought
  blueLead: string | null; // "A + B" of the two Blue led with
  redLead: string | null; // "A + B" of the two Red led with
  lines: string[]; // raw Showdown protocol lines (public battle log)
}

// How many recent games to keep full logs for. A VGC log is a few KB; this caps replay memory at
// a few MB while covering far more than a user would scroll back to after pressing Stop.
const REPLAY_CAP = 500;

// The two Pokémon brought but not led = the 4 brought minus the 2 leads. Null unless exactly 2
// remain (guards against any species-name mismatch between the packed team and the battle log).
function backOf(combo: string | null, lead: string | null): string | null {
  if (!combo || !lead) return null;
  const leadSet = new Set(lead.split(" + "));
  const back = combo.split(" + ").filter((s) => !leadSet.has(s));
  return back.length === 2 ? back.slice().sort().join(" + ") : null;
}

const comboKey = (lead: string, back: string) => `${lead}||${back}`;

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
  private lastError: string | null = null;
  // Blue's combinations (lead+back) → games/wins. Keyed by `${lead}||${back}`.
  private readonly comboWinsBlue = new Map<string, { lead: string; back: string; games: number; wins: number }>();
  // Rolling window of the most recent games' logs (oldest first), so any battle can be watched back.
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

  /** Begin (or resume) the loop. Tally carries over from where it left off. */
  start() {
    if (this.destroyed || this.running) return;
    this.running = true;
    this.lastError = null;
    const w = this.ensureWorker();
    w.postMessage({ type: "start", p1Team: this.p1Team, p2Team: this.p2Team, formatid: this.formatid });
    this.emit(true);
  }

  /** Pause after the in-flight game finishes. Tally is kept for resume. */
  stop() {
    this.running = false;
    this.worker?.postMessage({ type: "stop" });
    this.emit(true);
  }

  /** Clear the tally back to a fresh run (only meaningful while stopped). */
  reset() {
    this.counts = { blue: 0, red: 0, ties: 0, games: 0 };
    this.turn = 0;
    this.sims = 0;
    this.lastError = null;
    this.comboWinsBlue.clear();
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

  private onMessage(msg: WorkerMsg) {
    if (this.destroyed) return;
    if (msg.type === "progress") {
      this.turn = msg.turn;
      this.sims = msg.sims;
      this.emit(false);
    } else if (msg.type === "game") {
      this.recordGame(msg);
      this.emit(false);
    } else if (msg.type === "error") {
      this.lastError = msg.message;
      this.running = false;
      this.emit(true);
    } else if (msg.type === "stopped") {
      this.emit(true);
    }
  }

  private recordGame(o: WorkerGame) {
    if (o.result === "blue") this.counts.blue++;
    else if (o.result === "red") this.counts.red++;
    else this.counts.ties++;
    this.counts.games++;

    // Tally Blue's exact combination (lead + back) for this game.
    const back = backOf(o.blueCombo, o.blueLead);
    if (o.blueLead && back) {
      const key = comboKey(o.blueLead, back);
      const cur = this.comboWinsBlue.get(key) ?? { lead: o.blueLead, back, games: 0, wins: 0 };
      cur.games++;
      if (o.result === "blue") cur.wins++;
      this.comboWinsBlue.set(key, cur);
    }

    // Rolling replay window (evict the oldest past the cap).
    this.replays.push({
      n: this.counts.games,
      result: o.result,
      blueCombo: o.blueCombo,
      blueLead: o.blueLead,
      redLead: o.redLead,
      lines: o.lines,
    });
    if (this.replays.length > REPLAY_CAP) this.replays.shift();
  }

  // Blue's top 2 winning combinations by wins, each with the winning game numbers still watchable.
  private topCombos(): ComboWin[] {
    return Array.from(this.comboWinsBlue.values())
      .filter((c) => c.wins > 0)
      .sort(
        (a, b) =>
          b.wins - a.wins ||
          b.games - a.games ||
          (a.lead + a.back).localeCompare(b.lead + b.back)
      )
      .slice(0, 2)
      .map((c) => {
        const key = comboKey(c.lead, c.back);
        const replays = this.replays
          .filter(
            (r) =>
              r.result === "blue" &&
              r.blueLead != null &&
              comboKey(r.blueLead, backOf(r.blueCombo, r.blueLead) ?? " ") === key
          )
          .map((r) => r.n)
          .sort((x, y) => y - x); // newest first
        return { lead: c.lead, back: c.back, games: c.games, wins: c.wins, replays };
      });
  }

  private snapshot(): Tally {
    return {
      ...this.counts,
      searching: this.running,
      turn: this.turn,
      sims: this.sims,
      topCombos: this.topCombos(),
      replayMin: this.replays[0]?.n ?? null,
      replayMax: this.replays[this.replays.length - 1]?.n ?? null,
      error: this.lastError,
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
