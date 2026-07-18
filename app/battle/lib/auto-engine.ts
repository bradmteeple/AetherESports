// Headless AI-vs-AI runner for the Auto Battle tab.
//
// Runs real Pokémon Showdown battles between two *random* players in the VGC 2026 Reg M-B
// format, back-to-back and as fast as the engine allows ("turbo"). Nothing is rendered
// per turn — the output is a running win/loss/tie tally plus, per side, the top 3 *winning*
// 4-of-6 Team Preview selections (the four Pokémon that side brought). This is deliberately
// separate from the interactive Battle tab's BattleController (engine.ts), which drives a human.
//
// Both sides are RandomPlayerAI subclasses (unseeded => a fresh random PRNG per game), and each
// game gets a fresh BattleStream (also unseeded), so no two games play out identically. The
// base RandomPlayerAI picks its Team Preview with "default" (always the same four), so we
// override chooseTeamPreview to bring a random selection — and record which four, so we can rank
// the selections by how often they won.

import "./node-shim"; // must precede any @pkmn import — defines Node globals for the browser
import { BattleStreams, RandomPlayerAI } from "@pkmn/sim";
import { FORMATS } from "./formats";
import { installChampionsStats } from "./champions-stats";

installChampionsStats(); // Reg M-B (Champions): 1 EV = +1 stat; idempotent.

const TEAM_SIZE = FORMATS.vgcregmb.teamSize; // bring N (4 for Reg M-B)

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
  topBlue: ComboStat[]; // Blue's top 3 winning 4-of-6 selections (most wins first)
  topRed: ComboStat[]; // Red's top 3 winning 4-of-6 selections
}

export type GameResult = "blue" | "red" | "tie";

interface GameOutcome {
  result: GameResult;
  blueCombo: string | null; // sorted "A + B + C + D" of the four Blue brought, if captured
  redCombo: string | null;
}

const P1_NAME = "Blue";
const P2_NAME = "Red";

// A random-play AI that also brings a RANDOM Team Preview selection (rather than the base
// class's fixed "default"), so the selection varies game to game — and records which four it
// brought (sorted species combo) so the controller can rank selections by wins.
class LeadRandomAI extends RandomPlayerAI {
  selectedCombo: string | null = null;

  protected override chooseTeamPreview(team: any[]): string {
    const n = team.length;
    const idx = Array.from({ length: n }, (_, i) => i + 1);
    // Fisher–Yates shuffle using the AI's own PRNG.
    for (let i = n - 1; i > 0; i--) {
      const j = this.prng.random(i + 1);
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const bring = Math.min(TEAM_SIZE, n);
    const pick = idx.slice(0, bring);
    // `team` is the request's side.pokemon; each entry carries a `details` string ("Torkoal, L50, M").
    this.selectedCombo = pick
      .map((i) => cleanName((team[i - 1] && (team[i - 1].details || team[i - 1].ident)) || ""))
      .filter(Boolean)
      .sort()
      .join(" + ");
    return "team " + pick.join("");
  }
}

// "p1a: Torkoal" -> { side: "p1", slot: 0 }; species comes from the details field instead.
function cleanName(details: string): string {
  return (details || "").split(",")[0].trim();
}

// All selections ranked by wins (tiebreak: higher win rate, then name). The UI shows the top 3;
// the full list is kept so a Stop → Start resume doesn't lose the rest.
function sortByWins(map: Map<string, { games: number; wins: number }>): ComboStat[] {
  return Array.from(map.entries())
    .map(([combo, { games, wins }]) => ({ combo, games, wins }))
    .sort(
      (x, y) =>
        y.wins - x.wins ||
        y.wins / y.games - x.wins / x.games ||
        x.combo.localeCompare(y.combo)
    );
}

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
  private counts = { blue: 0, red: 0, ties: 0, games: 0 };
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
    if (opts.initial) {
      const { blue, red, ties, games } = opts.initial;
      this.counts = { blue, red, ties, games };
      for (const { combo, games: g, wins } of opts.initial.topBlue ?? []) this.comboBlue.set(combo, { games: g, wins });
      for (const { combo, games: g, wins } of opts.initial.topRed ?? []) this.comboRed.set(combo, { games: g, wins });
    }
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

  private async runLoop() {
    try {
      while (!this.stopped && !this.destroyed) {
        const outcome = await this.runGame();
        if (this.stopped || this.destroyed) break;
        if (outcome.result === "blue") this.counts.blue++;
        else if (outcome.result === "red") this.counts.red++;
        else this.counts.ties++;
        this.counts.games++;
        // Each side's selection played one game; the winning side's selection also won it.
        this.recordCombo(this.comboBlue, outcome.blueCombo, outcome.result === "blue");
        this.recordCombo(this.comboRed, outcome.redCombo, outcome.result === "red");
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

  /** Play one full game to completion (or until stopped). Resolves with the winner + selections. */
  private async runGame(): Promise<GameOutcome> {
    const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
    this.activeStreams = streams;

    // Two random players with randomized leads — fresh PRNG each, so play varies every game.
    const ai1 = new LeadRandomAI(streams.p1);
    const ai2 = new LeadRandomAI(streams.p2);
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
    return { result, blueCombo: ai1.selectedCombo, redCombo: ai2.selectedCombo };
  }

  private snapshot(): Tally {
    return {
      ...this.counts,
      topBlue: sortByWins(this.comboBlue),
      topRed: sortByWins(this.comboRed),
    };
  }

  // Throttle UI updates to ~4x/sec so a turbo loop doesn't flood React with renders. `force`
  // (stop/final) always emits.
  private emit(force: boolean) {
    if (this.destroyed) return; // never emit after unmount
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.onUpdate(this.snapshot());
  }
}
