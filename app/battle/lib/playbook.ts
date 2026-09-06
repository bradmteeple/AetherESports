// Turns the stored library of Auto Battle games (training-store.ts) into a reference for optimal
// play: against each opponent, which four Blue should bring and which two it should lead with.
//
// Ranking is by the Wilson 95% LOWER bound of the decided win rate — the same statistic the gauntlet
// uses to decide it has dominantly beaten a team (wilson.ts) — not by raw win %. That matters here:
// a line that went 2-0 is not evidence, and raw percentage would put it above one that went 34-11.
// The lower bound folds sample size into the ranking, so the top of the list is the line the games
// actually support.
//
// This module is pure — it takes summary rows and returns rankings — so it can be recomputed on every
// filter change without touching storage.

import type { GameSummary } from "./training-store";
import { wilsonLowerBound } from "./wilson";

// One line of play (a bring, or a lead pair within it) and how it has actually gone.
export interface ComboStat {
  key: string; // stable identity for React keys / lookups
  lead: string; // "A + B" — the two led with ("" for a bring-only row)
  back: string; // "C + D" — the two held in the back ("" when unknown)
  bring: string; // "A + B + C + D" — the four brought
  games: number;
  wins: number;
  losses: number;
  ties: number;
  decided: number; // wins + losses (ties don't count toward "does this line win?")
  winRate: number; // wins / decided, 0 when nothing is decided
  lower: number; // Wilson 95% lower bound of winRate — the ranking key
  winIds: number[]; // stored game ids Blue won with this line, newest first
  lossIds: number[]; // stored game ids Blue lost with it, newest first
}

// Everything the library knows about facing one opponent.
export interface OpponentPlaybook {
  opponentId: string;
  opponentName: string;
  games: number;
  blue: number;
  red: number;
  ties: number;
  decided: number;
  winRate: number;
  lower: number;
  brings: ComboStat[]; // the four brought, best-supported first
  leads: ComboStat[]; // exact lead + back splits, best-supported first
  best: ComboStat | null; // the recommended line (best lead split with enough games)
  worst: ComboStat | null; // the line to avoid (worst lead split with enough games)
  redLeads: { lead: string; games: number; blueWins: number }[]; // what this opponent tends to lead
}

// Fewest games a line needs before it is offered as "the" recommendation. Below this, a line is still
// listed (with its record) but never headlined — three coin flips are not a plan.
export const MIN_SUPPORT = 4;

// The two brought but not led = the four brought minus the two leads. Empty when that can't be
// resolved (a species-name mismatch, or a game with no team-preview choice recorded).
function backOf(bring: string | null, lead: string | null): string {
  if (!bring || !lead) return "";
  const leadSet = new Set(lead.split(" + "));
  const back = bring.split(" + ").filter((s) => !leadSet.has(s));
  return back.length === 2 ? back.slice().sort().join(" + ") : "";
}

interface Bucket {
  lead: string;
  back: string;
  bring: string;
  games: number;
  wins: number;
  losses: number;
  ties: number;
  winIds: number[];
  lossIds: number[];
}

function emptyBucket(lead: string, back: string, bring: string): Bucket {
  return { lead, back, bring, games: 0, wins: 0, losses: 0, ties: 0, winIds: [], lossIds: [] };
}

function fold(b: Bucket, g: GameSummary) {
  b.games++;
  if (g.result === "blue") {
    b.wins++;
    b.winIds.push(g.id);
  } else if (g.result === "red") {
    b.losses++;
    b.lossIds.push(g.id);
  } else {
    b.ties++;
  }
}

function toStat(key: string, b: Bucket): ComboStat {
  const decided = b.wins + b.losses;
  return {
    key,
    lead: b.lead,
    back: b.back,
    bring: b.bring,
    games: b.games,
    wins: b.wins,
    losses: b.losses,
    ties: b.ties,
    decided,
    winRate: decided ? b.wins / decided : 0,
    lower: wilsonLowerBound(b.wins, decided),
    winIds: b.winIds.slice().sort((x, y) => y - x),
    lossIds: b.lossIds.slice().sort((x, y) => y - x),
  };
}

// Best-supported first: the Wilson floor decides, with raw win rate then sample size as tie-breaks so
// two lines with identical floors still order sensibly.
function rank(a: ComboStat, b: ComboStat): number {
  return b.lower - a.lower || b.winRate - a.winRate || b.games - a.games || a.key.localeCompare(b.key);
}

/**
 * Group stored games by opponent and rank Blue's lines against each. Opponents are ordered by how
 * many games have been played against them (most-studied first).
 */
export function buildPlaybook(games: GameSummary[]): OpponentPlaybook[] {
  interface OppAgg {
    id: string;
    name: string;
    rows: GameSummary[];
    brings: Map<string, Bucket>;
    leads: Map<string, Bucket>;
    redLeads: Map<string, { games: number; blueWins: number }>;
  }
  const byOpp = new Map<string, OppAgg>();
  const order: OppAgg[] = []; // insertion order, so results don't depend on Map iteration

  for (const g of games) {
    let o = byOpp.get(g.opponentId);
    if (!o) {
      o = {
        id: g.opponentId,
        name: g.opponentName,
        rows: [],
        brings: new Map(),
        leads: new Map(),
        redLeads: new Map(),
      };
      byOpp.set(g.opponentId, o);
      order.push(o);
    }
    o.name = g.opponentName; // newest name wins if a roster entry was relabelled
    o.rows.push(g);

    if (g.blueCombo) {
      const bring = o.brings.get(g.blueCombo) ?? emptyBucket("", "", g.blueCombo);
      fold(bring, g);
      o.brings.set(g.blueCombo, bring);

      const back = backOf(g.blueCombo, g.blueLead);
      if (g.blueLead && back) {
        const key = `${g.blueLead}||${back}`;
        const lead = o.leads.get(key) ?? emptyBucket(g.blueLead, back, g.blueCombo);
        fold(lead, g);
        o.leads.set(key, lead);
      }
    }

    if (g.redLead) {
      const r = o.redLeads.get(g.redLead) ?? { games: 0, blueWins: 0 };
      r.games++;
      if (g.result === "blue") r.blueWins++;
      o.redLeads.set(g.redLead, r);
    }
  }

  // Map iteration is avoided throughout (the build targets ES5 without downlevelIteration).
  const statsOf = (m: Map<string, Bucket>): ComboStat[] => {
    const out: ComboStat[] = [];
    m.forEach((b, k) => out.push(toStat(k, b)));
    return out.sort(rank);
  };

  const out: OpponentPlaybook[] = [];
  for (const o of order) {
    const blue = o.rows.filter((r) => r.result === "blue").length;
    const red = o.rows.filter((r) => r.result === "red").length;
    const ties = o.rows.length - blue - red;
    const decided = blue + red;
    const brings = statsOf(o.brings);
    const leads = statsOf(o.leads);
    const supported = leads.filter((l) => l.games >= MIN_SUPPORT);
    const redLeads: { lead: string; games: number; blueWins: number }[] = [];
    o.redLeads.forEach((r, lead) => redLeads.push({ lead, games: r.games, blueWins: r.blueWins }));
    out.push({
      opponentId: o.id,
      opponentName: o.name,
      games: o.rows.length,
      blue,
      red,
      ties,
      decided,
      winRate: decided ? blue / decided : 0,
      lower: wilsonLowerBound(blue, decided),
      brings,
      leads,
      best: supported[0] ?? null,
      worst: supported.length > 1 ? supported[supported.length - 1] : null,
      redLeads: redLeads.sort((a, b) => b.games - a.games || a.lead.localeCompare(b.lead)),
    });
  }
  return out.sort((a, b) => b.games - a.games || a.opponentName.localeCompare(b.opponentName));
}

/** Headline numbers over a set of stored games (the library panel's top row). */
export function libraryTotals(games: GameSummary[]) {
  let blue = 0,
    red = 0,
    ties = 0;
  for (const g of games) {
    if (g.result === "blue") blue++;
    else if (g.result === "red") red++;
    else ties++;
  }
  const decided = blue + red;
  return {
    games: games.length,
    blue,
    red,
    ties,
    decided,
    winRate: decided ? blue / decided : 0,
    lower: wilsonLowerBound(blue, decided),
    opponents: new Set(games.map((g) => g.opponentId)).size,
  };
}
