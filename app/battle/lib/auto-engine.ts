// Headless AI-vs-AI runner for the Auto Battle tab.
//
// Runs real Pokémon Showdown battles between two *random* players in the VGC 2026 Reg M-B
// format, back-to-back and as fast as the engine allows ("turbo"). Nothing is rendered
// per turn — the only output is a running win/loss/tie tally. This is deliberately separate
// from the interactive Battle tab's BattleController (engine.ts), which drives a human on p1.
//
// Both sides are @pkmn/sim's RandomPlayerAI (unseeded => a fresh random PRNG per game), and
// each game gets a fresh BattleStream (unseeded => the engine rolls its own damage/crit/speed
// RNG), so no two games play out identically.

import "./node-shim"; // must precede any @pkmn import — defines Node globals for the browser
import { BattleStreams, RandomPlayerAI } from "@pkmn/sim";
import { FORMATS } from "./formats";
import { installChampionsStats } from "./champions-stats";

installChampionsStats(); // Reg M-B (Champions): 1 EV = +1 stat; idempotent.

export interface Tally {
  blue: number; // p1 wins
  red: number; // p2 wins
  ties: number;
  games: number;
}

export type GameResult = "blue" | "red" | "tie";

const P1_NAME = "Blue";
const P2_NAME = "Red";

interface ControllerOpts {
  onUpdate: (tally: Tally) => void;
  p1Team: string; // packed team Blue plays (from the Reg M-B registry)
  p2Team: string; // packed team Red plays
  initial?: Tally; // resume the running tally (Stop → Start keeps accumulating)
}

export class AutoBattleController {
  private readonly onUpdate: (tally: Tally) => void;
  private readonly p1Team: string;
  private readonly p2Team: string;
  private readonly formatid = FORMATS.vgcregmb.engineFormat;
  private stopped = true;
  private destroyed = false;
  private looping = false;
  private tally: Tally = { blue: 0, red: 0, ties: 0, games: 0 };
  private lastEmit = 0;

  // The stream of the game currently in flight, so stop()/destroy() can tear it down and let
  // the in-flight `for await` resolve.
  private activeStreams: ReturnType<typeof BattleStreams.getPlayerStreams> | null = null;

  constructor(opts: ControllerOpts) {
    this.onUpdate = opts.onUpdate;
    this.p1Team = opts.p1Team;
    this.p2Team = opts.p2Team;
    if (opts.initial) this.tally = { ...opts.initial };
  }

  start() {
    if (this.destroyed || this.looping) return;
    this.stopped = false;
    this.looping = true;
    void this.runLoop();
  }

  /** Halt the loop; the in-flight game is abandoned. Idempotent. Flushes a final tally. */
  stop() {
    this.stopped = true;
    this.endActive();
    this.emit(true);
  }

  /** Halt permanently and stop emitting (e.g. on React unmount). */
  destroy() {
    this.destroyed = true;
    this.stopped = true;
    this.endActive();
  }

  getTally(): Tally {
    return { ...this.tally };
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

  private async runLoop() {
    try {
      while (!this.stopped && !this.destroyed) {
        const result = await this.runGame();
        if (this.stopped || this.destroyed) break;
        if (result === "blue") this.tally.blue++;
        else if (result === "red") this.tally.red++;
        else this.tally.ties++;
        this.tally.games++;
        this.emit(false);
        // Yield to the event loop so the Start/Stop button and React stay responsive even
        // when thousands of games run per second.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.looping = false;
      this.endActive();
      this.emit(true);
    }
  }

  /** Play one full game to completion (or until stopped). Resolves with the winner. */
  private async runGame(): Promise<GameResult> {
    const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
    this.activeStreams = streams;

    // Two random players — no seed => a fresh random PRNG each, so play varies every game.
    const ai1 = new RandomPlayerAI(streams.p1);
    const ai2 = new RandomPlayerAI(streams.p2);
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
    return result;
  }

  // Throttle UI updates to ~4x/sec so a turbo loop doesn't flood React with renders. `force`
  // (stop/final) always emits.
  private emit(force: boolean) {
    if (this.destroyed) return; // never emit after unmount
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.onUpdate({ ...this.tally });
  }
}
