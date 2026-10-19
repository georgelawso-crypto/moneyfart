import type { CurrencyRules } from "../betfair/currency.js";
import type { MarketService } from "../markets.js";
import type { State } from "../state.js";
import type { CancelResult, Exchange, FundsView, OrderRequest, OrderView, PlacedBet, SettledBets, StrategyTag } from "./types.js";

export interface PaperOptions {
  startingBalance: number;
  commissionRate: number;
  currency: CurrencyRules;
}

/** Practice-mode exchange. STUB: implemented by the paper-trading module. */
export class PaperExchange implements Exchange {
  readonly mode = "paper" as const;

  constructor(
    protected readonly markets: MarketService,
    protected readonly state: State,
    protected readonly options: PaperOptions,
  ) {}

  async currencyRules(): Promise<CurrencyRules> {
    return this.options.currency;
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
