import { BetfairClient, type BetfairApi } from "./betfair/client.js";
import { currencyRules } from "./betfair/currency.js";
import { hasBetfairCredentials, type Config } from "./config.js";
import { DataContextService } from "./contexts/service.js";
import { LiveExchange } from "./exchange/live.js";
import { PaperExchange } from "./exchange/paper.js";
import type { Exchange } from "./exchange/types.js";
import type { SelectionRef } from "./format.js";
import { MarketService } from "./markets.js";
import { PromptLibrary } from "./prompts.js";
import { Recorder } from "./recorder.js";
import { LOCK_RETRY_MS, State } from "./state.js";
import { BotRunner, type BotStart } from "./strategies/bots.js";
import type { BotState } from "./strategies/botTypes.js";
import { StrategyEngine } from "./strategies/engine.js";
import { TEMPLATE, normaliseParameters, timeSpanMs } from "./strategies/templates.js";
import type { ExecutionResult } from "./strategies/types.js";

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

const MAX_SEQUENCE_DEPTH = 5;

/** Why a read-only process does not run bots (another process owns DATA_DIR and runs them). */
export function readOnlyBotsMessage(state: State): string {
  return (
    `This connector process is read-only (${state.readOnlyReason ?? "DATA_DIR is in use by another connector process"}). ` +
    "Bots run only in the process that owns DATA_DIR: use the session connected to that process, or close it " +
    `(this process takes DATA_DIR over within about ${LOCK_RETRY_MS / 1000} s after it exits).`
  );
}

/** Refuses to start bots in a read-only process: they would never be saved, and the owner would not manage them. */
class OwnedBotRunner extends BotRunner {
  override start(spec: BotStart): BotState {
    if (this.deps.state.readOnly) throw new Error(readOnlyBotsMessage(this.deps.state));
    return super.start(spec);
  }
}

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
    this.bots = new OwnedBotRunner(deps);
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

  /**
   * Execute a strategy setting. A read-only process refuses settings that would start a bot
   * (trades, delayed bets, trailing stops, monitored closes) before anything is placed: it does
   * not run bots, so their positions would go unmanaged.
   */
  async executeStrategy(strategyName: string, marketId: string, selections: SelectionRef[], overrides: Record<string, unknown> = {}): Promise<ExecutionResult> {
    // ownsDataDir re-reads the lock: an owner whose lock was taken over (e.g. after a suspend) is read-only from now on.
    if (!this.state.ownsDataDir()) {
      // Settings or parameters that do not resolve are reported by the engine itself.
      const starter = await this.botStartingSetting(strategyName, marketId, overrides).catch(() => undefined);
      if (starter) {
        return {
          status: false,
          message: `"${starter}" starts a bot, so nothing was executed. ${readOnlyBotsMessage(this.state)}`,
          mode: this.exchange.mode,
          strategyName,
          template: "",
          marketId,
          outcome: "Failed",
          messages: [],
          bets: [],
          cancelled: [],
          parameters: {},
        };
      }
    }
    return this.strategies.execute(strategyName, marketId, selections, overrides);
  }

  /** The setting (or Sequence step) whose execution would start a bot, decided as StrategyEngine does. */
  private async botStartingSetting(strategyName: string, marketId: string, overrides: Record<string, unknown>, depth = 0): Promise<string | undefined> {
    const setting = this.strategies.get(strategyName);
    const template = this.strategies.template(setting.template);
    const values = normaliseParameters(template, setting.parameters, overrides);
    switch (template.name) {
      case TEMPLATE.trade:
      case TEMPLATE.trailingStopLoss:
        return setting.name;
      case TEMPLATE.closeSelection:
        return values.ClosePositionImmediately === false ? setting.name : undefined;
      case TEMPLATE.placeBet:
      case TEMPLATE.fillOrKill: {
        // A PlaceBetTimeSpan still in the future hands the bet to a bot.
        const span = timeSpanMs(values.PlaceBetTimeSpan);
        if (span === undefined) return undefined;
        const catalogue = await this.markets.getCatalogue(marketId);
        const start = Date.parse(catalogue.marketStartTime ?? catalogue.description?.marketTime ?? "");
        return !Number.isFinite(start) || Date.now() < start + span ? setting.name : undefined;
      }
      case TEMPLATE.sequence: {
        if (depth >= MAX_SEQUENCE_DEPTH) return undefined;
        for (const step of String(values.StrategyNames).split(";").map((s) => s.trim()).filter(Boolean)) {
          const starter = await this.botStartingSetting(step, marketId, {}, depth + 1);
          if (starter) return starter;
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /** Start background work: market recording, bot ticks (while this process owns DATA_DIR) and Betfair keepAlive. */
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
      const botMarkets = new Set(this.state.readOnly ? [] : this.bots.marketIds());
      const ids = this.pollingMarketIds().filter((id) => !botMarkets.has(id)); // bot markets are polled by botTick
      if (ids.length) await this.markets.getBooks(ids, { depth: 1 });
    } catch (error) {
      console.error(`[recorder] ${(error as Error).message}`);
    } finally {
      this.recording = false;
    }
  }

  /** Tick the bots, only in the process that owns DATA_DIR (a read-only one would duplicate the owner's bets). */
  async botTick() {
    if (this.botTicking || !this.bots.marketIds().length || !this.state.ownsDataDir()) return;
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
