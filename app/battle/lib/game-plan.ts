// Blue's game-plan data + rendering. This module is intentionally dependency-free (no @pkmn,
// no engine) so the Auto Battle page and the flowchart page can import the encoder/renderer
// without pulling the Showdown engine into their initial bundle. The heavy analysis that
// derives a PlanData from a run lives in game-plan-analyze.ts (loaded only inside auto-engine).

export interface PlanThreat {
  species: string; // Red Pokémon to prioritize
  move: string; // the strongest move Blue saw it use
}

export interface LeadStat {
  mons: string[]; // the two Pokémon led
  winPct: number; // Blue's win rate with / against this lead
  games: number;
}

export interface RedLeadPlan {
  lead: string[]; // the two Red led with
  winPct: number; // Blue's win rate when facing this lead
  games: number;
  response: string; // how Blue should answer it (derived)
}

export interface PlanData {
  blueTeam: string; // Blue team label
  redTeam: string; // Red team label
  games: number;
  blueWins: number;
  redWins: number;
  winPct: number; // Blue's share of decided games (0..100)
  archetype: "Trick Room" | "Tailwind" | "Tempo";
  winCondition: string; // the general game plan
  selection: string[]; // the best-win-rate 4-of-6 Blue brought
  selectionWinPct: number;
  selectionGames: number;
  lead: { mons: string[]; reason: string }; // suggested lead + why (from team shape)
  bestLead: LeadStat | null; // Blue's highest win-rate lead in the data
  vsRedLeads: RedLeadPlan[]; // what to do against Red's most common leads
  threats: PlanThreat[];
}

// ---- Rendering (pure) ------------------------------------------------------------------------

const esc = (s: string) => s.replace(/"/g, "'"); // keep labels safe inside quoted mermaid nodes
const L = (s: string) => `"${esc(s)}"`;

export function planToMermaid(p: PlanData): string {
  // Guard against a plan shape missing fields (e.g. from an older encoded link).
  const selection = p.selection ?? [];
  const threats = p.threats ?? [];
  const vsRedLeads = p.vsRedLeads ?? [];
  const lead = p.lead ?? { mons: [] as string[], reason: "" };
  const winCondition = p.winCondition ?? "Trade efficiently and keep more Pokémon on the board.";

  const bring = selection.length ? selection.join(", ") : "your best four";
  const leadTxt = p.bestLead?.mons.length
    ? p.bestLead.mons.join(" + ")
    : lead.mons.join(" + ") || "your two strongest";
  const leadWin = p.bestLead ? ` — wins ${p.bestLead.winPct}% (${p.bestLead.games} games)` : "";
  const threatList = threats.length
    ? threats.map((t) => `${t.species}${t.move ? ` (${t.move})` : ""}`).join(" · ")
    : "the opponent's biggest attacker";
  const speedTool = p.archetype === "Tempo" ? "your speed control" : p.archetype;

  const n: string[] = ["flowchart TD"];
  n.push(`  WC([${L(`Win condition:<br/>${p.winCondition}`)}]) --> Bring`);
  n.push(
    `  Bring[${L(`Bring these 4:<br/>${bring}<br/>(${p.selectionWinPct}% win rate over ${p.selectionGames} games)`)}] --> Lead`
  );
  n.push(`  Lead[${L(`Lead: ${leadTxt}${leadWin}<br/>${lead.reason}`)}]`);

  if (vsRedLeads.length) {
    n.push(`  Lead --> RedLead`);
    n.push(`  RedLead{${L("Read Red's lead")}}`);
    vsRedLeads.forEach((r, i) => {
      n.push(`  RedLead -->|${L(`${r.lead.join(" + ")} — Blue ${r.winPct}%`)}| RL${i}`);
      n.push(`  RL${i}[${L(r.response)}] --> Turn`);
    });
    n.push(`  RedLead -->|${L("anything else")}| Turn`);
  } else {
    n.push(`  Lead --> Turn`);
  }

  n.push(`  Turn{{${L("General plan — each turn, in order")}}} --> Q1`);
  n.push(`  Q1{${L(`Is a top Red threat on the field?<br/>${threatList}`)}}`);
  n.push(`  Q1 -->|Yes| A1[${L("Gang up and KO it first — best super-effective move from both slots")}]`);
  n.push(`  Q1 -->|No| Q2`);
  n.push(`  Q2{${L("Can you secure a KO this turn?")}}`);
  n.push(`  Q2 -->|Yes| A2[${L("Take the KO — remove the most dangerous target first")}]`);
  n.push(`  Q2 -->|No| Q3`);
  n.push(`  Q3{${L(`Behind on speed with ${speedTool} available?`)}}`);
  n.push(`  Q3 -->|Yes| A3[${L(`Set ${speedTool} to flip the speed war in your favor`)}]`);
  n.push(`  Q3 -->|No| Q4`);
  n.push(`  Q4{${L("Under pressure with Protect / Fake Out / redirection up?")}}`);
  n.push(`  Q4 -->|Yes| A4[${L("Buy tempo — Protect the threatened mon, Fake Out or redirect their key attacker")}]`);
  n.push(`  Q4 -->|No| A5[${L("Otherwise: deal the most damage to the most dangerous target")}]`);
  for (const a of ["A1", "A2", "A3", "A4", "A5"]) n.push(`  ${a} --> Loop`);
  n.push(`  Loop([${L("Repeat until the last Red Pokémon faints")}])`);
  return n.join("\n");
}

export function planToBullets(p: PlanData): string[] {
  const selection = p.selection ?? [];
  const threats = p.threats ?? [];
  const vsRedLeads = p.vsRedLeads ?? [];
  const lead = p.lead ?? { mons: [] as string[], reason: "" };
  const out: string[] = [];
  out.push(`Game plan: ${p.winCondition ?? "Trade efficiently and keep more Pokémon on the board."}`);
  if (selection.length) {
    out.push(
      `Bring ${selection.join(", ")} — your best selection at a ${p.selectionWinPct}% win rate over ${p.selectionGames.toLocaleString()} games.`
    );
  }
  if (p.bestLead?.mons.length) {
    out.push(
      `Lead ${p.bestLead.mons.join(" + ")} — Blue's strongest lead at ${p.bestLead.winPct}% over ${p.bestLead.games.toLocaleString()} games.`
    );
  } else if (lead.mons.length) {
    out.push(`Lead ${lead.mons.join(" + ")}: ${lead.reason}`);
  }
  for (const r of vsRedLeads) {
    out.push(`vs Red's ${r.lead.join(" + ")} (Blue ${r.winPct}% over ${r.games.toLocaleString()}): ${r.response}`);
  }
  if (threats.length) {
    out.push(
      `Prioritize KO-ing ${threats.map((t) => `${t.species}${t.move ? ` (${t.move})` : ""}`).join(", ")} — the threats Blue learned hurt most.`
    );
  }
  out.push("Every turn: threats first, then guaranteed KOs, then speed control, then tempo tools, else max damage.");
  return out;
}

// ---- URL encode / decode (browser btoa/atob, UTF-8 safe) -------------------------------------

export function encodePlan(p: PlanData): string {
  const json = JSON.stringify(p);
  return encodeURIComponent(btoa(unescape(encodeURIComponent(json))));
}

export function decodePlan(s: string): PlanData | null {
  try {
    const json = decodeURIComponent(escape(atob(decodeURIComponent(s))));
    return normalizePlan(JSON.parse(json));
  } catch {
    return null;
  }
}

// Backfill every field so a plan encoded by an older version (missing winCondition / bestLead /
// vsRedLeads, etc.) still renders instead of crashing the page.
function normalizePlan(p: any): PlanData {
  const arr = <T,>(v: any): T[] => (Array.isArray(v) ? v : []);
  const archetype: PlanData["archetype"] =
    p?.archetype === "Trick Room" || p?.archetype === "Tailwind" ? p.archetype : "Tempo";
  return {
    blueTeam: p?.blueTeam ?? "Blue",
    redTeam: p?.redTeam ?? "Red",
    games: p?.games ?? 0,
    blueWins: p?.blueWins ?? 0,
    redWins: p?.redWins ?? 0,
    winPct: p?.winPct ?? 0,
    archetype,
    winCondition:
      p?.winCondition ??
      "Trade efficiently — remove Red's biggest threats and keep more Pokémon on the board.",
    selection: arr<string>(p?.selection),
    selectionWinPct: p?.selectionWinPct ?? 0,
    selectionGames: p?.selectionGames ?? 0,
    lead: p?.lead && Array.isArray(p.lead.mons) ? p.lead : { mons: [], reason: "" },
    bestLead: p?.bestLead && Array.isArray(p.bestLead.mons) ? p.bestLead : null,
    vsRedLeads: arr<RedLeadPlan>(p?.vsRedLeads),
    threats: arr<PlanThreat>(p?.threats),
  };
}
