// Converts Pokémon Showdown battle-protocol lines into human-readable text and
// tracks the on-field state. Supports singles and doubles (two active slots per side).
// See pokemon-showdown/sim/SIM-PROTOCOL.md (vendored) for the full spec.

export interface StatBlock {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
  level: number;
  tera: string;
}

export interface ActiveMon {
  name: string;
  hpPct: number;
  status: string;
  fainted: boolean;
  item: string; // filled in by the engine from the known team lists
  ability: string; // filled in by the engine from the known team lists
  stats?: StatBlock; // player's own field mons only
}

// Each side has up to two active slots: index 0 = "a", 1 = "b" (only 0 used in singles).
export interface BoardState {
  p1: (ActiveMon | null)[];
  p2: (ActiveMon | null)[];
}

export function emptyBoard(): BoardState {
  return { p1: [null, null], p2: [null, null] };
}

// "p1a: Great Tusk" -> { side: "p1", slot: 0, name: "Great Tusk" }
function parseIdent(raw: string): { side: "p1" | "p2"; slot: number; name: string } {
  const [pos, ...rest] = raw.split(": ");
  const side = pos.slice(0, 2) as "p1" | "p2";
  const slot = pos.charAt(2) === "b" ? 1 : 0;
  return { side, slot, name: rest.join(": ") || pos };
}

// "184/240", "52/100 par", "0 fnt" -> percent + status
function parseCondition(cond: string): { hpPct: number; status: string; fainted: boolean } {
  const [hpPart, status = ""] = cond.trim().split(" ");
  if (hpPart === "0" || status === "fnt") return { hpPct: 0, status: "fnt", fainted: true };
  const [cur, max] = hpPart.split("/").map((n) => parseInt(n, 10));
  const hpPct = max ? Math.round((cur / max) * 100) : 0;
  return { hpPct, status, fainted: false };
}

const who = (side: "p1" | "p2") => (side === "p1" ? "Your" : "Foe");

export function describeLine(line: string, board: BoardState): string | null {
  if (!line.startsWith("|")) return null;
  const parts = line.slice(1).split("|");
  const cmd = parts[0];

  const setActive = (identRaw: string, cond?: string) => {
    const { side, slot, name } = parseIdent(identRaw);
    const base: ActiveMon = { name, hpPct: 100, status: "", fainted: false, item: "", ability: "" };
    board[side][slot] = cond ? { ...base, ...parseCondition(cond) } : base;
    return { side, slot, name };
  };
  const updateHp = (identRaw: string, cond: string) => {
    const { side, slot, name } = parseIdent(identRaw);
    const c = parseCondition(cond);
    const prev = board[side][slot];
    board[side][slot] = {
      name,
      item: prev?.item ?? "",
      ability: prev?.ability ?? "",
      hpPct: c.hpPct,
      status: c.status,
      fainted: c.fainted,
    };
    return { side, slot, name, ...c };
  };

  switch (cmd) {
    case "player":
    case "teamsize":
    case "gametype":
    case "gen":
    case "tier":
    case "rule":
    case "start":
    case "-end":
    case "-sethp":
      if (cmd === "-sethp") updateHp(parts[1], parts[2]);
      return null;
    case "switch":
    case "drag": {
      const { side, name } = setActive(parts[1], parts[3]);
      const verb = cmd === "drag" ? "was dragged out" : "sent out";
      return side === "p1" ? `You ${verb} ${name}!` : `Foe ${verb} ${name}!`;
    }
    case "replace": {
      const { side, name } = setActive(parts[1], parts[3]);
      return `${who(side)} ${name} was revealed!`;
    }
    case "swap": {
      // Ally Switch (and similar) physically swap two active slots — follow it so each mon keeps
      // its true field position instead of desyncing from later slot-addressed lines.
      const { side, slot } = parseIdent(parts[1]);
      const target = parseInt(parts[2], 10);
      if (!Number.isNaN(target) && target !== slot && board[side][target] !== undefined) {
        const tmp = board[side][slot];
        board[side][slot] = board[side][target];
        board[side][target] = tmp;
      }
      return null;
    }
    case "detailschange":
    case "-formechange": {
      // Mega Evolution / forme change: rename the on-field mon so its card + sprite update.
      const { side, slot } = parseIdent(parts[1]);
      const newName = (parts[2] || "").split(",")[0].trim();
      if (board[side][slot] && newName) board[side][slot] = { ...board[side][slot]!, name: newName };
      return null;
    }
    case "-mega": {
      const { side, name } = parseIdent(parts[1]);
      return `${side === "p1" ? name : "Foe " + name} Mega Evolved!`;
    }
    case "move": {
      const { side, name } = parseIdent(parts[1]);
      return `${side === "p1" ? name : "Foe " + name} used ${parts[2]}!`;
    }
    case "-damage": {
      const { side, name, hpPct, fainted } = updateHp(parts[1], parts[2]);
      if (fainted) return null;
      return `${who(side)} ${name} is at ${hpPct}% HP.`;
    }
    case "-heal": {
      const { side, name, hpPct } = updateHp(parts[1], parts[2]);
      return `${who(side)} ${name} restored HP (${hpPct}%).`;
    }
    case "faint": {
      const { side, slot, name } = parseIdent(parts[1]);
      const prev = board[side][slot];
      if (prev) board[side][slot] = { ...prev, hpPct: 0, fainted: true, status: "fnt" };
      return `${who(side)} ${name} fainted!`;
    }
    case "-status": {
      const { side, slot, name } = parseIdent(parts[1]);
      if (board[side][slot]) board[side][slot] = { ...board[side][slot]!, status: parts[2] };
      const label: Record<string, string> = {
        brn: "was burned", par: "was paralyzed", psn: "was poisoned",
        tox: "was badly poisoned", slp: "fell asleep", frz: "was frozen solid",
      };
      return `${who(side)} ${name} ${label[parts[2]] ?? "was afflicted with " + parts[2]}!`;
    }
    case "-curestatus": {
      const { side, slot, name } = parseIdent(parts[1]);
      if (board[side][slot]) board[side][slot] = { ...board[side][slot]!, status: "" };
      return `${who(side)} ${name} recovered.`;
    }
    case "-supereffective":
      return "It's super effective!";
    case "-resisted":
      return "It's not very effective...";
    case "-immune": {
      const { side, name } = parseIdent(parts[1]);
      return `It doesn't affect ${side === "p1" ? "your" : "the foe's"} ${name}...`;
    }
    case "-crit":
      return "A critical hit!";
    case "-miss": {
      const { side, name } = parseIdent(parts[1] || "");
      return parts[1] ? `${who(side)} ${name}'s attack missed!` : "The attack missed!";
    }
    case "-fail":
      return "But it failed!";
    case "-terastallize": {
      const { side, name } = parseIdent(parts[1]);
      return `${who(side)} ${name} Terastallized into ${parts[2]}!`;
    }
    case "-boost":
    case "-unboost": {
      const { side, name } = parseIdent(parts[1]);
      const dir = cmd === "-boost" ? "rose" : "fell";
      const amt = parseInt(parts[3], 10) > 1 ? " sharply" : "";
      return `${who(side)} ${name}'s ${statName(parts[2])} ${dir}${amt}!`;
    }
    case "-ability": {
      const { side, name } = parseIdent(parts[1]);
      return `[${who(side)} ${name}'s ${parts[2]}]`;
    }
    case "-item": {
      const { side, slot, name } = parseIdent(parts[1]);
      if (board[side][slot]) board[side][slot] = { ...board[side][slot]!, item: parts[2] };
      return `${who(side)} ${name}'s ${parts[2]} activated.`;
    }
    case "-enditem": {
      const { side, name } = parseIdent(parts[1]);
      return `${who(side)} ${name}'s ${parts[2]} was used up.`;
    }
    case "-weather":
      return parts[1] && parts[1] !== "none" ? `The weather is ${parts[1]}.` : null;
    case "-fieldstart":
      return parts[1] ? `${cleanEffect(parts[1])} took effect.` : null;
    case "-fieldend":
      return parts[1] ? `${cleanEffect(parts[1])} ended.` : null;
    case "-sidestart": {
      const side = (parts[1] || "").slice(0, 2);
      return `${cleanEffect(parts[2])} set on ${side === "p1" ? "your" : "the foe's"} side.`;
    }
    case "-activate":
      return parts[2] ? `${cleanEffect(parts[2])} activated.` : null;
    case "-start": {
      const { side, name } = parseIdent(parts[1]);
      return `${who(side)} ${name}: ${cleanEffect(parts[2])}.`;
    }
    case "cant": {
      const { side, name } = parseIdent(parts[1]);
      return `${who(side)} ${name} couldn't move!`;
    }
    case "turn":
      return `\n— Turn ${parts[1]} —`;
    case "win":
      return `\n🏆 ${parts[1]} won the battle!`;
    case "tie":
      return "\nThe battle ended in a tie.";
    case "-hitcount":
      return `Hit ${parts[2]} time(s)!`;
    case "-clearallboost":
    case "-clearboost":
      return "Stat changes were cleared.";
    default:
      return null;
  }
}

function statName(id: string): string {
  const map: Record<string, string> = {
    atk: "Attack", def: "Defense", spa: "Sp. Atk", spd: "Sp. Def",
    spe: "Speed", accuracy: "accuracy", evasion: "evasiveness",
  };
  return map[id] ?? id;
}

function cleanEffect(raw: string): string {
  return raw.replace(/^(move: |ability: |item: |condition: )/, "").trim();
}
