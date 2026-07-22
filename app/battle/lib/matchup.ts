// A pre-battle matchup chart the player hands the Adaptive (Level 3) AI: for each AI Pokémon
// against each of the player's Pokémon, a rating FROM THE AI'S PERSPECTIVE — +1 (AI favored),
// 0 (neutral), -1 (AI disadvantaged). The AI plays to it (see AdaptiveAI in ai.ts).
//
// Keyed by a plain species id. The chart is built from the team sheets' species names, and the AI
// looks it up by the on-field species name (protocol DETAILS forme) — the same string — so no Dex
// normalization is needed, which keeps this module dependency-free (so the Battle page can import
// it without pulling the whole engine into the initial bundle).

export type Cell = -1 | 0 | 1;
export type Matchup = Record<string, Record<string, Cell>>; // aiId -> playerId -> Cell

function id(species: string): string {
  return (species || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function emptyMatchup(): Matchup {
  return {};
}

/** Rating for how the AI's `aiSpecies` matches up against the player's `playerSpecies` (default 0). */
export function matchupValue(m: Matchup | undefined, aiSpecies: string, playerSpecies: string): Cell {
  if (!m) return 0;
  return m[id(aiSpecies)]?.[id(playerSpecies)] ?? 0;
}

/** Return a copy of `m` with the (aiSpecies, playerSpecies) cell set to `v`. */
export function setMatchup(m: Matchup, aiSpecies: string, playerSpecies: string, v: Cell): Matchup {
  const a = id(aiSpecies);
  const p = id(playerSpecies);
  return { ...m, [a]: { ...(m[a] || {}), [p]: v } };
}
