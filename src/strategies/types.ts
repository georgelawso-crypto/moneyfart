import type { Side } from "../betfair/types.js";
import type { CancelResult, PlacedBet } from "../exchange/types.js";

/** A named, ready-to-run configuration of a strategy template (BFExplorer "strategy settings"). */
export interface StrategySetting {
  name: string;
  template: string;
  parameters: Record<string, unknown>;
  description?: string;
  builtIn?: boolean;
  /** Other names that resolve to this setting (e.g. "Bet 2 Euro" for "Back 2 Euro"). */
  aliases?: string[];
}

export interface ParameterSpec {
  name: string;
  type: "number" | "boolean" | "enum" | "timespan" | "string";
  default: number | boolean | string | null;
  values?: string[];
  /** Other accepted names (BFExplorer spellings, older connector names). */
  aliases?: string[];
  description: string;
  /** Must have a value (from the setting or the overrides) before the strategy can run. */
  required?: boolean;
  /** Whole numbers only (ticks, positions). */
  integer?: boolean;
  /** Other accepted values (lower case) mapped to the canonical one, e.g. PersistenceType "persist" -> true. */
  valueAliases?: Record<string, string | boolean>;
}

export interface TemplateSpec {
  name: string;
  description: string;
  category: "Betting" | "Trading" | "Position" | "Dutching" | "Control";
  parameters: ParameterSpec[];
  /** Other accepted template names (e.g. "Dutching" for "Place Dutching Bets"). */
  aliases?: string[];
}

/** An order the strategy wanted to place but did not send (limits, minimum bet size, invalid price). */
export interface RejectedOrder {
  selectionId: string;
  selectionName?: string;
  side: Side;
  price: number;
  size: number;
  role?: string;
  reason: string;
}

/**
 * Result of executing a strategy. BFExplorer returns just {"status":true}; we keep `status`
 * first (boolean) for compatibility and add details. status=false always carries `message`.
 */
export interface ExecutionResult {
  status: boolean;
  message?: string;
  mode: "paper" | "live";
  strategyName: string;
  template: string;
  marketId: string;
  marketName?: string;
  eventName?: string;
  /** Executed / PartiallyExecuted / Skipped / Failed, or Started when a monitoring bot was launched. */
  outcome: "Executed" | "PartiallyExecuted" | "Skipped" | "Failed" | "Started";
  messages: string[];
  bets: Array<PlacedBet & { selectionName?: string; role?: string }>;
  cancelled: CancelResult[];
  /** Id of the bot that keeps managing the position (trading templates). */
  botId?: string;
  /** Every bot started (several selections, or a Sequence Execution). */
  botIds?: string[];
  /** Orders that were not sent, with the reason. */
  rejected?: RejectedOrder[];
  parameters: Record<string, unknown>;
}
