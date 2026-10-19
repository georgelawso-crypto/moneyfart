import type { PersistenceType, Side } from "../betfair/types.js";

/** Persisted paper-trading ledger (owned by PaperExchange; stored by State). */

export interface PaperFill {
  price: number;
  size: number;
  /** ISO time of the fill (needed for reduction factors on non-runners). */
  at: string;
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
}

export interface PaperLedger {
  orders: PaperOrder[];
  settlements: PaperMarketSettlement[];
  betCounter: number;
}

export function emptyLedger(): PaperLedger {
  return { orders: [], settlements: [], betCounter: 0 };
}
