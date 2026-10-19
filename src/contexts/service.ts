import type { SelectionRef } from "../format.js";
import type { MarketService } from "../markets.js";
import type { State } from "../state.js";
import type { DataContextApi, DataContextEnvelope, FeedbackEntry, ProviderInfo } from "./types.js";

export interface ContextOptions {
  /** IANA zone for data-context times (DISPLAY_TIMEZONE). */
  timeZone: string;
}

/** Data-context providers and the BFExplorer envelope. STUB: implemented by the contexts module. */
export class DataContextService implements DataContextApi {
  constructor(
    protected readonly markets: MarketService,
    protected readonly state: State,
    protected readonly options: ContextOptions,
  ) {}

  getForMarket(_marketId: string, _names: string[], _only?: SelectionRef): Promise<DataContextEnvelope> {
    throw new Error("not implemented");
  }

  providers(_marketId?: string): ProviderInfo[] {
    return [];
  }

  feedback(_dataContextName: string, _forLastResults: number): Promise<FeedbackEntry[]> {
    throw new Error("not implemented");
  }
}
