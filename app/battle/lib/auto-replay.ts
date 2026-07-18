// Turns a stored Auto Battle game's raw protocol lines into a sequence of turn "frames" that a
// visual viewer can step through — each frame carries the reconstructed board (what's on the field,
// HP, status, fainted), each side's roster, and that turn's event log. Reuses the Battle tab's pure
// line formatter (protocol.ts) so board reconstruction and wording stay a single source of truth.

import { describeLine, emptyBoard, type ActiveMon, type BoardState } from "./protocol";

export interface ReplayEntry {
  text: string;
  kind: "turn" | "result" | "event"; // for styling turn dividers and the win/tie line
}

export interface RosterEntry {
  name: string;
  fainted: boolean;
}

export interface ReplayFrame {
  turn: number; // 0 = the lead (before turn 1), then 1..N
  board: BoardState; // field state at the end of this turn
  blue: RosterEntry[]; // p1's brought Pokémon seen so far
  red: RosterEntry[]; // p2's brought Pokémon seen so far
  events: ReplayEntry[]; // what happened during this turn, in words
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

function toEntry(desc: string): ReplayEntry {
  const text = relabel(desc).replace(/^\n/, "").trim();
  const kind: ReplayEntry["kind"] = text.startsWith("— Turn")
    ? "turn"
    : text.startsWith("🏆") || text.toLowerCase().includes("ended in a tie")
      ? "result"
      : "event";
  return { text, kind };
}

const baseName = (raw: string) => (raw || "").split(",")[0].trim();

function sideSlot(ident: string): { side: "p1" | "p2"; slot: number } {
  const pos = ident || "";
  return { side: pos.slice(0, 2) === "p2" ? "p2" : "p1", slot: pos.charAt(2) === "b" ? 1 : 0 };
}

function cloneBoard(b: BoardState): BoardState {
  const cloneSlot = (m: ActiveMon | null) => (m ? { ...m } : null);
  return { p1: b.p1.map(cloneSlot), p2: b.p2.map(cloneSlot) };
}

/** Break a game's protocol lines into per-turn frames for the visual replay viewer. */
export function buildReplayFrames(lines: string[]): ReplayFrame[] {
  const board = emptyBoard();
  // Rosters tracked by base species (mega renames the field mon, not the roster entry).
  const order = { p1: [] as string[], p2: [] as string[] };
  const fainted = { p1: new Set<string>(), p2: new Set<string>() };
  const slotName: { p1: (string | null)[]; p2: (string | null)[] } = { p1: [null, null], p2: [null, null] };

  const frames: ReplayFrame[] = [];
  let curTurn = 0;
  let events: ReplayEntry[] = [];

  const roster = (side: "p1" | "p2"): RosterEntry[] =>
    order[side].map((name) => ({ name, fainted: fainted[side].has(name) }));

  const pushFrame = () => {
    frames.push({ turn: curTurn, board: cloneBoard(board), blue: roster("p1"), red: roster("p2"), events });
    events = [];
  };

  for (const line of lines) {
    if (line.startsWith("|turn|")) {
      pushFrame(); // close the turn (or the lead) that just finished
      curTurn = parseInt(line.split("|")[2], 10) || curTurn + 1;
      continue;
    }

    if (line.startsWith("|switch|") || line.startsWith("|drag|")) {
      const parts = line.split("|");
      const { side, slot } = sideSlot(parts[2]);
      const name = baseName(parts[3] || "");
      slotName[side][slot] = name;
      if (name && !order[side].includes(name)) order[side].push(name);
    } else if (line.startsWith("|swap|")) {
      // Keep slot→species in step with a position swap so a later faint is attributed correctly.
      const parts = line.split("|");
      const { side, slot } = sideSlot(parts[2]);
      const target = parseInt(parts[3], 10);
      if (!Number.isNaN(target) && target !== slot) {
        [slotName[side][slot], slotName[side][target]] = [slotName[side][target], slotName[side][slot]];
      }
    } else if (line.startsWith("|faint|")) {
      const { side, slot } = sideSlot(line.split("|")[2]);
      const name = slotName[side][slot];
      if (name) fainted[side].add(name);
    }

    const desc = describeLine(line, board);
    if (desc) events.push(toEntry(desc));
  }

  pushFrame(); // final turn (carries the win/tie line)
  return frames;
}
