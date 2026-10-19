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
}

export interface TemplateSpec {
  name: string;
  description: string;
  category: "Betting" | "Trading" | "Position" | "Dutching" | "Control";
  parameters: ParameterSpec[];
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
  parameters: Record<string, unknown>;
}
