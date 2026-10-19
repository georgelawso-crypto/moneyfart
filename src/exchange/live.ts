import type { BetfairApi } from "../betfair/client.js";
import type { CurrencyRules } from "../betfair/currency.js";
import type { State } from "../state.js";
import type { CancelResult, Exchange, FundsView, OrderRequest, OrderView, PlacedBet, SettledBets, StrategyTag } from "./types.js";

/** Real-money exchange backed by the Betfair API. STUB: implemented by the live-trading module. */
export class LiveExchange implements Exchange {
  readonly mode = "live" as const;

  constructor(
    protected readonly api: BetfairApi,
    protected readonly state: State,
    protected readonly overrides: { minBetSize?: number; minBetPayout?: number } = {},
  ) {}

  currencyRules(): Promise<CurrencyRules> {
    throw new Error("not implemented");
  }

  placeOrders(_marketId: string, _orders: OrderRequest[], _strategy: StrategyTag): Promise<PlacedBet[]> {
    throw new Error("not implemented");
  }

  cancelOrders(_marketId: string, _betIds: string[] | "ALL"): Promise<CancelResult[]> {
    throw new Error("not implemented");
  }

  currentOrders(_marketIds?: string[]): Promise<OrderView[]> {
    throw new Error("not implemented");
  }

  accountFunds(): Promise<FundsView> {
    throw new Error("not implemented");
  }

  settledBets(_from: Date, _marketIds?: string[]): Promise<SettledBets> {
    throw new Error("not implemented");
  }

  pendingMarketIds(): string[] {
    return [];
  }
}
