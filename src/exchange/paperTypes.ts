import type { PersistenceType, Side } from "../betfair/types.js";

/** Persisted paper-trading ledger (owned by PaperExchange; stored by State). */

export interface PaperFill {
  price: number;
  size: number;
  /** ISO time of the fill (needed for reduction factors on non-runners). */
  at: string;
  /** Matched price before non-runner reduction factors were applied to `price`. */
  originalPrice?: number;
}

export interface PaperOrder {
  betId: string;
  marketId: string;
  selectionId: number;
  handicap: number;
  side: Side;
  price: number;
  size: number;
  fills: PaperFill[];
  sizeCancelled: number;
  sizeLapsed: number;
  sizeVoided: number;
  persistenceType: PersistenceType;
  placedDate: string;
  placedInPlay: boolean;
  strategyName?: string;
  strategyRef?: string;
  customerOrderRef?: string;
  marketName?: string;
  eventName?: string;
  /** Event type (sport) name. */
  eventType?: string;
  /** Scheduled start of the market (voids the orders if the market disappears long after it). */
  marketStartTime?: string;
  selectionName?: string;
  marketType?: string;
  eachWayDivisor?: number;
  numberOfWinners?: number;
  /** Filled in when the market settles. */
  settlement?: {
    outcome: "WON" | "LOST" | "VOID" | "PLACE";
    profit: number;
    settledDate: string;
  };
  /** Engine-specific bookkeeping (queue position, traded-volume baselines...). */
  meta?: Record<string, unknown>;
}

export interface PaperMarketSettlement {
  marketId: string;
  marketName: string;
  eventName: string;
  grossProfit: number;
  commission: number;
  settledDate: string;
  /** Set when the market was settled without a result (e.g. Betfair stopped returning it). */
  note?: string;
}

/** Displayed liquidity the paper engine has taken at one price level of one ladder. */
export interface PaperLevelUse {
  /** Size consumed from the level as displayed; subtracted from later books (clamped to what is still shown). */
  used: number;
  /** Consumed size not yet seen as traded volume: traded growth at this price is absorbed by it first. */
  credit: number;
}

/** Matching state of one selection with live paper orders. */
export interface PaperSelectionLiquidity {
  /** Keyed "B:<price>" (availableToBack, taken by BACK orders) or "L:<price>" (availableToLay, taken by LAY orders). */
  levels: Record<string, PaperLevelUse>;
  /** Cumulative traded volume per price at the last book processed (baseline for traded-volume evidence). */
  traded?: Record<string, number>;
}

/** Engine bookkeeping for a market with live paper orders (dropped once none remain). */
export interface PaperMarketState {
  numberOfWinners?: number;
  /** Formatted selection ids of the ACTIVE runners in the latest book. */
  activeRunners?: string[];
  selections: Record<string, PaperSelectionLiquidity>;
}

export interface PaperLedger {
  orders: PaperOrder[];
  settlements: PaperMarketSettlement[];
  betCounter: number;
  /** Matching state per market id (persisted so depletion and baselines survive restarts). */
  markets?: Record<string, PaperMarketState>;
}

export function emptyLedger(): PaperLedger {
  return { orders: [], settlements: [], betCounter: 0 };
}
