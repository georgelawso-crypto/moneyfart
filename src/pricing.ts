export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/** Standard normal CDF, via the Abramowitz & Stegun 7.1.26 erf approximation (|error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Probability that the price ends inside [low, high) after `seconds`, treating
 * it as driftless Brownian motion with absolute volatility `sigmaPerSecond`
 * (the Bachelier model: a normal distribution centred on today's price).
 */
export function bandProbability(
  price: number,
  low: number,
  high: number,
  sigmaPerSecond: number,
  seconds: number,
): number {
  if (seconds <= 0 || sigmaPerSecond <= 0) return price >= low && price < high ? 1 : 0;
  const sd = sigmaPerSecond * Math.sqrt(seconds);
  return Math.max(0, normalCdf((high - price) / sd) - normalCdf((low - price) / sd));
}

export interface OddsRules {
  houseEdge: number;
  minOdds: number;
  maxOdds: number;
}

/**
 * Decimal odds (total paid back per 1 staked) for a win probability: fair odds
 * minus the house edge, rounded down to the cent and capped at `maxOdds`.
 * Returns null when the result is below `minOdds`, i.e. the box is so likely
 * to win that it isn't worth offering.
 */
export function oddsFor(probability: number, rules: OddsRules): number | null {
  const fair = (1 - rules.houseEdge) / probability;
  const odds = Math.min(rules.maxOdds, Math.floor(fair * 100 + 1e-9) / 100);
  return odds >= rules.minOdds ? odds : null;
}

/** The "nice" number (1, 2, 2.5 or 5 times a power of ten) closest to `x` on a log scale. */
export function niceStep(x: number): number {
  const base = 10 ** Math.floor(Math.log10(x));
  let best = base;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (Math.abs(Math.log(m * base) - Math.log(x)) < Math.abs(Math.log(best) - Math.log(x))) best = m * base;
  }
  return Number(best.toPrecision(12));
}

/** Price band height for a market: about half of a typical two-minute move, rounded to a nice number. */
export function bandSizeFor(price: number, annualVolatility: number): number {
  const sigmaPerSecond = (price * annualVolatility) / Math.sqrt(SECONDS_PER_YEAR);
  return niceStep((sigmaPerSecond * Math.sqrt(120)) / 2);
}
