import type { SelectionRef } from "../format.js";

/** BFExplorer's market header inside data contexts: exactly these six keys, in this order. */
export interface DataContextMarket {
  marketId: string;
  /** Local time with offset (DISPLAY_TIMEZONE), e.g. "2026-10-06T20:00:00+02:00". */
  startTime?: string;
  eventType?: string;
  /** The venue for racing (BFExplorer), otherwise the Betfair event name. */
  eventName?: string;
  marketName: string;
  status?: string;
}

export interface SelectionData {
  selectionId: string;
  name: string;
  /** Merged payload keys of every requested provider; omitted when empty. */
  data?: Record<string, unknown>;
}

/** Envelope returned by get_all_data_context_for_market / get_data_context_for_market_selection. */
export interface DataContextEnvelope {
  market: DataContextMarket;
  selectionsData: SelectionData[];
  /** Market-level payload keys (e.g. placeMarket) and stored AI-agent contexts, keyed by name. */
  data?: Record<string, unknown>;
  /** Connector-only: requested contexts that could not be produced, with reasons. */
  unavailableDataContexts?: Record<string, string>;
  /** Connector-only: requested contexts that were produced but cover less than BFExplorer's, with what is missing. */
  partialDataContexts?: Record<string, string>;
  /** Connector-only: how much price history this connector has recorded for the market. */
  recording?: {
    since?: string;
    minutes: number;
    volumeDataAvailable: boolean;
    note?: string;
  };
}

export interface ProviderInfo {
  name: string;
  status: "available" | "partial" | "unavailable";
  description: string;
  /** Per-selection keys written into selectionsData[].data. */
  dataKeys: string[];
  /** Market-level keys written into the top-level data object. */
  marketDataKeys?: string[];
  reason?: string;
}

export interface FeedbackEntry {
  market: DataContextMarket & { settled: boolean };
  /** The stored AI-agent JSON. */
  data: unknown;
  storedAt: string;
  /** Settled outcome when known. */
  result?: {
    runners: Array<{ selectionId: string; name: string; status?: string; isWinner: boolean; bsp?: number }>;
  };
  /** Profit/loss of this connector's bets on the market, when settled. */
  profit?: number;
}

export interface DataContextApi {
  getForMarket(marketId: string, names: string[], only?: SelectionRef): Promise<DataContextEnvelope>;
  providers(marketId?: string): ProviderInfo[];
  feedback(dataContextName: string, forLastResults: number): Promise<FeedbackEntry[]>;
}
