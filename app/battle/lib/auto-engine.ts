// Auto Battle controller — roster gauntlet.
//
// Blue plays VGC 2026 Reg M-B against an ordered roster of opponents. Each decision is a Monte Carlo
// search over a forked copy of the real Showdown simulator (see mcts.ts): it treats the simultaneous
// move choice as a small game and plays a MIXED strategy, averages over the RNG, and weighs "Mega
// Evolve now vs later" as ordinary actions — nothing about Mega timing is hand-coded.
//
// The search is heavy and deliberately runs slowly for accuracy, so the game loop lives in a Web
// Worker (mcts-worker.ts) — which also owns the "which opponent + when to advance" decision, checking
// the dominant-win gate (wilson.ts) the instant a game finishes. This controller is the main-thread
// client: it forwards start/stop/reset, folds each finished game (tagged with the opponent it was
// played against) into per-opponent records, tracks each opponent's top winning "combinations" (a
// specific lead pair + back pair) and their winning replays, and keeps one rolling window of game logs
// so any battle can be watched back. Those aggregates live here so getTally()/getReplay() are sync.

import { FORMATS } from "./formats";
import type { RosterTeam, WorkerGame, WorkerMsg } from "./mcts-worker";
import { wilsonLowerBound, type GauntletConfig } from "./wilson";

// A winning "combination" for Blue: a specific lead pair + back pair (the exact 4 brought, split into
// the two that led and the two held in the back). Ranked by how many games it won.
export interface ComboWin {
  lead: string; // "A + B" — the two Pokémon led with
  back: string; // "C + D" — the two brought but not led
  games: number; // games this exact combination was brought
  wins: number; // games this combination won
  replays: number[]; // winning game numbers still in the replay window (watchable), newest first
}

// One opponent's standing in the gauntlet.
export interface OpponentProgress {
  id: string;
  name: string;
  blue: number; // Blue wins vs this opponent
  red: number; // Red (this opponent's) wins
  ties: number;
  games: number;
  lowerBound: number; // Wilson 95% lower bound of Blue's decided-game win rate (0..1)
  beaten: boolean; // Blue has dominantly beaten this opponent
  status: "pending" | "current" | "beaten";
}

export interface Tally {
  blue: number; // total Blue wins across the roster (derived)
  red: number; // total Red wins across the roster (derived)
  ties: number; // derived
  games: number; // derived
  roster: OpponentProgress[]; // per-opponent standings, in gauntlet order
  currentIndex: number; // which opponent is being played (roster.length once complete)
  complete: boolean; // every opponent dominantly beaten, in order
  searching: boolean; // is the searcher currently thinking?
  turn: number; // current game's turn (progress indicator)
  sims: number; // search iterations spent on the last decision
  topCombos: ComboWin[]; // the focused opponent's top 2 winning combinations (by wins)
  focusId: string | null; // which opponent topCombos reflects
  replayMin: number | null; // smallest game number still available to replay (null if none)
  replayMax: number | null; // latest game number available to replay
  error: string | null; // set if the worker couldn't run a matchup (e.g. an unrunnable team)
}

export type GameResult = "blue" | "red" | "tie";

// A finished game's play-by-play, kept so any battle can be watched back.
export interface GameLog {
  n: number; // 1-indexed global game number (matches Tally.games at the moment it finished)
  result: GameResult;
  opponentId: string; // which roster opponent this game was against
  blueCombo: string | null; // "A + B + C + D" of the four Blue brought
  blueLead: string | null; // "A + B" of the two Blue led with
  redLead: string | null; // "A + B" of the two Red led with
  lines: string[]; // raw Showdown protocol lines (public battle log)
}

// How many recent games to keep full logs for, across the whole gauntlet. A VGC log is a few KB; this
// caps replay memory at a few MB while covering far more than a user would scroll back to.
const REPLAY_CAP = 500;

// The two Pokémon brought but not led = the 4 brought minus the 2 leads. Null unless exactly 2 remain
// (guards against any species-name mismatch between the packed team and the battle log).
function backOf(combo: string | null, lead: string | null): string | null {
  if (!combo || !lead) return null;
  const leadSet = new Set(lead.split(" + "));
  const back = combo.split(" + ").filter((s) => !leadSet.has(s));
  return back.length === 2 ? back.slice().sort().join(" + ") : null;
}

const comboKey = (lead: string, back: string) => `${lead}||${back}`;

// Per-opponent aggregates the controller maintains from the tagged game stream.
interface OppAgg {
  id: string;
  name: string;
  counts: { blue: number; red: number; ties: number; games: number };
  comboWins: Map<string, { lead: string; back: string; games: number; wins: number }>;
  beaten: boolean; // set from the worker's authoritative roster-progress snapshots
}

interface ControllerOpts {
  onUpdate: (tally: Tally) => void;
  p1Team: string; // packed team Blue plays (from the Reg M-B registry or an upload)
  roster: RosterTeam[]; // ordered opponents Blue faces, in gauntlet order
  cfg?: GauntletConfig; // optional confidence-gate override (defaults in the worker)
}

export class AutoBattleController {
  private readonly onUpdate: (tally: Tally) => void;
  private readonly p1Team: string;
  private readonly roster: RosterTeam[];
  private readonly cfg?: GauntletConfig;
  private readonly formatid = FORMATS.vgcregmb.engineFormat;
  private destroyed = false;
  private running = false;

  // Per-opponent aggregates, in gauntlet order (also indexable by id via oppById).
  private readonly opps: OppAgg[];
  private readonly oppById = new Map<string, OppAgg>();
  private currentIndex = 0;
  private complete = false;
  private turn = 0;
  private sims = 0;
  private lastError: string | null = null;
  private focus: string | null = null; // opponent id topCombos reflects; null = current opponent
  // One global rolling window of game logs (oldest first), so any battle can be watched back and the
  // "Watch battle #N" box keeps a single monotonic numbering across opponents.
  private readonly replays: GameLog[] = [];
  private lastEmit = 0;

  private worker: Worker | null = null;

  constructor(opts: ControllerOpts) {
    this.onUpdate = opts.onUpdate;
    this.p1Team = opts.p1Team;
    this.roster = opts.roster;
    this.cfg = opts.cfg;
    this.opps = opts.roster.map((o) => ({
      id: o.id,
      name: o.name,
      counts: { blue: 0, red: 0, ties: 0, games: 0 },
      comboWins: new Map(),
      beaten: false,
    }));
    for (const o of this.opps) this.oppById.set(o.id, o);
    // The worker owns the heavy search loop; it's created lazily on first start().
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./mcts-worker.ts", import.meta.url));
      this.worker.onmessage = (e: MessageEvent<WorkerMsg>) => this.onMessage(e.data);
    }
    return this.worker;
  }

  /** Begin (or resume) the gauntlet. Tally carries over from where it left off. */
  start() {
    if (this.destroyed || this.running) return;
    this.running = true;
    this.lastError = null;
    const w = this.ensureWorker();
    w.postMessage({ type: "start", p1Team: this.p1Team, roster: this.roster, formatid: this.formatid, cfg: this.cfg });
    this.emit(true);
  }

  /** Pause after the in-flight game finishes. Tally is kept for resume. */
  stop() {
    this.running = false;
    this.worker?.postMessage({ type: "stop" });
    this.emit(true);
  }

  /** Clear the tally back to a fresh gauntlet (only meaningful while stopped). */
  reset() {
    for (const o of this.opps) {
      o.counts = { blue: 0, red: 0, ties: 0, games: 0 };
      o.comboWins.clear();
      o.beaten = false;
    }
    this.currentIndex = 0;
    this.complete = false;
    this.turn = 0;
    this.sims = 0;
    this.lastError = null;
    this.focus = null;
    this.replays.length = 0;
    this.worker?.postMessage({ type: "reset" });
    this.emit(true);
  }

  /** Point the top-combinations panel at a specific opponent (null = the current one). */
  setFocus(opponentId: string | null) {
    this.focus = opponentId && this.oppById.has(opponentId) ? opponentId : null;
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

  /** The display name for an opponent id (e.g. to label a replay's Red side). */
  opponentName(id: string | null): string | null {
    return id ? (this.oppById.get(id)?.name ?? null) : null;
  }

  private onMessage(msg: WorkerMsg) {
    if (this.destroyed) return;
    if (msg.type === "progress") {
      this.turn = msg.turn;
      this.sims = msg.sims;
      this.currentIndex = msg.currentIndex;
      this.emit(false);
    } else if (msg.type === "game") {
      this.recordGame(msg);
      this.emit(false);
    } else if (msg.type === "roster-progress") {
      this.currentIndex = msg.currentIndex;
      for (const o of msg.opponents) {
        const agg = this.oppById.get(o.id);
        if (agg) agg.beaten = o.beaten;
      }
      this.emit(true);
    } else if (msg.type === "complete") {
      this.complete = true;
      this.currentIndex = this.roster.length;
      this.running = false;
      this.emit(true);
    } else if (msg.type === "error") {
      this.lastError = msg.message;
      this.running = false;
      this.emit(true);
    } else if (msg.type === "stopped") {
      this.emit(true);
    }
  }

  private recordGame(o: WorkerGame) {
    const agg = this.oppById.get(o.opponentId);
    if (agg) {
      if (o.result === "blue") agg.counts.blue++;
      else if (o.result === "red") agg.counts.red++;
      else agg.counts.ties++;
      agg.counts.games++;

      // Tally Blue's exact combination (lead + back) for this game, per opponent.
      const back = backOf(o.blueCombo, o.blueLead);
      if (o.blueLead && back) {
        const key = comboKey(o.blueLead, back);
        const cur = agg.comboWins.get(key) ?? { lead: o.blueLead, back, games: 0, wins: 0 };
        cur.games++;
        if (o.result === "blue") cur.wins++;
        agg.comboWins.set(key, cur);
      }
    }

    // One global rolling replay window (evict the oldest past the cap). n stays globally monotonic;
    // this game's win/loss was already folded into totalGames() above, so n == the running total.
    const n = this.totalGames();
    this.replays.push({
      n,
      result: o.result,
      opponentId: o.opponentId,
      blueCombo: o.blueCombo,
      blueLead: o.blueLead,
      redLead: o.redLead,
      lines: o.lines,
    });
    if (this.replays.length > REPLAY_CAP) this.replays.shift();
  }

  private totalGames(): number {
    let t = 0;
    for (const o of this.opps) t += o.counts.games;
    return t;
  }

  // The opponent the top-combinations panel reflects: the explicit focus, else the current opponent,
  // else the last one (once the gauntlet is complete or nothing is selected).
  private focusId(): string | null {
    if (this.focus && this.oppById.has(this.focus)) return this.focus;
    const cur = this.opps[Math.min(this.currentIndex, this.opps.length - 1)];
    return cur?.id ?? null;
  }

  // The focused opponent's top 2 winning combinations by wins, each with the winning game numbers
  // still watchable in the global replay window.
  private topCombos(focusId: string | null): ComboWin[] {
    const agg = focusId ? this.oppById.get(focusId) : null;
    if (!agg) return [];
    return Array.from(agg.comboWins.values())
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
              r.opponentId === focusId &&
              r.blueLead != null &&
              comboKey(r.blueLead, backOf(r.blueCombo, r.blueLead) ?? " ") === key
          )
          .map((r) => r.n)
          .sort((x, y) => y - x); // newest first
        return { lead: c.lead, back: c.back, games: c.games, wins: c.wins, replays };
      });
  }

  private snapshot(): Tally {
    let blue = 0,
      red = 0,
      ties = 0,
      games = 0;
    const roster: OpponentProgress[] = this.opps.map((o, i) => {
      blue += o.counts.blue;
      red += o.counts.red;
      ties += o.counts.ties;
      games += o.counts.games;
      const decided = o.counts.blue + o.counts.red;
      return {
        id: o.id,
        name: o.name,
        blue: o.counts.blue,
        red: o.counts.red,
        ties: o.counts.ties,
        games: o.counts.games,
        lowerBound: wilsonLowerBound(o.counts.blue, decided, this.cfg?.z),
        beaten: o.beaten,
        status: o.beaten ? "beaten" : i === this.currentIndex ? "current" : "pending",
      };
    });
    const focusId = this.focusId();
    return {
      blue,
      red,
      ties,
      games,
      roster,
      currentIndex: this.currentIndex,
      complete: this.complete,
      searching: this.running,
      turn: this.turn,
      sims: this.sims,
      topCombos: this.topCombos(focusId),
      focusId,
      replayMin: this.replays[0]?.n ?? null,
      replayMax: this.replays[this.replays.length - 1]?.n ?? null,
      error: this.lastError,
    };
  }

  // Throttle UI updates to ~4x/sec; `force` (start/stop/reset/advance/final) always emits.
  private emit(force: boolean) {
    if (this.destroyed) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.onUpdate(this.snapshot());
  }
}
