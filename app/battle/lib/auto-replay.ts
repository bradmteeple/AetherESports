// Turns a stored Auto Battle game's raw protocol lines into a readable, spectator-perspective
// play-by-play. Reuses the Battle tab's line formatter (protocol.ts, pure — no engine) and only
// swaps its "You / Foe" wording for the two named sides, so there's a single source of truth for
// how a Showdown line reads.

import { describeLine, emptyBoard } from "./protocol";

export interface ReplayEntry {
  text: string;
  kind: "turn" | "result" | "event"; // for styling turn dividers and the win/tie line
}

// describeLine writes from p1's seat ("You / Your / the foe's / Foe"); relabel to Blue (p1) / Red
// (p2). Order matters: resolve the two-word possessive "the foe's" before the bare "Foe ".
function relabel(s: string): string {
  return s
    .replace(/\bthe foe's /g, "Red's ")
    .replace(/\bYour /g, "Blue's ")
    .replace(/\byour /g, "Blue's ")
    .replace(/\bFoe /g, "Red ")
    .replace(/\bYou /g, "Blue ");
}

export function renderReplay(lines: string[]): ReplayEntry[] {
  const board = emptyBoard();
  const out: ReplayEntry[] = [];
  for (const line of lines) {
    const desc = describeLine(line, board);
    if (!desc) continue;
    const text = relabel(desc).replace(/^\n/, "").trim();
    if (!text) continue;
    const kind: ReplayEntry["kind"] = text.startsWith("— Turn")
      ? "turn"
      : text.startsWith("🏆") || text.toLowerCase().includes("ended in a tie")
        ? "result"
        : "event";
    out.push({ text, kind });
  }
  return out;
}
