// Blue's game-plan data + rendering. This module is intentionally dependency-free (no @pkmn,
// no engine) so the Auto Battle page and the flowchart page can import the encoder/renderer
// without pulling the Showdown engine into their initial bundle. The heavy analysis that
// derives a PlanData from a run lives in game-plan-analyze.ts (loaded only inside auto-engine).

export interface PlanThreat {
  species: string; // Red Pokémon to prioritize
  move: string; // the strongest move Blue saw it use
}

// One decision branch off the lead: "IF <Red threat> is the danger → run this game plan".
// There should be one of these per MAJOR THREAT, and the flowchart adds an extra "else" branch
// for when no priority threat is up (or Red simply misplays).
export interface ThreatPlan {
  species: string; // the Red threat this branch answers
  move: string; // its strongest seen move (what to watch out for)
  answer: string; // the Blue Pokémon that best checks it
  answerFromBack: boolean; // true if that answer sits in the back and must be switched in
  plan: string; // the game plan for this branch, written to account for the back line
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
  back: string[]; // the brought Pokémon held in reserve (selection minus the lead)
  bestLead: LeadStat | null; // Blue's highest win-rate lead in the data
  vsRedLeads: RedLeadPlan[]; // what to do against Red's most common leads
  threats: PlanThreat[];
  threatPlans: ThreatPlan[]; // one branch per major threat (drives the branching flowchart)
}

// ---- Rendering (pure) ------------------------------------------------------------------------

const esc = (s: string) => s.replace(/"/g, "'"); // keep labels safe inside quoted mermaid nodes
const L = (s: string) => `"${esc(s)}"`;

// A branching game-plan flowchart: the lead/back sit at the top, and one branch fans out per
// MAJOR THREAT — "IF <threat> is the danger → run this plan (accounting for the back)" — plus an
// "else" branch for when no priority threat is up or Red simply misplays. This mirrors the
// hand-drawn scenario tree: as many branches from the lead as there are major threats, plus one.
export function planToMermaid(p: PlanData): string {
  // Guard against a plan shape missing fields (e.g. from an older encoded link).
  const selection = p.selection ?? [];
  const lead = p.lead ?? { mons: [] as string[], reason: "" };
  const back = p.back ?? [];
  const threatPlans = p.threatPlans ?? [];
  const threats = p.threats ?? [];
  const winCondition = p.winCondition ?? "Trade efficiently and keep more Pokémon on the board.";

  const leadTxt = lead.mons.length ? lead.mons.join(" + ") : "your two strongest";
  const backTxt = back.length
    ? back.join(" + ")
    : selection.filter((s) => !lead.mons.includes(s)).join(" + ") || "your other two";
  const speedTool = p.archetype === "Tempo" ? "your speed control / tempo tools" : p.archetype;

  // Fall back to the raw threat list if per-threat plans weren't computed (older encoded links).
  const branches: ThreatPlan[] = threatPlans.length
    ? threatPlans
    : threats.map((t) => ({
        species: t.species,
        move: t.move,
        answer: "",
        answerFromBack: false,
        plan: `Gang up and KO ${t.species}${t.move ? ` (watch ${t.move})` : ""} before it moves, then bring your back to clean up.`,
      }));

  const n: string[] = ["flowchart TD"];

  // Root: the lead and the back you're holding in reserve (the "Insert Mons" boxes in the sketch).
  n.push(
    `  Lead[${L(`Lead: ${leadTxt}<br/>Back: ${backTxt}<br/>Win condition: ${winCondition}`)}]`
  );

  // One branch per major threat: Lead -> IF(threat) decision -> its game plan (accounts for back).
  branches.forEach((t, i) => {
    const cond = `IF ${t.species}${t.move ? ` (${t.move})` : ""}<br/>is the biggest threat`;
    n.push(`  Lead --> IF${i}`);
    n.push(`  IF${i}{${L(cond)}}`);
    n.push(`  IF${i} --> GP${i}`);
    n.push(`  GP${i}[${L(`Game plan ${i + 1}:<br/>${t.plan}`)}]`);
  });

  // The extra "else" branch — no priority threat up, or Red misplays: run the general plan.
  n.push(`  Lead --> IFelse`);
  n.push(`  IFelse{${L("Else — no major threat up,<br/>or Red misplays")}}`);
  n.push(`  IFelse --> GPelse`);
  n.push(
    `  GPelse[${L(
      `General game plan:<br/>${winCondition}<br/>Take guaranteed KOs, lean on ${speedTool}, and deal the most damage to Red's most dangerous mon while keeping your back healthy.`
    )}]`
  );
  return n.join("\n");
}

export function planToBullets(p: PlanData): string[] {
  const selection = p.selection ?? [];
  const back = p.back ?? [];
  const threatPlans = p.threatPlans ?? [];
  const lead = p.lead ?? { mons: [] as string[], reason: "" };
  const out: string[] = [];
  out.push(`Game plan: ${p.winCondition ?? "Trade efficiently and keep more Pokémon on the board."}`);
  if (selection.length) {
    out.push(
      `Bring ${selection.join(", ")} — your best selection at a ${p.selectionWinPct}% win rate over ${p.selectionGames.toLocaleString()} games.`
    );
  }
  if (lead.mons.length) {
    const backTxt = back.length ? `, hold ${back.join(" + ")} in reserve` : "";
    out.push(`Lead ${lead.mons.join(" + ")}${backTxt}: ${lead.reason}`);
  }
  if (p.bestLead?.mons.length) {
    out.push(
      `Best lead in the data: ${p.bestLead.mons.join(" + ")} at ${p.bestLead.winPct}% over ${p.bestLead.games.toLocaleString()} games.`
    );
  }
  // One line per threat branch — this is the heart of the branching plan.
  for (let i = 0; i < threatPlans.length; i++) {
    const t = threatPlans[i];
    out.push(`Branch ${i + 1} — IF ${t.species}${t.move ? ` (${t.move})` : ""} is the danger: ${t.plan}`);
  }
  out.push(
    "Else (no major threat up, or Red misplays): take guaranteed KOs, use your speed control, and keep more Pokémon on the board."
  );
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
    back: arr<string>(p?.back),
    bestLead: p?.bestLead && Array.isArray(p.bestLead.mons) ? p.bestLead : null,
    vsRedLeads: arr<RedLeadPlan>(p?.vsRedLeads),
    threats: arr<PlanThreat>(p?.threats),
    threatPlans: arr<ThreatPlan>(p?.threatPlans),
  };
}
