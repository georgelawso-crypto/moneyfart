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

/** Floor to whole cents (stakes are never rounded up, so the risk never exceeds what was asked). */
export const floor2 = (value: number) => Math.floor(value * 100 + 1e-6) / 100;

/** Money at risk on a bet: the stake for a back, the liability for a lay. */
export function liability(side: Side, price: number, size: number): number {
  return side === "BACK" ? size : size * (price - 1);
}

/** A position plus one more matched bet. */
export function addBet(position: Position, side: Side, price: number, size: number): Position {
  return {
    ifWin: position.ifWin + betOutcomeProfit(side, price, size, true),
    ifLose: position.ifLose + betOutcomeProfit(side, price, size, false),
  };
}

/** Matched position of a set of orders on one selection. */
export function positionOf(orders: Array<Pick<OrderView, "side" | "sizeMatched" | "averagePriceMatched">>): Position {
  let position: Position = { ifWin: 0, ifLose: 0 };
  for (const o of orders) {
    if (o.sizeMatched && o.averagePriceMatched) position = addBet(position, o.side, o.averagePriceMatched, o.sizeMatched);
  }
  return position;
}

/** Worst outcome of a position (negative = money that can be lost). */
export function worstCase(position: Position): number {
  return Math.min(position.ifWin, position.ifLose);
}

/**
 * Profit locked in whichever way the selection goes after an equal-profit hedge at `price`
 * (the lay price for a long position, the back price for a short one): ifLose + (ifWin - ifLose) / price.
 */
export function greenUpProfit(position: Position, price: number): number {
  return position.ifLose + (position.ifWin - position.ifLose) / price;
}

/**
 * Order that cancels the net backer's stake without greening up (BFExplorer HedgingEnabled=false):
 * afterwards the selection losing is worth 0 and the whole profit or loss sits on it winning.
 * Returns undefined when the net stake is zero to the cent.
 */
export function offsetStakeOrder(position: Position, backPrice?: number, layPrice?: number): { side: Side; price: number; size: number } | undefined {
  const netBackStake = -position.ifLose;
  if (netBackStake > 0) {
    if (!layPrice) throw new Error("No lay price available to close the position.");
    const size = round(netBackStake)!;
    return size >= 0.01 ? { side: "LAY", price: layPrice, size } : undefined;
  }
  if (netBackStake < 0) {
    if (!backPrice) throw new Error("No back price available to close the position.");
    const size = round(-netBackStake)!;
    return size >= 0.01 ? { side: "BACK", price: backPrice, size } : undefined;
  }
  return undefined;
}

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
