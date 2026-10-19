import type { Config } from "../config.js";
import type { Exchange } from "../exchange/types.js";
import type { SelectionRef } from "../format.js";
import type { MarketService } from "../markets.js";
import type { State } from "../state.js";
import type { BotRunner } from "./bots.js";
import type { ExecutionResult, StrategySetting, TemplateSpec } from "./types.js";

export interface EngineDeps {
  markets: MarketService;
  exchange: Exchange;
  state: State;
  limits: Config["trading"];
  bots: BotRunner;
}

/** Strategy settings, templates and execution. STUB: implemented by the strategy module. */
export class StrategyEngine {
  constructor(protected readonly deps: EngineDeps) {}

  /** All settings: built-ins (minus those overridden) plus custom ones. */
  list(): StrategySetting[] {
    return [];
  }

  /** Resolve a setting by name or alias (case-insensitive); throws with the available names. */
  get(_name: string): StrategySetting {
    throw new Error("not implemented");
  }

  templates(): TemplateSpec[] {
    return [];
  }

  /** Resolve a template by name or alias (case-insensitive). */
  template(_name: string): TemplateSpec {
    throw new Error("not implemented");
  }

  /** BFExplorer create_strategy_settings: create-only; existing names are reported, not replaced. */
  create(_items: Array<{ name: string; template: string; parameters?: Record<string, unknown> }>): Array<{ name: string; status: boolean; message?: string }> {
    return [];
  }

  /** Create or (with overwrite) replace a custom setting. Built-in names require overwrite. */
  save(_name: string, _template: string, _parameters: Record<string, unknown>, _options: { description?: string; overwrite?: boolean } = {}): StrategySetting {
    throw new Error("not implemented");
  }

  /** Delete a custom setting (built-ins become visible again). */
  remove(_name: string): boolean {
    throw new Error("not implemented");
  }

  /**
   * Execute a setting on one or more selections. Parameter overrides accept BFExplorer's flat,
   * dotted ("OpenBetPosition.BetType") and nested forms; unknown keys reject the execution.
   */
  execute(_strategyName: string, _marketId: string, _selections: SelectionRef[], _overrides: Record<string, unknown> = {}): Promise<ExecutionResult> {
    throw new Error("not implemented");
  }
}
