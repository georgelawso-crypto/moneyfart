import { BetfairClient, type BetfairApi } from "./betfair/client.js";
import { currencyRules } from "./betfair/currency.js";
import { hasBetfairCredentials, type Config } from "./config.js";
import { DataContextService } from "./contexts/service.js";
import { LiveExchange } from "./exchange/live.js";
import { PaperExchange } from "./exchange/paper.js";
import type { Exchange } from "./exchange/types.js";
import { MarketService } from "./markets.js";
import { PromptLibrary } from "./prompts.js";
import { Recorder } from "./recorder.js";
import { State } from "./state.js";
import { BotRunner } from "./strategies/bots.js";
import { StrategyEngine } from "./strategies/engine.js";

/** BFExplorer tools this connector implements (execute_console_script runs F# inside BFExplorer and cannot be reproduced). */
export const IMPLEMENTED_BFEXPLORER_TOOLS = [
  "get_monitored_markets",
  "get_data_context",
  "create_strategy_settings",
  "get_strategy_setting",
  "execute_strategy_settings_on_selections",
  "set_ai_agent_data_context_for_market",
  "execute_strategy_settings",
  "execute_strategy_settings_with_parameters",
  "get_all_data_context_for_market",
  "open_market",
  "get_all_strategy_templates",
  "get_my_favourite_bet_event_markets",
  "execute_application_command",
  "get_active_market",
  "get_all_strategy_settings",
  "get_market",
  "get_available_data_context_providers",
  "activate_market_selection",
  "get_data_context_for_market_selection",
  "get_all_bet_results",
  "get_strategy_template",
  "get_ai_agent_data_context_feedback",
  "get_application_commands",
  "get_my_favourite_bet_events",
];

/** Long-lived services shared by every MCP session of this process. */
export class Connector {
  readonly state: State;
  readonly recorder: Recorder;
  readonly markets: MarketService;
  readonly contexts: DataContextService;
  readonly exchange: Exchange;
  readonly bots: BotRunner;
  readonly strategies: StrategyEngine;
  readonly prompts: PromptLibrary;
  readonly betfairConfigured: boolean;
  private recorderTimer?: NodeJS.Timeout;
  private botTimer?: NodeJS.Timeout;
  private recording = false;
  private botTicking = false;

  constructor(
    readonly config: Config,
    readonly api: BetfairApi = new BetfairClient(config.betfair),
    state?: State,
  ) {
    this.betfairConfigured = api instanceof BetfairClient ? hasBetfairCredentials(config) : true;
    this.state = state ?? State.forDataDir(config.dataDir);
    this.recorder = new Recorder(config.recording.maxRecordedMarkets, config.recording.maxTradesPerSelection);
    this.markets = new MarketService(api, this.state, this.recorder, config.recording.maxMonitoredMarkets);
    this.contexts = new DataContextService(this.markets, this.state, { timeZone: config.output.displayTimeZone });
    const t = config.trading;
    this.exchange =
      t.mode === "live"
        ? new LiveExchange(api, this.state, { minBetSize: t.minBetSize, minBetPayout: t.minBetPayout })
        : new PaperExchange(this.markets, this.state, {
            startingBalance: t.paperStartingBalance,
            commissionRate: t.paperCommissionRate,
            currency: currencyRules(t.paperCurrency, { minBetSize: t.minBetSize, minBetPayout: t.minBetPayout }),
          });
    const deps = { markets: this.markets, exchange: this.exchange, state: this.state, limits: config.trading };
    this.bots = new BotRunner(deps);
    this.strategies = new StrategyEngine({ ...deps, bots: this.bots });
    const providers = new Map(this.contexts.providers().map((p) => [p.name.toLowerCase(), p.status]));
    this.prompts = new PromptLibrary(config.promptsDir, {
      implementedTools: IMPLEMENTED_BFEXPLORER_TOOLS,
      providerStatus: (name) => providers.get(name.toLowerCase()) ?? "unknown",
    });
  }

  get client(): BetfairClient | undefined {
    return this.api instanceof BetfairClient ? this.api : undefined;
  }

  /** Start background work: market recording, bot ticks and Betfair keepAlive. */
  start() {
    if (!this.betfairConfigured) return;
    const { intervalSeconds, botIntervalSeconds } = this.config.recording;
    if (intervalSeconds && !this.recorderTimer) {
      this.recorderTimer = setInterval(() => void this.recordOnce(), intervalSeconds * 1000);
      this.recorderTimer.unref();
    }
    if (botIntervalSeconds && !this.botTimer) {
      this.botTimer = setInterval(() => void this.botTick(), botIntervalSeconds * 1000);
      this.botTimer.unref();
    }
    this.client?.startKeepAlive();
  }

  stop() {
    if (this.recorderTimer) clearInterval(this.recorderTimer);
    if (this.botTimer) clearInterval(this.botTimer);
    this.recorderTimer = this.botTimer = undefined;
    this.client?.stopKeepAlive();
  }

  /** Markets polled by the recorder: open monitored markets plus markets with unsettled paper orders. */
  pollingMarketIds(): string[] {
    return [...new Set([...this.markets.monitoredMarketIds(), ...this.exchange.pendingMarketIds()])];
  }

  async recordOnce() {
    if (this.recording) return;
    this.recording = true;
    try {
      const botMarkets = new Set(this.bots.marketIds());
      const ids = this.pollingMarketIds().filter((id) => !botMarkets.has(id)); // bot markets are polled by botTick
      if (ids.length) await this.markets.getBooks(ids, { depth: 1 });
    } catch (error) {
      console.error(`[recorder] ${(error as Error).message}`);
    } finally {
      this.recording = false;
    }
  }

  async botTick() {
    if (this.botTicking || !this.bots.marketIds().length) return;
    this.botTicking = true;
    try {
      await this.bots.tick();
    } catch (error) {
      console.error(`[bots] ${(error as Error).message}`);
    } finally {
      this.botTicking = false;
    }
  }

  /** Persist and release resources (safe to call from an exit handler). */
  shutdown() {
    this.stop();
    this.state.flush();
    this.state.release();
  }
}
