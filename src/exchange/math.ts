import type { Side } from "../betfair/types.js";
import { round } from "../format.js";
import type { OrderView } from "./types.js";

/** Profit of a matched bet if its selection wins / loses. */
export function betOutcomeProfit(side: Side, price: number, size: number, wins: boolean): number {
  if (side === "BACK") return wins ? size * (price - 1) : -size;
  return wins ? -size * (price - 1) : size;
}

export interface Position {
  /** Profit of the selection's own matched bets if it wins. */
  ifWin: number;
  /** Profit of the selection's own matched bets if it loses. */
  ifLose: number;
}

/** Matched position per formatted selection id. */
export function selectionPositions(orders: OrderView[]): Map<string, Position> {
  const positions = new Map<string, Position>();
  for (const o of orders) {
    if (!o.sizeMatched || !o.averagePriceMatched) continue;
    const p = positions.get(o.selectionId) ?? { ifWin: 0, ifLose: 0 };
    p.ifWin += betOutcomeProfit(o.side, o.averagePriceMatched, o.sizeMatched, true);
    p.ifLose += betOutcomeProfit(o.side, o.averagePriceMatched, o.sizeMatched, false);
    positions.set(o.selectionId, p);
  }
  return positions;
}

/**
 * Order that equalises profit whether the selection wins or loses, at the given hedge prices.
 * Lay s at o: ifWin - s(o-1) = ifLose + s  =>  s = (ifWin - ifLose) / o (back is symmetric).
 * Returns undefined when the position is already flat to the cent.
 */
export function hedgeOrder(position: Position, backPrice?: number, layPrice?: number): { side: Side; price: number; size: number } | undefined {
  const diff = position.ifWin - position.ifLose;
  if (diff > 0) {
    if (!layPrice) throw new Error("No lay price available to hedge the position.");
    const size = round(diff / layPrice)!;
    return size >= 0.01 ? { side: "LAY", price: layPrice, size } : undefined;
  }
  if (diff < 0) {
    if (!backPrice) throw new Error("No back price available to hedge the position.");
    const size = round(-diff / backPrice)!;
    return size >= 0.01 ? { side: "BACK", price: backPrice, size } : undefined;
  }
  return undefined;
}

const floor2 = (value: number) => Math.floor(value * 100 + 1e-6) / 100;

/** Stakes that give the same profit (or split a total stake for equal returns) across selections. */
export function dutchStakes(prices: number[], type: "RequiredProfit" | "TotalStake", amount: number): number[] {
  const book = prices.reduce((total, p) => total + 1 / p, 0);
  if (type === "TotalStake") return prices.map((p) => floor2(amount / p / book));
  if (book >= 1) {
    throw new Error(`These selections' prices sum to a ${(book * 100).toFixed(1)}% book, so no dutch can guarantee a profit.`);
  }
  const totalStake = (amount * book) / (1 - book);
  return prices.map((p) => floor2((amount + totalStake) / p));
}
