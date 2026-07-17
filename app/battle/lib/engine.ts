// Client-side battle driver: runs a real Pokémon Showdown battle in the browser.
//
// Uses @pkmn/sim (Showdown's battle engine, repackaged for bundlers) + @pkmn/randoms
// (random-battle team generators). Supports singles (Gen 9 Random Battle) and doubles
// with team preview (VGC 2025 Reg I). Mechanics are identical to the games.

import "./node-shim"; // must precede any @pkmn import — defines Node globals for the browser
import { BattleStreams, Teams, Dex, toID } from "@pkmn/sim";
import { TeamGenerators } from "@pkmn/randoms";
import { ReasoningAI, AdaptiveAI } from "./ai";
import { describeLine, emptyBoard, type BoardState, type StatBlock } from "./protocol";
import { FORMATS, type FormatDef, type FormatKey } from "./formats";

Teams.setGeneratorFactory(TeamGenerators);

export interface MoveOption {
  slot: number; // 1-based move index ("move 1")
  name: string;
  pp: number;
  maxpp: number;
  target: string; // sim target type, e.g. "normal", "allAdjacentFoes"
  disabled: boolean;
}

export interface ActiveSlot {
  fainted: boolean;
  trapped: boolean;
  canTera: boolean;
  moves: MoveOption[];
}

export interface SwitchOption {
  slot: number; // 1-based team slot ("switch 3")
  name: string;
  hpPct: number;
  status: string;
  item: string;
  ability: string;
  fainted: boolean;
  active: boolean;
  stats?: StatBlock;
}

export interface PreviewMon {
  slot: number; // 1-based
  name: string;
  item: string;
  ability: string;
  stats?: StatBlock;
}

export type Prompt = "move" | "switch" | "teampreview" | "wait" | "none";

export interface BattleSnapshot {
  format: FormatKey;
  gametype: "singles" | "doubles";
  requestId: number; // increments each new actionable request (UI reset key)
  teamStats: Record<string, StatBlock>; // player's team, keyed by species id
  aiReasons: string[]; // Rival AI's reasoning for the most recently completed turn
  log: string[];
  board: BoardState;
  prompt: Prompt;
  active: ActiveSlot[]; // one entry per active slot (move prompt)
  forceSwitch: boolean[]; // which slots must switch (switch prompt)
  switches: SwitchOption[]; // the bench (shared across slots)
  preview: PreviewMon[]; // team-preview options
  previewPick: number; // how many to bring
  ended: boolean;
  winner: string | null;
}

const itemName = (raw: string | undefined): string => {
  if (!raw) return "";
  const it = Dex.items.get(raw);
  return it.exists ? it.name : String(raw);
};

const abilityName = (raw: string | undefined): string => {
  if (!raw) return "";
  const a = Dex.abilities.get(raw);
  return a.exists ? a.name : String(raw);
};

// Build a StatBlock from a request's side.pokemon entry (player's own team).
function statBlockFrom(p: any): StatBlock | undefined {
  if (!p?.stats) return undefined;
  const maxhp = parseInt(String(p.condition ?? "").split(" ")[0].split("/")[1] ?? "0", 10) || 0;
  const lm = /,\s*L(\d+)/.exec(String(p.details ?? ""));
  return {
    hp: maxhp,
    atk: p.stats.atk ?? 0,
    def: p.stats.def ?? 0,
    spa: p.stats.spa ?? 0,
    spd: p.stats.spd ?? 0,
    spe: p.stats.spe ?? 0,
    level: lm ? parseInt(lm[1], 10) : 100,
    tera: p.teraType ?? "",
  };
}

export interface CustomTeam {
  aiTeam?: string; // packed team the Rival AI (p2) uses, if one was pasted
  playerTeam?: string; // packed team the human (p1) uses, if one was pasted
  doubles: boolean;
}

export class BattleController {
  private streams: ReturnType<typeof BattleStreams.getPlayerStreams>;
  private destroyed = false;
  private snapshot: BattleSnapshot;
  private onUpdate: (s: BattleSnapshot) => void;
  private def: FormatDef;
  private itemMap: { p1: Record<string, string>; p2: Record<string, string> } = { p1: {}, p2: {} };
  private abilityMap: { p1: Record<string, string>; p2: Record<string, string> } = { p1: {}, p2: {} };
  private reasonsByTurn: Record<number, string[]> = {};
  private maxTurn = 0;

  private level: number;
  private custom?: CustomTeam;

  constructor(
    format: FormatKey,
    level: number,
    onUpdate: (s: BattleSnapshot) => void,
    custom?: CustomTeam
  ) {
    this.def = FORMATS[format];
    this.level = level;
    this.onUpdate = onUpdate;
    this.custom = custom;
    this.snapshot = {
      format,
      gametype: custom ? (custom.doubles ? "doubles" : "singles") : this.def.gametype,
      requestId: 0,
      teamStats: {},
      aiReasons: [],
      log: [],
      board: emptyBoard(),
      prompt: "none",
      active: [],
      forceSwitch: [],
      switches: [],
      preview: [],
      previewPick: this.def.teamSize,
      ended: false,
      winner: null,
    };
    this.streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
    this.start();
  }

  private emit() {
    if (this.destroyed) return;
    // Reveal held items + abilities on the field for BOTH sides from the known team lists.
    for (const side of ["p1", "p2"] as const) {
      for (const mon of this.snapshot.board[side]) {
        if (!mon) continue;
        mon.item = this.itemMap[side][toID(mon.name)] ?? mon.item ?? "";
        mon.ability = this.abilityMap[side][toID(mon.name)] ?? mon.ability ?? "";
      }
    }
    // Attach stats to the player's own field mons (foe stats are unknown).
    for (const mon of this.snapshot.board.p1) {
      if (mon) mon.stats = this.snapshot.teamStats[toID(mon.name)];
    }
    // Expose only the most-recently-COMPLETED turn's reasoning, so the human never sees
    // the Rival AI's upcoming move before locking in their own.
    const completedTurn = this.snapshot.ended ? this.maxTurn : this.maxTurn - 1;
    this.snapshot.aiReasons = this.reasonsByTurn[completedTurn] ?? [];
    this.onUpdate({ ...this.snapshot, log: [...this.snapshot.log] });
  }

  private pushLog(line: string) {
    this.snapshot.log.push(line);
  }

  // Effective engine format: a custom AI team plays under a no-validation Custom Game.
  // Team Preview is disabled so the battle starts straight away with default lead order.
  private engineFormatId(): string {
    if (this.custom) {
      return this.custom.doubles
        ? "gen9doublescustomgame@@@!Team Preview"
        : "gen9customgame@@@!Team Preview";
    }
    return this.def.engineFormat;
  }

  private teamsFor(): { p1: string; p2: string; p1Sets: any[]; p2Sets: any[] } {
    if (this.custom) {
      // Either side may bring a pasted team; a side without one gets an auto team.
      const p1Sets = this.custom.playerTeam
        ? Teams.unpack(this.custom.playerTeam) ?? []
        : Teams.generate("gen9randombattle");
      const p2Sets = this.custom.aiTeam
        ? Teams.unpack(this.custom.aiTeam) ?? []
        : Teams.generate("gen9randombattle");
      const p1 = this.custom.playerTeam ?? Teams.pack(p1Sets);
      const p2 = this.custom.aiTeam ?? Teams.pack(p2Sets);
      return { p1, p2, p1Sets, p2Sets };
    }
    if (this.def.packedTeams?.length) {
      const pool = this.def.packedTeams;
      const i = Math.floor(Math.random() * pool.length);
      const j = pool.length > 1 ? (i + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length : i;
      const p1Sets = Teams.unpack(pool[i]) ?? [];
      const p2Sets = Teams.unpack(pool[j]) ?? [];
      return { p1: pool[i], p2: pool[j], p1Sets, p2Sets };
    }
    const p1Sets = Teams.generate(this.def.engineFormat);
    const p2Sets = Teams.generate(this.def.engineFormat);
    return { p1: Teams.pack(p1Sets), p2: Teams.pack(p2Sets), p1Sets, p2Sets };
  }

  private buildTeamMaps(p1Sets: any[], p2Sets: any[]) {
    for (const [side, sets] of [["p1", p1Sets], ["p2", p2Sets]] as const) {
      const items: Record<string, string> = {};
      const abilities: Record<string, string> = {};
      for (const set of sets) {
        const item = itemName(set.item);
        const ability = abilityName(set.ability);
        const sp = Dex.species.get(set.species || set.name);
        // Key by full forme AND base species: on-field names for formes like
        // Landorus-Therian display as the base "Landorus".
        for (const key of [set.species, set.name, sp.name, sp.baseSpecies]) {
          if (!key) continue;
          items[toID(key)] = item;
          abilities[toID(key)] = ability;
        }
      }
      this.itemMap[side] = items;
      this.abilityMap[side] = abilities;
    }
  }

  private start() {
    const { p1, p2, p1Sets, p2Sets } = this.teamsFor();
    this.buildTeamMaps(p1Sets, p2Sets);

    const onReason = (turn: number, reasons: string[]) => {
      // Accumulate a turn's reasons (moves + any mid-turn forced switch), de-duplicated.
      const merged = [...(this.reasonsByTurn[turn] ?? []), ...reasons];
      this.reasonsByTurn[turn] = Array.from(new Set(merged));
      this.emit();
    };
    // Level 1 = weakened heuristic, Level 2 = full heuristic, Level 3 = adaptive (learns).
    const ai =
      this.level >= 3
        ? new AdaptiveAI(this.streams.p2, onReason)
        : new ReasoningAI(this.streams.p2, onReason, { mistakeRate: this.level <= 1 ? 0.5 : 0 });
    void ai.start();
    void this.readPlayerStream();

    const spec = { formatid: this.engineFormatId() };
    const p1spec = { name: "You", team: p1 };
    const p2spec = { name: "Rival AI", team: p2 };

    void this.streams.omniscient.write(
      `>start ${JSON.stringify(spec)}\n` +
        `>player p1 ${JSON.stringify(p1spec)}\n` +
        `>player p2 ${JSON.stringify(p2spec)}`
    );
  }

  private async readPlayerStream() {
    try {
      for await (const chunk of this.streams.p1) {
        if (this.destroyed) return;
        for (const line of chunk.split("\n")) {
          if (line.startsWith("|turn|")) {
            this.maxTurn = parseInt(line.slice("|turn|".length), 10) || this.maxTurn;
            const text = describeLine(line, this.snapshot.board);
            if (text) this.pushLog(text);
          } else if (line.startsWith("|request|")) {
            this.handleRequest(line.slice("|request|".length));
          } else if (line.startsWith("|error|")) {
            this.pushLog(`⚠️ ${line.slice("|error|".length)}`);
            // Re-open the last request so the player can choose again.
            if (this.lastRequest) this.handleRequest(this.lastRequest);
          } else if (line.startsWith("|win|")) {
            this.snapshot.winner = line.slice("|win|".length).trim();
            this.snapshot.ended = true;
            this.snapshot.prompt = "none";
            const text = describeLine(line, this.snapshot.board);
            if (text) this.pushLog(text);
          } else if (line === "|tie" || line.startsWith("|tie|")) {
            this.snapshot.ended = true;
            this.snapshot.prompt = "none";
            this.pushLog("The battle ended in a tie.");
          } else {
            const text = describeLine(line, this.snapshot.board);
            if (text) this.pushLog(text);
          }
        }
        this.emit();
      }
    } catch {
      // stream torn down on reset — ignore
    }
  }

  private lastRequest: string | null = null;
  private reqCounter = 0;

  private handleRequest(json: string) {
    this.snapshot.active = [];
    this.snapshot.forceSwitch = [];
    this.snapshot.preview = [];
    if (!json) {
      this.lastRequest = null;
      this.snapshot.prompt = "wait";
      this.snapshot.switches = [];
      return;
    }
    this.lastRequest = json;
    this.snapshot.requestId = ++this.reqCounter;
    const req = JSON.parse(json);
    const side = req.side;

    // Update the player's team stat sheet (keyed forme-safe, persisted across requests).
    for (const p of side?.pokemon ?? []) {
      const block = statBlockFrom(p);
      if (!block) continue;
      const sp = Dex.species.get(cleanName(p.details ?? p.ident ?? ""));
      for (const key of [cleanName(p.details ?? ""), sp.name, sp.baseSpecies]) {
        if (!key) continue;
        const id = toID(key);
        const prev = this.snapshot.teamStats[id];
        // Keep a previously-seen max HP if this snapshot has the mon fainted (hp 0).
        this.snapshot.teamStats[id] = { ...block, hp: block.hp || prev?.hp || 0 };
      }
    }
    const statFor = (p: any): StatBlock | undefined =>
      this.snapshot.teamStats[toID(cleanName(p.details ?? p.ident ?? ""))];

    // Bench / switch options (shared) — includes item + stats for the player's team.
    this.snapshot.switches = (side?.pokemon ?? []).map((p: any, i: number) => {
      const c = parseCond(p.condition ?? "0/0");
      return {
        slot: i + 1,
        name: cleanName(p.details ?? p.ident ?? "?"),
        hpPct: c.hpPct,
        status: c.status,
        item: itemName(p.item),
        ability: abilityName(p.baseAbility ?? p.ability),
        fainted: c.fainted,
        active: !!p.active,
        stats: statFor(p),
      };
    });

    if (req.teamPreview) {
      this.snapshot.prompt = "teampreview";
      this.snapshot.previewPick = req.maxChosenTeamSize ?? this.def.teamSize;
      this.snapshot.preview = (side?.pokemon ?? []).map((p: any, i: number) => ({
        slot: i + 1,
        name: cleanName(p.details ?? p.ident ?? "?"),
        item: itemName(p.item),
        ability: abilityName(p.baseAbility ?? p.ability),
        stats: statFor(p),
      }));
      return;
    }

    if (req.wait) {
      this.snapshot.prompt = "wait";
      return;
    }

    if (req.forceSwitch) {
      this.snapshot.prompt = "switch";
      this.snapshot.forceSwitch = req.forceSwitch.map((v: any) => !!v);
      return;
    }

    // Normal move request — one entry per active slot.
    this.snapshot.active = (req.active ?? []).map((a: any, i: number) => {
      const pk = side?.pokemon?.[i];
      const fainted = String(pk?.condition ?? "").endsWith(" fnt");
      const moves: MoveOption[] = (a?.moves ?? []).map((m: any, j: number) => ({
        slot: j + 1,
        name: m.move,
        pp: m.pp ?? 0,
        maxpp: m.maxpp ?? 0,
        target: m.target ?? "normal",
        disabled: !!m.disabled,
      }));
      return { fainted, trapped: !!a?.trapped, canTera: !!a?.canTerastallize, moves };
    });
    this.snapshot.prompt = "move";
  }

  /** Send the human player's full turn decision to the engine. */
  choose(choice: string) {
    if (this.destroyed || this.snapshot.ended) return;
    this.snapshot.prompt = "wait";
    this.emit();
    void this.streams.p1.write(choice);
  }

  destroy() {
    this.destroyed = true;
    try {
      void this.streams.omniscient.writeEnd();
    } catch {
      /* noop */
    }
  }
}

function parseCond(cond: string): { hpPct: number; status: string; fainted: boolean } {
  const [hpPart, status = ""] = String(cond).trim().split(" ");
  if (hpPart === "0" || status === "fnt") return { hpPct: 0, status: "fnt", fainted: true };
  const [cur, max] = hpPart.split("/").map((n) => parseInt(n, 10));
  const hpPct = max ? Math.round((cur / max) * 100) : 0;
  return { hpPct, status, fainted: false };
}

// "Pikachu, L84, M" / "Great Tusk" -> "Pikachu" / "Great Tusk"
function cleanName(details: string): string {
  return details.split(",")[0].trim();
}
