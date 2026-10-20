import { BetfairClient, type BetfairApi } from "./betfair/client.js";
import { currencyRules } from "./betfair/currency.js";
import { hasBetfairCredentials, type Config } from "./config.js";
import { DataContextService } from "./contexts/service.js";
import { GuardedExchange, startOfDay, type KillSwitchState } from "./exchange/guard.js";
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
/** How often the owner process applies the kill switch to its bots and checks the daily loss limit. */
const RISK_CHECK_MS = 30_000;

/** Result of engaging the kill switch. */
export interface KillSwitchReport {
  killSwitch: KillSwitchState;
  release: string;
  botsStopped: number;
  cancelled: Array<{ betId: string; sizeCancelled: number; status: string }>;
  notes: string[];
}

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
  /** Every order passes the risk guard (limits, kill switch, delayed data) on its way to the paper or live exchange. */
  readonly exchange: Exchange;
  readonly guard: GuardedExchange;
  readonly bots: BotRunner;
  readonly strategies: StrategyEngine;
  readonly prompts: PromptLibrary;
  readonly betfairConfigured: boolean;
  private recorderTimer?: NodeJS.Timeout;
  private botTimer?: NodeJS.Timeout;
  private riskTimer?: NodeJS.Timeout;
  private recording = false;
  private botTicking = false;
  private riskChecking = false;
  /** Day (epoch ms of its midnight) on which the daily loss limit was last acted on. */
  private dailyLimitHandled?: number;

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
    const inner: Exchange =
      t.mode === "live"
        ? new LiveExchange(api, this.state, { minBetSize: t.minBetSize, minBetPayout: t.minBetPayout })
        : new PaperExchange(this.markets, this.state, {
            startingBalance: t.paperStartingBalance,
            commissionRate: t.paperCommissionRate,
            currency: currencyRules(t.paperCurrency, { minBetSize: t.minBetSize, minBetPayout: t.minBetPayout }),
          });
    this.guard = new GuardedExchange(inner, this.markets, {
      limits: t,
      jurisdiction: config.betfair.jurisdiction,
      timeZone: config.output.displayTimeZone,
      dataDir: config.dataDir,
      // Two processes checking the same headroom at once could both use it: only the DATA_DIR owner adds risk.
      addRiskBlocked: () =>
        this.state.ownsDataDir()
          ? undefined
          : `this connector process doesn't own DATA_DIR (${this.state.readOnlyReason ?? "another connector process does"}), so it only places bets that close positions. Use the session connected to the owning process, or close it.`,
    });
    this.exchange = this.guard;
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
    if (!this.riskTimer) {
      this.riskTimer = setInterval(() => void this.riskCheck(), RISK_CHECK_MS);
      this.riskTimer.unref();
    }
    this.client?.startKeepAlive();
  }

  stop() {
    if (this.recorderTimer) clearInterval(this.recorderTimer);
    if (this.botTimer) clearInterval(this.botTimer);
    if (this.riskTimer) clearInterval(this.riskTimer);
    this.recorderTimer = this.botTimer = this.riskTimer = undefined;
    this.client?.stopKeepAlive();
  }

  // ---------------------------------------------------------------- risk

  killSwitch(): KillSwitchState | undefined {
    return this.guard.killSwitch();
  }

  /**
   * Emergency stop: no new risk anywhere (bets that close positions still go through), every bot
   * stopped and every unmatched bet on the account cancelled. Matched positions stay as they are.
   * Never fails open: the switch is on in this process before anything else is tried, and each
   * later step's failure is reported instead of stopping the rest. Releasing is left to the
   * account holder (see GuardedExchange.killSwitchReleaseHint).
   */
  async engageKillSwitch(reason: string, options: { cancelUnmatched?: boolean } = {}): Promise<KillSwitchReport> {
    const { fileError, ...killSwitch } = this.guard.engageKillSwitch(reason);
    const notes: string[] = [];
    if (fileError) {
      notes.push(`The kill switch could not be saved in DATA_DIR (${fileError}): it holds in this process until it restarts, but other processes sharing DATA_DIR don't see it.`);
    }
    let botsStopped = 0;
    if (this.state.ownsDataDir()) {
      try {
        botsStopped = await this.bots.stopAll();
      } catch (error) {
        notes.push(`Could not stop the bots: ${(error as Error).message}. They can't add risk while the kill switch is on; stop them with stop_bot.`);
      }
    } else notes.push("Bots run in the process that owns DATA_DIR; it stops them within a few seconds.");
    let cancelled: KillSwitchReport["cancelled"] = [];
    if (options.cancelUnmatched !== false) {
      try {
        const report = await this.guard.cancelAllUnmatched();
        cancelled = report.cancelled;
        if (report.failures.length) notes.push(`Some unmatched bets could not be cancelled (${report.failures.join("; ")}): check get_current_orders and cancel them with cancel_bets.`);
        if (report.uncancellable.length) {
          notes.push(`Betfair's API can't cancel Betfair SP bets, so these are still waiting for the off: ${report.uncancellable.join("; ")}. Check them on Betfair.`);
        }
      } catch (error) {
        notes.push(`Could not read the unmatched bets to cancel them (${(error as Error).message}): check get_current_orders and cancel them with cancel_bets.`);
      }
    }
    notes.push(
      "Matched positions are still open. Bets that close them still go through: Close Market Bet Position or Close Selection Bet Position. " +
        "A close that could raise the market's worst case on its own (lays on two runners that cover each other) is refused while the kill switch is on: close those on Betfair.",
    );
    return { killSwitch, release: this.guard.killSwitchReleaseHint(), botsStopped, cancelled, notes };
  }

  /**
   * Run by the process that owns DATA_DIR every 30 s. While the kill switch is on it stops bots and
   * cancels unmatched bets that would add risk (one that turns up late, after a timeout). Once
   * today's settled losses reach DAILY_LOSS_LIMIT it cancels those too; resting closing bets stay so
   * positions can still be closed. A day counts as handled only once every cancel has gone through.
   */
  async riskCheck() {
    if (this.riskChecking || !this.betfairConfigured || !this.state.ownsDataDir()) return;
    this.riskChecking = true;
    try {
      const kill = this.guard.killSwitch();
      if (kill?.unreadable) return; // may clear: nothing irreversible on an unreadable file
      if (kill) {
        await this.stopBotsIfKilled();
        const report = await this.guard.cancelRiskAddingUnmatched();
        const done = report.cancelled.filter((c) => c.status === "SUCCESS").length;
        if (done || report.failures.length) {
          console.error(`[risk] kill switch engaged: cancelled ${done} unmatched bet(s) that would add risk${report.failures.length ? `; failed: ${report.failures.join("; ")}` : ""}.`);
        }
        return;
      }
      const day = startOfDay(Date.now(), this.config.output.displayTimeZone);
      if (this.dailyLimitHandled === day) return;
      // Only unmatched bets need acting on: while there are none, one cheap read is enough.
      const unmatched = (await this.exchange.currentOrders()).some((o) => o.sizeRemaining > 0 || (o.bspLiability ?? 0) > 0);
      if (!unmatched || (await this.guard.dailyLimitHit()) !== true) return;
      const report = await this.guard.cancelRiskAddingUnmatched();
      const done = report.cancelled.filter((c) => c.status === "SUCCESS").length;
      console.error(
        `[risk] DAILY_LOSS_LIMIT ${this.config.trading.dailyLossLimit} reached: no new risk until midnight (${this.config.output.displayTimeZone}); ` +
          `cancelled ${done} unmatched bet(s) that would have added risk${report.failures.length ? `; failed: ${report.failures.join("; ")} (retried in 30 s)` : ""}.`,
      );
      if (!report.failures.length) this.dailyLimitHandled = day;
    } catch (error) {
      console.error(`[risk] ${(error as Error).message}`);
    } finally {
      this.riskChecking = false;
    }
  }

  /**
   * Stop every running bot once a kill switch is on (engaged here, in another process, or as a
   * damaged file). Not on a file that can't be read for a moment: that error may clear, and a stopped
   * bot no longer manages its position (its new risk is refused meanwhile anyway).
   */
  private async stopBotsIfKilled() {
    const kill = this.guard.killSwitch();
    if (!kill || kill.unreadable || !this.bots.list({ status: "running" }).length) return;
    const stopped = await this.bots.stopAll();
    console.error(`[risk] kill switch engaged: stopped ${stopped} bot(s).`);
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
      // A kill switch engaged in another process: stop rather than tick (the guard already refuses their new risk).
      const kill = this.guard.killSwitch();
      if (kill && !kill.unreadable) await this.stopBotsIfKilled();
      else await this.bots.tick();
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
