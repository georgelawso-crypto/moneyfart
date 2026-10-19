// Betfair Exchange price ladder: every valid odds value from 1.01 to 1000.
const BANDS: Array<[from: number, to: number, step: number]> = [
  [1.01, 2, 0.01],
  [2, 3, 0.02],
  [3, 4, 0.05],
  [4, 6, 0.1],
  [6, 10, 0.2],
  [10, 20, 0.5],
  [20, 30, 1],
  [30, 50, 2],
  [50, 100, 5],
  [100, 1000, 10],
];

const round2 = (value: number) => Math.round(value * 100) / 100;

export const LADDER: readonly number[] = (() => {
  const prices: number[] = [];
  for (const [from, to, step] of BANDS) {
    const start = prices.length === 0 ? from : from + step;
    for (let p = start; p <= to + 1e-9; p += step) prices.push(round2(p));
  }
  return prices;
})();

export const MIN_PRICE = LADDER[0];
export const MAX_PRICE = LADDER[LADDER.length - 1];

export function isValidPrice(price: number): boolean {
  return indexOfPrice(price) >= 0;
}

function indexOfPrice(price: number): number {
  const p = round2(price);
  let lo = 0;
  let hi = LADDER.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (LADDER[mid] === p) return mid;
    if (LADDER[mid] < p) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Snap a price onto the ladder. "up" picks the nearest tick at or above the
 * price, "down" the nearest at or below, "nearest" whichever is closer.
 */
export function roundToTick(price: number, direction: "up" | "down" | "nearest" = "nearest"): number {
  if (!Number.isFinite(price)) throw new Error(`Invalid price: ${price}`);
  if (price <= MIN_PRICE) return MIN_PRICE;
  if (price >= MAX_PRICE) return MAX_PRICE;
  const p = round2(price);
  let i = LADDER.findIndex((tick) => tick >= p - 1e-9);
  if (LADDER[i] === p) return p;
  const above = LADDER[i];
  const below = LADDER[i - 1];
  if (direction === "up") return above;
  if (direction === "down") return below;
  return above - p < p - below ? above : below;
}

/**
 * The price that is the best a bettor would accept: backers want at least the
 * price (round up), layers want at most the price (round down).
 */
export function roundForSide(price: number, side: "BACK" | "LAY"): number {
  return roundToTick(price, side === "BACK" ? "up" : "down");
}

/** Move `ticks` steps along the ladder (positive = higher odds). */
export function offsetTicks(price: number, ticks: number): number {
  const start = indexOfPrice(roundToTick(price));
  const target = Math.min(LADDER.length - 1, Math.max(0, start + Math.trunc(ticks)));
  return LADDER[target];
}

/** Number of ticks between two prices (positive when `to` is higher). */
export function ticksBetween(from: number, to: number): number {
  return indexOfPrice(roundToTick(to)) - indexOfPrice(roundToTick(from));
}
