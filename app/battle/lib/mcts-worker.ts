// Web Worker that plays Auto Battle games with the Monte Carlo searcher (mcts.ts). The search is
// heavy and meant to "run for a while", so it lives off the main thread — the UI stays responsive.
// The worker plays complete games and posts each finished game back to the client (auto-engine.ts),
// which owns all the tallying/replay/game-plan aggregation. It also posts lightweight progress so
// the page can show a "thinking" indicator.

import "./node-shim"; // must precede any @pkmn import
import { installChampionsStats } from "./champions-stats";
import { search, createBattle, DEFAULTS } from "./mcts";

installChampionsStats(); // Reg M-B EV rule; must run before constructing battles

type Book = Record<string, Record<string, number>>;

export interface WorkerGame {
  type: "game";
  result: "blue" | "red" | "tie";
  blueCombo: string | null;
  redCombo: string | null;
  blueLead: string | null;
  redLead: string | null;
  lines: string[]; // captured protocol log for the replay
  obsBlue: Book; // Red's moves as observed by Blue (for the game-plan threats)
  obsRed: Book;
}
export type WorkerMsg =
  | WorkerGame
  | { type: "progress"; game: number; turn: number; sims: number }
  | { type: "stopped" };

type StartMsg = { type: "start"; p1Team: string; p2Team: string; formatid: string };
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

async function playOneGame(p1Team: string, p2Team: string, formatid: string): Promise<WorkerGame> {
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
    post({ type: "progress", game: games + 1, turn: battle.turn + 1, sims: budget });
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
    blueCombo,
    redCombo,
    blueLead: pairKey(p1Lead[0], p1Lead[1]),
    redLead: pairKey(p2Lead[0], p2Lead[1]),
    lines,
    obsBlue,
    obsRed,
  };
}

async function loop(p1Team: string, p2Team: string, formatid: string) {
  while (running) {
    try {
      const game = await playOneGame(p1Team, p2Team, formatid);
      if (!running && game.result === "tie" && !game.lines.length) break; // aborted before it began
      games++;
      post(game);
    } catch (err) {
      // One bad game must not kill the worker; surface it and carry on.
      // eslint-disable-next-line no-console
      console.error("[mcts-worker] game error:", (err as Error)?.stack || err);
    }
    await tick();
  }
  post({ type: "stopped" });
}

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "start") {
    if (running) return;
    running = true;
    void loop(msg.p1Team, msg.p2Team, msg.formatid);
  } else if (msg.type === "stop") {
    running = false;
  } else if (msg.type === "reset") {
    running = false;
    games = 0;
  }
};

export {};
