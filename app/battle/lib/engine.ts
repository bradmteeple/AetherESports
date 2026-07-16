// Client-side battle driver: runs a real Pokémon Showdown battle in the browser.
//
// Uses @pkmn/sim (Showdown's battle engine, repackaged for bundlers) + @pkmn/randoms
// (random-battle team generators). Supports singles (Gen 9 Random Battle) and doubles
// with team preview (VGC 2025 Reg I). Mechanics are identical to the games.

import "./node-shim"; // must precede any @pkmn import — defines Node globals for the browser
import { BattleStreams, Teams, RandomPlayerAI, Dex, toID } from "@pkmn/sim";
import { TeamGenerators } from "@pkmn/randoms";
import { describeLine, emptyBoard, type BoardState } from "./protocol";
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
  fainted: boolean;
  active: boolean;
}

export interface PreviewMon {
  slot: number; // 1-based
  name: string;
  item: string;
}

export type Prompt = "move" | "switch" | "teampreview" | "wait" | "none";

export interface BattleSnapshot {
  format: FormatKey;
  gametype: "singles" | "doubles";
  requestId: number; // increments each new actionable request (UI reset key)
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

export class BattleController {
  private streams: ReturnType<typeof BattleStreams.getPlayerStreams>;
  private destroyed = false;
  private snapshot: BattleSnapshot;
  private onUpdate: (s: BattleSnapshot) => void;
  private def: FormatDef;
  private itemMap: { p1: Record<string, string>; p2: Record<string, string> } = { p1: {}, p2: {} };

  constructor(format: FormatKey, onUpdate: (s: BattleSnapshot) => void) {
    this.def = FORMATS[format];
    this.onUpdate = onUpdate;
    this.snapshot = {
      format,
      gametype: this.def.gametype,
      requestId: 0,
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
    // Reveal held items on the field for BOTH sides from the known team lists.
    for (const side of ["p1", "p2"] as const) {
      for (const mon of this.snapshot.board[side]) {
        if (mon) mon.item = this.itemMap[side][toID(mon.name)] ?? mon.item ?? "";
      }
    }
    this.onUpdate({ ...this.snapshot, log: [...this.snapshot.log] });
  }

  private pushLog(line: string) {
    this.snapshot.log.push(line);
  }

  private teamsFor(): { p1: string; p2: string; p1Sets: any[]; p2Sets: any[] } {
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

  private buildItemMap(p1Sets: any[], p2Sets: any[]) {
    for (const [side, sets] of [["p1", p1Sets], ["p2", p2Sets]] as const) {
      const map: Record<string, string> = {};
      for (const set of sets) {
        const item = itemName(set.item);
        const sp = Dex.species.get(set.species || set.name);
        // Key by full forme AND base species: on-field names for formes like
        // Landorus-Therian display as the base "Landorus".
        for (const key of [set.species, set.name, sp.name, sp.baseSpecies]) {
          if (key) map[toID(key)] = item;
        }
      }
      this.itemMap[side] = map;
    }
  }

  private start() {
    const { p1, p2, p1Sets, p2Sets } = this.teamsFor();
    this.buildItemMap(p1Sets, p2Sets);

    const ai = new RandomPlayerAI(this.streams.p2);
    void ai.start();
    void this.readPlayerStream();

    const spec = { formatid: this.def.engineFormat };
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
          if (line.startsWith("|request|")) {
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

    // Bench / switch options (shared) — includes item info for the player's team.
    this.snapshot.switches = (side?.pokemon ?? []).map((p: any, i: number) => {
      const c = parseCond(p.condition ?? "0/0");
      return {
        slot: i + 1,
        name: cleanName(p.details ?? p.ident ?? "?"),
        hpPct: c.hpPct,
        status: c.status,
        item: itemName(p.item),
        fainted: c.fainted,
        active: !!p.active,
      };
    });

    if (req.teamPreview) {
      this.snapshot.prompt = "teampreview";
      this.snapshot.previewPick = req.maxChosenTeamSize ?? this.def.teamSize;
      this.snapshot.preview = (side?.pokemon ?? []).map((p: any, i: number) => ({
        slot: i + 1,
        name: cleanName(p.details ?? p.ident ?? "?"),
        item: itemName(p.item),
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
