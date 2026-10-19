// Betfair Exchange price ladders.

export type LadderType = "CLASSIC" | "FINEST";

const CLASSIC_BANDS: Array<[from: number, to: number, step: number]> = [
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

function build(bands: Array<[number, number, number]>): readonly number[] {
  const prices: number[] = [];
  for (const [from, to, step] of bands) {
    // Integer arithmetic in cents avoids floating-point drift.
    const start = Math.round((prices.length === 0 ? from : from + step) * 100);
    const end = Math.round(to * 100);
    const inc = Math.round(step * 100);
    for (let cents = start; cents <= end; cents += inc) prices.push(cents / 100);
  }
  return prices;
}

/** CLASSIC: the standard odds ladder (350 prices). FINEST: 0.01 steps from 1.01 to 1000 (Asian handicap markets). */
export const LADDERS: Record<LadderType, readonly number[]> = {
  CLASSIC: build(CLASSIC_BANDS),
  FINEST: build([[1.01, 1000, 0.01]]),
};

export const LADDER = LADDERS.CLASSIC;
export const MIN_PRICE = 1.01;
export const MAX_PRICE = 1000;

function ladderOf(type: LadderType = "CLASSIC"): readonly number[] {
  return LADDERS[type];
}

function indexOf(ladder: readonly number[], price: number): number {
  const p = round2(price);
  let lo = 0;
  let hi = ladder.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ladder[mid] === p) return mid;
    if (ladder[mid] < p) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function isValidPrice(price: number, type: LadderType = "CLASSIC"): boolean {
  return Number.isFinite(price) && Math.abs(price - round2(price)) < 1e-9 && indexOf(ladderOf(type), price) >= 0;
}

/**
 * Snap a price onto the ladder. "up" = smallest tick >= price, "down" = largest tick <= price
 * (both on the raw price, with a tiny epsilon for float noise), "nearest" = closest tick.
 * Prices outside the ladder clamp to 1.01 / 1000.
 */
export function roundToTick(price: number, direction: "up" | "down" | "nearest" = "nearest", type: LadderType = "CLASSIC"): number {
  if (!Number.isFinite(price)) throw new Error(`Invalid price: ${price}`);
  const ladder = ladderOf(type);
  if (price <= ladder[0]) return ladder[0];
  if (price >= ladder[ladder.length - 1]) return ladder[ladder.length - 1];
  // First index with tick >= price - eps.
  let lo = 0;
  let hi = ladder.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ladder[mid] >= price - 1e-9) hi = mid;
    else lo = mid + 1;
  }
  const above = ladder[lo];
  if (Math.abs(above - price) <= 1e-9) return above;
  const below = ladder[lo - 1];
  if (direction === "up") return above;
  if (direction === "down") return below;
  return above - price < price - below ? above : below;
}

/**
 * The limit price a bettor would accept: backers need at least the price (round up),
 * layers at most the price (round down). Returns undefined when no valid tick exists
 * on the acceptable side (a back limit above 1000 or a lay limit below 1.01).
 */
export function roundForSide(price: number, side: "BACK" | "LAY", type: LadderType = "CLASSIC"): number | undefined {
  if (side === "BACK" && price > MAX_PRICE + 1e-9) return undefined;
  if (side === "LAY" && price < MIN_PRICE - 1e-9) return undefined;
  return roundToTick(price, side === "BACK" ? "up" : "down", type);
}

/** Move `ticks` steps along the ladder (positive = higher odds), clamped to the ladder ends. */
export function offsetTicks(price: number, ticks: number, type: LadderType = "CLASSIC"): number {
  const ladder = ladderOf(type);
  const start = indexOf(ladder, roundToTick(price, "nearest", type));
  const target = Math.min(ladder.length - 1, Math.max(0, start + Math.trunc(ticks)));
  return ladder[target];
}

/** Number of ticks between two prices (positive when `to` is higher). */
export function ticksBetween(from: number, to: number, type: LadderType = "CLASSIC"): number {
  const ladder = ladderOf(type);
  return indexOf(ladder, roundToTick(to, "nearest", type)) - indexOf(ladder, roundToTick(from, "nearest", type));
}
