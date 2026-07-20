// Derives Blue's PlanData from a run: best selection, best lead, what to do against Red's common
// leads (via type matchups + Blue's tools), the general win condition, and Red's learned threats.
// Pulls in the @pkmn dex/teams, so it's imported only from auto-engine.ts (a dynamic chunk),
// keeping the engine out of the Auto Battle page's initial load.

import "./node-shim"; // must precede any @pkmn import
import { Dex, Teams, toID } from "@pkmn/sim";
import type { LeadScenario, PlanData, PlanThreat, RedLeadPlan, ThreatPlan } from "./game-plan";

type Book = Record<string, Record<string, number>>;
type Stat = { combo: string; games: number; wins: number };

export interface AnalyzeArgs {
  blueTeamPacked: string;
  blueTeamName: string;
  redTeamName: string;
  blueWins: number;
  redWins: number;
  games: number;
  combos: Stat[]; // Blue selections, sorted best-first by win rate
  blueLeads: Stat[]; // Blue's lead pairs, sorted best-first by win rate (wins = Blue wins)
  redLeads: Stat[]; // Red lead pairs Blue faced, sorted by frequency (wins = Blue wins)
  book: Book; // Blue's learned model of Red (species id -> move id -> count)
}

interface MonInfo {
  species: string; // display name
  types: string[];
  spe: number;
  offense: number; // max(atk, spa) base stat
  hasTR: boolean;
  hasTW: boolean;
  hasFakeOut: boolean;
  hasRedirect: boolean;
}

const MIN_LEAD_GAMES = 20; // ignore lead stats without a real sample

function unpackBlue(packed: string): MonInfo[] {
  const sets = Teams.unpack(packed) ?? [];
  return sets.map((s: any) => {
    const sp = Dex.species.get(s.species || s.name);
    const base = sp.baseStats ?? { atk: 0, spa: 0, spe: 0 };
    const ids = (s.moves ?? []).map((m: string) => toID(m));
    return {
      species: sp.name || s.species || s.name,
      types: sp.types ?? [],
      spe: base.spe ?? 0,
      offense: Math.max(base.atk ?? 0, base.spa ?? 0),
      hasTR: ids.includes("trickroom"),
      hasTW: ids.includes("tailwind"),
      hasFakeOut: ids.includes("fakeout"),
      hasRedirect: ids.includes("followme") || ids.includes("ragepowder"),
    };
  });
}

// Type-chart multiplier of an attacking type vs a defender's types (0 = immune).
function typeEff(atkType: string, defTypes: string[]): number {
  for (const t of defTypes) if (!Dex.getImmunity(atkType, t)) return 0;
  let exp = 0;
  for (const t of defTypes) exp += Dex.getEffectiveness(atkType, t);
  return Math.pow(2, exp);
}

function strongestSeenMove(book: Book, speciesId: string): { move: string; bp: number } | null {
  const moves = book[speciesId];
  if (!moves) return null;
  let bestMv = "";
  let bestCount = 0;
  for (const [mv, c] of Object.entries(moves)) if (c > bestCount) ((bestCount = c), (bestMv = mv));
  if (!bestMv) return null;
  const m = Dex.moves.get(bestMv);
  return { move: m.name || bestMv, bp: m.basePower || 0 };
}

function winCondition(archetype: PlanData["archetype"]): string {
  if (archetype === "Trick Room")
    return "Land Trick Room and sweep with your slow, powerful attackers while Red is stuck moving last — protect the setter and re-set it as needed.";
  if (archetype === "Tailwind")
    return "Get Tailwind up turn 1 and use the speed lead to KO Red's threats before they move; press the advantage over its four turns.";
  return "Trade efficiently — remove Red's biggest threats with super-effective hits and keep more Pokémon on the board.";
}

// How Blue should answer a specific Red lead: which brought mon checks each Red lead Pokémon by
// type, plus any disruption / speed-control tools Blue has.
function responseToRedLead(
  redLead: string[],
  pool: MonInfo[],
  archetype: PlanData["archetype"],
  threatIds: Set<string>
): string {
  const parts: string[] = [];
  for (const redName of redLead) {
    const redTypes = Dex.species.get(redName).types ?? [];
    let bestMon: MonInfo | null = null;
    let bestMult = 1;
    for (const m of pool) {
      const mult = m.types.reduce((mx, t) => Math.max(mx, typeEff(t, redTypes)), 0);
      if (mult > bestMult) ((bestMult = mult), (bestMon = m));
    }
    const danger = threatIds.has(toID(redName)) ? " (their main threat)" : "";
    parts.push(bestMon ? `${bestMon.species} answers ${redName}${danger}` : `focus ${redName}${danger} down`);
  }
  const extras: string[] = [];
  const fake = pool.find((m) => m.hasFakeOut);
  const redir = pool.find((m) => m.hasRedirect);
  if (fake) extras.push(`${fake.species} Fake Out for tempo`);
  if (redir) extras.push(`${redir.species} redirects to shield your setter`);
  if (archetype === "Trick Room") extras.push("get Trick Room up first");
  else if (archetype === "Tailwind") extras.push("Tailwind to out-speed them");
  const body = parts.join("; ");
  return extras.length ? `${body}. ${extras.join(", ")}.` : `${body}.`;
}

function bestStat(stats: Stat[]): Stat | null {
  const sampled = stats.filter((s) => s.games >= MIN_LEAD_GAMES);
  return sampled[0] ?? stats.slice().sort((a, b) => b.games - a.games)[0] ?? null;
}

// The Blue mon that best checks a given Red threat: the one whose best attacking type is most
// super-effective into it, falling back to the hardest hitter when nothing is super-effective.
function bestAnswer(threatName: string, pool: MonInfo[]): MonInfo | null {
  const redTypes = Dex.species.get(threatName).types ?? [];
  let best: MonInfo | null = null;
  let bestMult = 1;
  for (const m of pool) {
    const mult = m.types.reduce((mx, t) => Math.max(mx, typeEff(t, redTypes)), 0);
    if (mult > bestMult) ((bestMult = mult), (best = m));
  }
  return best ?? pool.slice().sort((a, b) => b.offense - a.offense)[0] ?? null;
}

// Build one branch of the flowchart: how Blue answers a specific major threat while accounting
// for the back line (which reserve mon to bring, and what to hold for the win condition).
function threatToPlan(
  threat: PlanThreat,
  pool: MonInfo[],
  leadIds: Set<string>,
  back: string[],
  archetype: PlanData["archetype"]
): ThreatPlan {
  const answer = bestAnswer(threat.species, pool);
  const answerName = answer?.species ?? "";
  const answerFromBack = answer ? !leadIds.has(toID(answer.species)) : false;
  const reserve = back.filter((n) => toID(n) !== toID(answerName));

  const speed =
    archetype === "Trick Room"
      ? "Keep Trick Room up so your slow hitters still move first."
      : archetype === "Tailwind"
      ? "Keep Tailwind up to stay ahead on speed."
      : "Lean on your speed control / tempo tools to move first.";
  const open = answerName
    ? `${answerFromBack ? `Switch ${answerName} in from the back` : `${answerName} stays in`} and gang up to KO ${threat.species}`
    : `Gang up and KO ${threat.species}`;
  const watch = threat.move ? ` (watch ${threat.move})` : "";
  const reserveTxt = reserve.length
    ? ` Hold ${reserve.join(" + ")} in reserve as your win condition.`
    : "";

  return {
    species: threat.species,
    move: threat.move,
    answer: answerName,
    answerFromBack,
    plan: `${open}${watch} before it moves. ${speed}${reserveTxt}`,
  };
}

// How badly a Red Pokémon threatens Blue's lead: its offense, scaled by the best type multiplier
// it has into either lead mon and biased up for speed (faster mons hit our lead before we move).
// Used to decide which opposing lead Pokémon Blue should knock out first.
function threatToLead(redName: string, blueLead: MonInfo[]): number {
  const sp = Dex.species.get(redName);
  const off = Math.max(sp.baseStats?.atk ?? 0, sp.baseStats?.spa ?? 0);
  const redTypes = sp.types ?? [];
  let best = 0.25; // never zero, so KO ordering stays stable even against a resisted attacker
  for (const bl of blueLead) {
    const mult = redTypes.reduce((mx, t) => Math.max(mx, typeEff(t, bl.types)), 0);
    best = Math.max(best, mult);
  }
  const speedBias = 1 + (sp.baseStats?.spe ?? 0) / 400;
  return off * best * speedBias;
}

function winShort(archetype: PlanData["archetype"]): string {
  return archetype === "Trick Room"
    ? "sweep while Trick Room is up"
    : archetype === "Tailwind"
    ? "press your Tailwind speed lead"
    : "keep more Pokémon on the board";
}

// Build one branch flowchart for a specific opposing lead: an ordered set of steps that says what
// to do turn 1 (setup / disruption), then which opposing Pokémon to KO and in what order (worst
// threat to our lead first), then how to close with the back line.
function leadToScenario(
  redLead: string[],
  pool: MonInfo[],
  blueLead: MonInfo[],
  leadIds: Set<string>,
  back: string[],
  archetype: PlanData["archetype"],
  winPct: number,
  games: number
): LeadScenario {
  // Rank the opposing lead by how hard each mon threatens our lead — remove the worst first.
  const ranked = redLead
    .map((name) => ({ name, score: threatToLead(name, blueLead), answer: bestAnswer(name, pool) }))
    .sort((x, y) => y.score - x.score);

  const steps: string[] = [];

  // Step 1 — setup / disruption, tuned to our archetype and disruption tools.
  const fast = ranked[0]?.name ?? "their lead";
  const fake = pool.find((m) => m.hasFakeOut);
  if (archetype === "Trick Room") {
    steps.push(
      fake
        ? `Turn 1: set Trick Room; ${fake.species} Fake Out ${fast} so it can't move.`
        : `Turn 1: set Trick Room, protecting the setter if ${fast} pressures it.`
    );
  } else if (archetype === "Tailwind") {
    steps.push(
      fake
        ? `Turn 1: set Tailwind to out-speed; ${fake.species} Fake Out ${fast} for tempo.`
        : `Turn 1: set Tailwind to out-speed their lead.`
    );
  } else {
    steps.push(
      fake
        ? `Turn 1: ${fake.species} Fake Out ${fast}, then hit into their lead.`
        : `Turn 1: pressure ${fast} and take any free KO.`
    );
  }

  // Steps 2..n — KO the opposing lead in priority order (highest threat to our lead first).
  ranked.forEach((r, i) => {
    const ans = r.answer?.species ?? "your best super-effective hit";
    const fromBack = r.answer ? !leadIds.has(toID(r.answer.species)) : false;
    const bring = fromBack ? ` — bring ${r.answer!.species} in from the back` : "";
    const verb = i === 0 ? "KO" : "Then KO";
    const why = i === 0 ? " first (it most threatens your lead)" : "";
    steps.push(`${verb} ${r.name}${why}: focus it with ${ans}${bring}.`);
  });

  // Final — bring any untapped reserves and close on the win condition.
  const usedIds = new Set(ranked.filter((r) => r.answer).map((r) => toID(r.answer!.species)));
  const reserve = back.filter((n) => !usedIds.has(toID(n)));
  const closeBack = reserve.length ? reserve : back;
  steps.push(
    closeBack.length
      ? `Bring ${closeBack.join(" + ")} in to clean up the rest — ${winShort(archetype)}.`
      : `Clean up the rest — ${winShort(archetype)}.`
  );

  return { redLead, winPct, games, steps };
}

export function analyzeBluePlan(a: AnalyzeArgs): PlanData {
  const decided = a.blueWins + a.redWins;
  const winPct = decided ? Math.round((a.blueWins / decided) * 100) : 0;

  // Best selection: highest win rate among reasonably-sampled picks, else the most-played.
  const best = bestStat(a.combos);
  const selection = best ? best.combo.split(" + ") : [];
  const selectionWinPct = best && best.games ? Math.round((best.wins / best.games) * 100) : 0;
  const selectionGames = best ? best.games : 0;

  // Blue team shape + which of the brought four (fallback: whole team) to reason from.
  const team = unpackBlue(a.blueTeamPacked);
  const selSet = new Set(selection.map((n) => toID(n)));
  const brought = team.filter((m) => selSet.has(toID(m.species)));
  const pool = brought.length >= 2 ? brought : team;

  const trSetter = pool.find((m) => m.hasTR);
  const twSetter = pool.find((m) => m.hasTW);
  const archetype: PlanData["archetype"] = trSetter ? "Trick Room" : twSetter ? "Tailwind" : "Tempo";

  let lead: PlanData["lead"];
  if (trSetter) {
    const partner = pool
      .filter((m) => m.species !== trSetter.species)
      .sort((x, y) => y.offense - x.offense || x.spe - y.spe)[0];
    lead = {
      mons: [trSetter.species, partner?.species].filter(Boolean) as string[],
      reason: "Set Trick Room turn 1, then let your slow, hard hitters move first and clean up.",
    };
  } else if (twSetter) {
    const partner = pool
      .filter((m) => m.species !== twSetter.species)
      .sort((x, y) => y.offense - x.offense)[0];
    lead = {
      mons: [twSetter.species, partner?.species].filter(Boolean) as string[],
      reason: "Set Tailwind turn 1 to out-speed the field, then apply pressure while it lasts.",
    };
  } else {
    const two = pool.slice().sort((x, y) => y.offense - x.offense || y.spe - x.spe).slice(0, 2);
    lead = {
      mons: two.map((m) => m.species),
      reason: "Lead your two strongest attackers and trade efficiently, keeping momentum.",
    };
  }

  // Red's biggest learned threats (Blue prioritizes KO-ing these).
  const threatsRaw = Object.keys(a.book)
    .map((id) => {
      const seen = strongestSeenMove(a.book, id);
      const sp = Dex.species.get(id);
      return { id, species: sp.name || id, move: seen?.move || "", bp: seen?.bp || 0 };
    })
    .filter((t) => t.bp > 0)
    .sort((x, y) => y.bp - x.bp);
  const threats: PlanThreat[] = threatsRaw.slice(0, 3).map((t) => ({ species: t.species, move: t.move }));
  const threatIds = new Set(threatsRaw.slice(0, 4).map((t) => t.id));

  // The back line: the brought Pokémon that aren't in the suggested lead.
  const leadIds = new Set(lead.mons.map((n) => toID(n)));
  const back = selection.filter((n) => !leadIds.has(toID(n)));

  // One flowchart branch per major threat (up to 4), each written to account for the back line.
  const threatPlans: ThreatPlan[] = threatsRaw
    .slice(0, 4)
    .map((t) => threatToPlan({ species: t.species, move: t.move }, pool, leadIds, back, archetype));

  // Blue's best-performing lead.
  const bl = bestStat(a.blueLeads);
  const bestLead =
    bl && bl.games
      ? { mons: bl.combo.split(" + "), winPct: Math.round((bl.wins / bl.games) * 100), games: bl.games }
      : null;

  // What to do against Red's most common leads (top 3 with a real sample).
  const vsRedLeads: RedLeadPlan[] = a.redLeads
    .filter((s) => s.games >= MIN_LEAD_GAMES)
    .slice(0, 3)
    .map((s) => {
      const leadMons = s.combo.split(" + ");
      return {
        lead: leadMons,
        winPct: s.games ? Math.round((s.wins / s.games) * 100) : 0,
        games: s.games,
        response: responseToRedLead(leadMons, pool, archetype, threatIds),
      };
    });

  // The lead Pokémon (as team shapes) that our lead has to survive — used to rank KO priority.
  const blueLead = lead.mons
    .map((n) => team.find((m) => toID(m.species) === toID(n)))
    .filter(Boolean) as MonInfo[];

  // One KO-sequence branch per common opposing lead that threatens our lead (top 3 with a sample).
  const leadScenarios: LeadScenario[] = a.redLeads
    .filter((s) => s.games >= MIN_LEAD_GAMES)
    .slice(0, 3)
    .map((s) =>
      leadToScenario(
        s.combo.split(" + "),
        pool,
        blueLead,
        leadIds,
        back,
        archetype,
        s.games ? Math.round((s.wins / s.games) * 100) : 0,
        s.games
      )
    );

  return {
    blueTeam: a.blueTeamName,
    redTeam: a.redTeamName,
    games: a.games,
    blueWins: a.blueWins,
    redWins: a.redWins,
    winPct,
    archetype,
    winCondition: winCondition(archetype),
    selection,
    selectionWinPct,
    selectionGames,
    lead,
    back,
    bestLead,
    vsRedLeads,
    threats,
    threatPlans,
    leadScenarios,
  };
}
