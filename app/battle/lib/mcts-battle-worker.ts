// Web Worker that answers ONE decision at a time for the interactive Level 3 (Adaptive) battle. The
// Monte Carlo search is heavy and time-boxed (up to ~15s), so it runs off the main thread to keep the
// page responsive — and the controller kicks it off the moment the AI's request arrives, so it thinks
// while the human is still choosing their own move.
//
// The main thread (engine.ts) serializes the live, full-information battle and posts it here; this
// worker forks it, runs the searcher (mcts.ts) to solve p2's (the Rival AI's) move, projects the
// endgame it's steering toward, and posts the choice + a win estimate + that endgame back.

import "./node-shim"; // must precede any @pkmn import
import { State } from "@pkmn/sim";
import { installChampionsStats } from "./champions-stats";
import { search, projectEndgame, DEFAULTS } from "./mcts";
import type { Matchup } from "./matchup";
import type { OpponentModel } from "./opponent-model";

installChampionsStats(); // Reg M-B EV rule; must run before deserializing/forking any battle

export interface DecideMsg {
  type: "decide";
  id: number; // correlates the reply with this request
  battleJSON: string; // JSON.stringify(State.serializeBattle(liveBattle)) from the main thread
  budget?: number; // max search iterations
  deadlineMs?: number; // wall-clock cap (interactive path passes ~15000)
  chart?: Matchup; // optional pre-battle matchup chart (p2's view)
  opponent?: OpponentModel; // optional learned player model (exploitative play)
}

export interface DecisionMsg {
  type: "decision";
  id: number;
  choice: string; // p2's chosen full choice string ("move 1", "switch 3", "team 1234", …)
  winProb: number; // search's own estimate of the Rival AI's (p2) win probability, 0..1
  endgame: string[]; // p2 Pokémon most often left standing when it wins — the target endgame
  sims: number; // iterations spent (for a progress/telemetry readout)
}

export type BattleWorkerOut = DecisionMsg | { type: "error"; id: number; message: string };
type BattleWorkerIn = DecideMsg;

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<BattleWorkerIn>) => {
  const msg = e.data;
  if (msg.type !== "decide") return;
  try {
    const budget = msg.budget ?? 5000; // high ceiling; the deadline is what usually stops it
    const deadlineMs = msg.deadlineMs ?? 15000;
    const battle = State.deserializeBattle(msg.battleJSON);
    const res = search(battle, Math.random, budget, {
      deadlineMs,
      chart: msg.chart,
      opponent: msg.opponent,
      aggression: DEFAULTS.aggression, // Level 3 plays aggressively (seek KOs, close games fast)
    });
    const p2 = res.p2;
    const choice = p2?.choice ?? "default";
    const winProb = p2 ? p2.value : 0.5;
    // Project the endgame the chosen line steers toward (cheap light playouts from the same root).
    const endgame = p2 ? projectEndgame(msg.battleJSON, choice, Math.random, 24) : [];
    const reply: DecisionMsg = { type: "decision", id: msg.id, choice, winProb, endgame, sims: budget };
    ctx.postMessage(reply);
  } catch (err) {
    ctx.postMessage({
      type: "error",
      id: msg.id,
      message: (err as Error)?.message || "search failed",
    } satisfies BattleWorkerOut);
  }
};

export {};
