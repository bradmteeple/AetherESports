// Shared "dominant win" gate for the Auto Battle roster gauntlet.
//
// Blue must confidently and *dominantly* beat an opponent before the gauntlet advances to the next
// team. We measure that with the lower bound of a Wilson score interval on Blue's win proportion over
// *decided* games (ties are excluded — they're neither a win nor a loss toward "can I beat this?").
// Being 95%-confident (z = 1.96) that the true win rate is above 0.60 — not merely above 0.50 — is a
// deliberately high bar, so a close or coin-flip matchup never qualifies.
//
// This lives in its own module because BOTH sides use it: the worker (mcts-worker.ts) calls the gate
// after each game to decide whether to advance, and the controller (auto-engine.ts) recomputes the
// same lower bound purely for display. Sharing the function guarantees the gate and the shown
// confidence never disagree.

export interface GauntletConfig {
  minDecided: number; // fewest decided games before an opponent can qualify (guards tiny-sample flukes)
  threshold: number; // the win rate the lower bound must clear (0.60 = "dominant", not just favoured)
  z: number; // standard-normal quantile; 1.96 ≈ 95% one-tailed confidence on the lower bound
}

export const GAUNTLET_DEFAULTS: GauntletConfig = { minDecided: 15, threshold: 0.6, z: 1.96 };

// Lower bound of the Wilson score interval for `wins / decided`. Returns 0 when nothing is decided
// yet. `decided` = Blue wins + Red wins (ties are not passed in). Result is clamped to [0, 1].
export function wilsonLowerBound(wins: number, decided: number, z: number = GAUNTLET_DEFAULTS.z): number {
  if (decided <= 0) return 0;
  const p = wins / decided;
  const z2 = z * z;
  const denom = 1 + z2 / decided;
  const center = (p + z2 / (2 * decided)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p) + z2 / (4 * decided)) / decided);
  const lower = center - margin;
  return lower < 0 ? 0 : lower > 1 ? 1 : lower;
}

// True once Blue has *dominantly* beaten the opponent: enough decided games AND the Wilson lower bound
// clears the threshold. This is the single advance-the-gauntlet decision.
export function isDominantWin(wins: number, decided: number, cfg: GauntletConfig = GAUNTLET_DEFAULTS): boolean {
  return decided >= cfg.minDecided && wilsonLowerBound(wins, decided, cfg.z) > cfg.threshold;
}
