import type { Config } from "../config.js";
import type { Exchange } from "../exchange/types.js";
import type { MarketService } from "../markets.js";
import type { State } from "../state.js";
import type { BotState } from "./botTypes.js";

export interface BotDeps {
  markets: MarketService;
  exchange: Exchange;
  state: State;
  limits: Config["trading"];
}

/**
 * Runs position-managing strategies (profit/loss targets, trailing stops, close before the off)
 * on every tick. STUB: implemented by the strategy module.
 */
export class BotRunner {
  constructor(protected readonly deps: BotDeps) {}

  /** Bots, newest first, optionally filtered. */
  list(_filter: { marketId?: string; status?: BotState["status"] } = {}): BotState[] {
    return [];
  }

  /** Stop a bot; optionally close (green up) the position it manages. */
  stop(_botId: string, _options: { closePosition?: boolean } = {}): Promise<BotState> {
    throw new Error("not implemented");
  }

  /** Stop every running bot; returns how many were stopped. */
  stopAll(): Promise<number> {
    throw new Error("not implemented");
  }

  /** Markets with running bots (polled every BOT_INTERVAL_SECONDS). */
  marketIds(): string[] {
    return [];
  }

  /** Evaluate every running bot once (fetches the books it needs). */
  async tick(): Promise<void> {}
}
