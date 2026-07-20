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

// One branch of the flowchart, keyed on an opposing lead that threatens our lead. Each branch is
// its own mini game-plan flowchart: an ordered list of steps that says what to do and, crucially,
// when to knock out each opposing Pokémon (highest threat to our lead first), accounting for the
// back line. There should be one of these per common opposing lead, plus an "else" branch.
export interface LeadScenario {
  redLead: string[]; // the opposing lead pair this branch answers
  winPct: number; // Blue's win rate against this lead in the data
  games: number; // sample size behind that win rate
  steps: string[]; // ordered flowchart steps: setup → KO order → clean up
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
  threatPlans: ThreatPlan[]; // legacy: one branch per major threat (fallback for older links)
  leadScenarios: LeadScenario[]; // one KO-sequence plan per opposing lead (the per-scenario game plan)
}

// ---- Rendering (pure) ------------------------------------------------------------------------

export function planToBullets(p: PlanData): string[] {
  const selection = p.selection ?? [];
  const back = p.back ?? [];
  const scenarios = p.leadScenarios ?? [];
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
  // One line per opposing-lead scenario, spelling out the KO order — the heart of the plan.
  if (scenarios.length) {
    scenarios.forEach((s, i) => {
      out.push(
        `Scenario ${i + 1} — IF Red leads ${s.redLead.join(" + ")} (Blue ${s.winPct}% over ${s.games.toLocaleString()}): ${s.steps.join(" → ")}`
      );
    });
  } else {
    // Legacy fallback for older encoded links.
    for (let i = 0; i < threatPlans.length; i++) {
      const t = threatPlans[i];
      out.push(`Branch ${i + 1} — IF ${t.species}${t.move ? ` (${t.move})` : ""} is the danger: ${t.plan}`);
    }
  }
  out.push(
    "Else (unfamiliar lead, or Red misplays): KO the biggest threat first, take guaranteed KOs, keep your speed control up, then bring the back to close."
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
    leadScenarios: arr<LeadScenario>(p?.leadScenarios),
  };
}
