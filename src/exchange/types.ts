import type { CurrencyRules } from "../betfair/currency.js";
import type { PersistenceType, Side } from "../betfair/types.js";

/** One order to place. Prices must already be valid ladder ticks. */
export interface OrderRequest {
  selectionId: number;
  handicap: number;
  side: Side;
  price: number;
  size: number;
  persistenceType: PersistenceType;
  /**
   * Hedge/offset/close orders: exempt from MAX_STAKE/MAX_LIABILITY (never from Betfair's minimum bet
   * rules). The risk guard checks the claim: an order that would raise the market's worst-case loss
   * is treated as a new bet whatever this says.
   */
  reducesRisk?: boolean;
  /** Caller-chosen Betfair customerOrderRef (at most 32 characters), so the order can be found again after a restart. */
  customerOrderRef?: string;
}

/** Strategy attribution: `ref` is Betfair's customerStrategyRef (max 15 chars, unique per strategy name). */
export interface StrategyTag {
  name: string;
  ref: string;
}

export interface PlacedBet {
  /** Formatted selection id (bare id unless the handicap is non-zero). */
  selectionId: string;
  side: Side;
  price: number;
  size: number;
  /** UNKNOWN: the request timed out and the outcome could not be confirmed; check get_current_orders before retrying. */
  status: "SUCCESS" | "FAILURE" | "UNKNOWN";
  betId?: string;
  errorCode?: string;
  sizeMatched?: number;
  averagePriceMatched?: number;
  orderStatus?: string;
  customerOrderRef?: string;
  /** Something the caller should pass on, e.g. a paper fill made on delayed data. */
  warning?: string;
  /** Set when the risk guard refused the bet (it never reached the exchange). */
  refusedBy?: "risk-guard";
}

export interface CancelResult {
  betId: string;
  sizeCancelled: number;
  /** "SUCCESS" or a Betfair error code such as BET_TAKEN_OR_LAPSED. */
  status: string;
}

export interface OrderView {
  betId: string;
  marketId: string;
  /** Formatted selection id. */
  selectionId: string;
  side: Side;
  price: number;
  size: number;
  sizeMatched: number;
  /** Unrounded average matched price (undefined when nothing is matched). */
  averagePriceMatched?: number;
  sizeRemaining: number;
  sizeVoided?: number;
  status: "EXECUTABLE" | "EXECUTION_COMPLETE";
  persistenceType: string;
  placedDate: string;
  matchedDate?: string;
  /** Strategy setting name (mapped back from customerStrategyRef). */
  strategy?: string;
  customerOrderRef?: string;
  /** Betfair SP bets: the stake (back) or liability (lay) at risk before the SP is known. */
  bspLiability?: number;
}

export interface SettledBetView {
  betId: string;
  marketId: string;
  selectionId: string;
  eventType?: string;
  event?: string;
  market?: string;
  selection?: string;
  marketStartTime?: string;
  side: Side;
  priceMatched?: number;
  sizeSettled?: number;
  /** Betfair betOutcome: WON, LOST, PLACE (each-way place leg won) ... */
  outcome: string;
  /** Gross profit of the bet (before commission). */
  profit: number;
  placedDate?: string;
  lastMatchedDate?: string;
  settledDate?: string;
  strategy?: string;
}

export interface SettledBets {
  bets: SettledBetView[];
  /** Commission charged on the same markets (net profit = gross - commission). */
  commission?: number;
  /** True when more records existed than were retrieved. */
  truncated?: boolean;
}

export interface FundsView {
  mode: "paper" | "live";
  currency: string;
  availableToBetBalance: number;
  exposure: number;
  [key: string]: unknown;
}

export interface Exchange {
  readonly mode: "paper" | "live";
  /** Minimum bet rules of the account currency (live) or PAPER_CURRENCY (paper). */
  currencyRules(): Promise<CurrencyRules>;
  placeOrders(marketId: string, orders: OrderRequest[], strategy: StrategyTag): Promise<PlacedBet[]>;
  /** Cancel specific unmatched bets, or every unmatched bet in the market with "ALL". An empty array cancels nothing. */
  cancelOrders(marketId: string, betIds: string[] | "ALL"): Promise<CancelResult[]>;
  /** Unsettled orders (matched and unmatched), optionally restricted to markets. */
  currentOrders(marketIds?: string[]): Promise<OrderView[]>;
  accountFunds(): Promise<FundsView>;
  settledBets(from: Date, marketIds?: string[]): Promise<SettledBets>;
  /** Markets the recorder must keep polling for this exchange (e.g. unsettled paper orders). */
  pendingMarketIds(): string[];
}
