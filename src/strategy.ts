import type { Cell, Grid } from './game.js';
import { bandProbability } from './pricing.js';

/** Don't bet a disagreement smaller than this. Covers the 5% house edge plus a margin. */
export const MIN_EDGE = 0.03;
/** Quarter Kelly. Full Kelly's drawdowns are too deep for a model that can be wrong. */
export const KELLY_SCALE = 0.25;
/** Hard cap so one box cannot wager a large slice of the bank. */
export const MAX_STAKE_FRACTION = 0.05;

export interface StakePlan {
  cell: Cell;
  /** Fraction of the bank to stake (already scaled and capped). */
  fraction: number;
  /** ourProbability × odds − 1. Positive means the offered price is rich versus our vol. */
  edge: number;
}

/**
 * Quarter-Kelly stake on the nearest open window, but only on a box whose
 * offered odds are at least `MIN_EDGE` rich versus `ownSigma`.
 *
 * `ownSigma` must be an estimate that does not copy the house's volatility
 * floor. `cell.probability` is the house's number and is not used as ours.
 * Returns null when there is no estimate yet, or no box clears the hurdle.
 */
export function planStake(grid: Grid, ownSigma: number | undefined): StakePlan | null {
  if (ownSigma === undefined || !(ownSigma > 0)) return null;
  const windowIndex = grid.windows.findIndex((w) => w.bettable);
  if (windowIndex < 0) return null;

  let best: StakePlan | null = null;
  let bestGrowth = 0;
  for (const row of grid.cells) {
    const cell = row[windowIndex];
    if (cell.odds === null || cell.odds <= 1) continue;
    const seconds = cell.windowEnd - grid.now;
    const p = bandProbability(grid.price, cell.low, cell.high, ownSigma, seconds);
    if (p <= 0 || p >= 1) continue;
    const edge = p * cell.odds - 1;
    if (edge < MIN_EDGE) continue;
    const kelly = Math.min(MAX_STAKE_FRACTION, KELLY_SCALE * (edge / (cell.odds - 1)));
    const growth = p * Math.log(1 + kelly * (cell.odds - 1)) + (1 - p) * Math.log(1 - kelly);
    if (growth > bestGrowth) {
      bestGrowth = growth;
      best = { cell, fraction: kelly, edge };
    }
  }
  return best;
}

/** Stake in credits. Returns 0 when the Kelly fraction is below the minimum — never round a thin edge up to the chip size. */
export function stakeAmount(balance: number, fraction: number, minBet: number): number {
  if (balance < minBet || fraction <= 0) return 0;
  const raw = Math.floor(balance * fraction * 100) / 100;
  if (raw < minBet) return 0;
  return raw > balance ? Math.floor(balance * 100) / 100 : raw;
}
