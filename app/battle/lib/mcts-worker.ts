// Web Worker that plays Auto Battle games with the Monte Carlo searcher (mcts.ts). The search is
// heavy and meant to "run for a while", so it lives off the main thread — the UI stays responsive.
// The worker plays complete games and posts each finished game back to the client (auto-engine.ts),
// which owns all the tallying/replay aggregation. It also posts lightweight progress so the page can
// show a "thinking" indicator.
//
// Roster gauntlet: Blue (p1) faces an ordered roster of opponents. The worker owns the "which
// opponent + when to advance" loop, because it plays games sequentially and can therefore check the
// dominant-win gate (wilson.ts) the instant a game finishes and switch opponents with zero
// round-trip. Every finished `game` is tagged with the opponentId it was actually played against, so
// the controller can attribute records/combos/replays with no ambiguity and no race.

import "./node-shim"; // must precede any @pkmn import
import { installChampionsStats } from "./champions-stats";
import { search, createBattle, DEFAULTS } from "./mcts";
import { isDominantWin, wilsonLowerBound, GAUNTLET_DEFAULTS, type GauntletConfig } from "./wilson";

installChampionsStats(); // Reg M-B EV rule; must run before constructing battles

type Book = Record<string, Record<string, number>>;

export interface RosterTeam {
  id: string; // stable per-opponent key (preset id or a generated custom id)
  name: string;
  packed: string;
}

export interface WorkerGame {
  type: "game";
  result: "blue" | "red" | "tie";
  opponentId: string; // which roster opponent this game was played against
  blueCombo: string | null;
  redCombo: string | null;
  blueLead: string | null;
  redLead: string | null;
  lines: string[]; // captured protocol log for the replay
  obsBlue: Book; // Red's moves as observed by Blue (kept for possible future use)
  obsRed: Book;
}

// A per-advance snapshot of every opponent's record + confidence, computed by the worker's own gate so
// the controller can trust which opponents are "beaten" and which one is current.
export interface RosterProgress {
  type: "roster-progress";
  currentIndex: number;
  opponents: {
    id: string;
    blue: number;
    red: number;
    ties: number;
    decided: number;
    lowerBound: number;
    beaten: boolean;
  }[];
}

export type WorkerMsg =
  | WorkerGame
  | RosterProgress
  | { type: "progress"; game: number; turn: number; sims: number; opponentId: string; currentIndex: number }
  | { type: "complete" } // every opponent dominantly beaten, in order
  | { type: "error"; message: string }
  | { type: "stopped" };

type StartMsg = {
  type: "start";
  p1Team: string;
  roster: RosterTeam[];
  formatid: string;
  cfg?: GauntletConfig;
};
type InMsg = StartMsg | { type: "stop" } | { type: "reset" };

const ctx = self as unknown as Worker;
const post = (m: WorkerMsg) => ctx.postMessage(m);
const tick = () => new Promise((r) => setTimeout(r, 0));

let running = false;
let games = 0;

function cleanName(details: string): string {
  return (details || "").split(",")[0].trim();
}

// Only the protocol lines the replay cares about (matches auto-replay's expectations).
function keepReplayLine(line: string): boolean {
  if (!line.startsWith("|")) return false;
  if (line === "|" || line === "|upkeep") return false;
  if (line.startsWith("|t:") || line.startsWith("|request") || line.startsWith("|split")) return false;
  return true;
}

// Species brought, from a "team 1435" choice mapped through the packed team order → "A + B + C + D".
function comboFromChoice(choice: string, packed: string): string | null {
  const m = /^team\s+(\d+)/.exec(choice);
  if (!m) return null;
  const species = packed.split("]").map((s) => s.split("|")[0].trim());
  const names = m[1]
    .split("")
    .map((d) => species[parseInt(d, 10) - 1])
    .filter(Boolean);
  return names.length ? names.slice().sort().join(" + ") : null;
}

function pairKey(a: string | null, b: string | null): string | null {
  const both = [a, b].filter((x): x is string => !!x);
  return both.length < 2 ? null : both.slice().sort().join(" + ");
}

function applyChoiceSafe(battle: any, sid: string, choice: string) {
  try {
    if (!battle.choose(sid, choice)) {
      battle[sid].clearChoice();
      battle.choose(sid, "default");
    }
  } catch {
    try {
      battle[sid].clearChoice();
      battle.choose(sid, "default");
    } catch {
      /* noop */
    }
  }
}

function commitSafe(battle: any): boolean {
  if (!battle.allChoicesDone()) {
    for (const sid of ["p1", "p2"]) {
      if (battle[sid].activeRequest && !battle[sid].activeRequest.wait && !battle[sid].isChoiceDone()) {
        try {
          battle.choose(sid, "default");
        } catch {
          /* noop */
        }
      }
    }
  }
  try {
    if (battle.allChoicesDone()) battle.commitChoices();
    return true;
  } catch {
    return false; // rare @pkmn/sim end-state quirk → end the game where it is
  }
}

// Plays one Blue-vs-one-opponent game. Pure single-matchup logic — the only roster-aware inputs are
// `opponentId`/`currentIndex`, used solely to tag the outgoing messages (never to change how it plays).
async function playOneGame(
  p1Team: string,
  p2Team: string,
  formatid: string,
  opponentId: string,
  currentIndex: number
): Promise<WorkerGame> {
  const battle = createBattle(formatid, p1Team, p2Team);
  const lines: string[] = [];
  let blueCombo: string | null = null;
  let redCombo: string | null = null;
  const p1Lead: (string | null)[] = [null, null];
  const p2Lead: (string | null)[] = [null, null];
  const obsBlue: Book = {};
  const obsRed: Book = {};
  const activeSp: Record<string, (string | null)[]> = { p1: [null, null], p2: [null, null] };

  let cursor = 0;
  const drainLog = () => {
    for (; cursor < battle.log.length; cursor++) {
      const line = battle.log[cursor];
      if (line.startsWith("|switch|") || line.startsWith("|drag|")) {
        const parts = line.split("|");
        const pos = parts[2] ?? "";
        const side = pos.slice(0, 2);
        const slot = pos.charAt(2) === "b" ? 1 : 0;
        const sp = cleanName(parts[3] ?? "");
        activeSp[side][slot] = sp;
        if (side === "p1" && p1Lead[slot] === null) p1Lead[slot] = sp;
        if (side === "p2" && p2Lead[slot] === null) p2Lead[slot] = sp;
      } else if (line.startsWith("|move|")) {
        const parts = line.split("|");
        const pos = parts[2] ?? "";
        const side = pos.slice(0, 2);
        const slot = pos.charAt(2) === "b" ? 1 : 0;
        const sp = activeSp[side]?.[slot];
        const mv = (parts[3] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (sp && mv) {
          // Blue observes Red's moves (obsBlue) and vice-versa.
          const book = side === "p2" ? obsBlue : obsRed;
          const bucket = (book[sp.toLowerCase().replace(/[^a-z0-9]/g, "")] ??= {});
          bucket[mv] = (bucket[mv] || 0) + 1;
        }
      }
      if (keepReplayLine(line)) lines.push(line);
    }
  };

  let guard = 0;
  while (!battle.ended && guard++ < 400 && running) {
    const rs = battle.requestState;
    const budget = rs === "teampreview" ? DEFAULTS.teamBudget : DEFAULTS.turnBudget;
    const res = search(battle, Math.random, budget);
    post({ type: "progress", game: games + 1, turn: battle.turn + 1, sims: budget, opponentId, currentIndex });
    for (const sid of ["p1", "p2"] as const) {
      if (!res[sid]) continue;
      if (rs === "teampreview") {
        const combo = comboFromChoice(res[sid]!.choice, sid === "p1" ? p1Team : p2Team);
        if (sid === "p1") blueCombo = combo;
        else redCombo = combo;
      }
      applyChoiceSafe(battle, sid, res[sid]!.choice);
    }
    if (!commitSafe(battle)) break;
    drainLog();
    await tick(); // let the worker process a pending stop between decisions
  }
  drainLog();

  const result: "blue" | "red" | "tie" = battle.ended
    ? battle.winner === "Blue"
      ? "blue"
      : battle.winner === "Red"
        ? "red"
        : "tie"
    : "tie";

  return {
    type: "game",
    result,
    opponentId,
    blueCombo,
    redCombo,
    blueLead: pairKey(p1Lead[0], p1Lead[1]),
    redLead: pairKey(p2Lead[0], p2Lead[1]),
    lines,
    obsBlue,
    obsRed,
  };
}

// A running record for one opponent (ties tracked for display; only wins/losses gate advancement).
type Rec = { blue: number; red: number; ties: number };
const decidedOf = (r: Rec) => r.blue + r.red;

// Broadcast every opponent's record + Wilson lower bound as the worker sees it, so the controller can
// trust which are beaten and which is current. Sent on each advance and on completion.
function postRosterProgress(roster: RosterTeam[], rec: Rec[], currentIndex: number, cfg: GauntletConfig) {
  post({
    type: "roster-progress",
    currentIndex,
    opponents: roster.map((o, i) => ({
      id: o.id,
      blue: rec[i].blue,
      red: rec[i].red,
      ties: rec[i].ties,
      decided: decidedOf(rec[i]),
      lowerBound: wilsonLowerBound(rec[i].blue, decidedOf(rec[i]), cfg.z),
      beaten: i < currentIndex,
    })),
  });
}

// Play Blue through the roster in order. Stay on the current opponent until Blue dominantly beats it
// (wilson.ts gate), then advance. When every opponent is beaten, post `complete`. Never advance a
// stuck matchup — it plays forever until the user presses Stop.
async function loop(p1Team: string, roster: RosterTeam[], formatid: string, cfg: GauntletConfig) {
  const rec: Rec[] = roster.map(() => ({ blue: 0, red: 0, ties: 0 }));
  let idx = 0;
  let earlyFailures = 0; // consecutive throws with zero completed games against the CURRENT opponent

  while (running && idx < roster.length) {
    const opp = roster[idx];
    try {
      const game = await playOneGame(p1Team, opp.packed, formatid, opp.id, idx);
      if (!running && game.result === "tie" && !game.lines.length) break; // aborted before it began
      games++;
      post(game);
      if (game.result === "blue") rec[idx].blue++;
      else if (game.result === "red") rec[idx].red++;
      else rec[idx].ties++;
      earlyFailures = 0;

      // Advance only when Blue has *dominantly* beaten this opponent.
      if (isDominantWin(rec[idx].blue, decidedOf(rec[idx]), cfg)) {
        idx++;
        postRosterProgress(roster, rec, idx, cfg);
      }
    } catch (err) {
      // A one-off mid-game throw shouldn't kill a healthy run, but if the CURRENT opponent never
      // produces a game (e.g. an unrunnable team mid-roster), surface it and stop instead of spinning.
      // eslint-disable-next-line no-console
      console.error("[mcts-worker] game error:", (err as Error)?.stack || err);
      if (decidedOf(rec[idx]) + rec[idx].ties === 0 && ++earlyFailures >= 3) {
        running = false;
        post({
          type: "error",
          message: (err as Error)?.message || `Couldn't run the matchup against ${opp.name}.`,
        });
        break;
      }
    }
    await tick();
  }

  if (running && idx >= roster.length) post({ type: "complete" }); // every opponent dominantly beaten
  running = false;
  post({ type: "stopped" });
}

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "start") {
    if (running) return;
    if (!msg.roster || msg.roster.length === 0) {
      post({ type: "error", message: "No opponents in the roster." });
      return;
    }
    running = true;
    void loop(msg.p1Team, msg.roster, msg.formatid, msg.cfg ?? GAUNTLET_DEFAULTS);
  } else if (msg.type === "stop") {
    running = false;
  } else if (msg.type === "reset") {
    running = false;
    games = 0;
  }
};

export {};
