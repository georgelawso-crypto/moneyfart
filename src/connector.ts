import { BetfairClient, type BetfairApi } from "./betfair/client.js";
import { hasBetfairCredentials, type Config } from "./config.js";
import { DataContextService } from "./dataContexts.js";
import { LiveExchange, PaperExchange, type Exchange } from "./exchange.js";
import { MarketService } from "./markets.js";
import { PromptLibrary } from "./prompts.js";
import { State } from "./state.js";
import { StrategyEngine } from "./strategies.js";

/** Long-lived services shared by every MCP session of this process. */
export class Connector {
  readonly state: State;
  readonly markets: MarketService;
  readonly dataContexts: DataContextService;
  readonly exchange: Exchange;
  readonly strategies: StrategyEngine;
  readonly prompts: PromptLibrary;
  readonly betfairConfigured: boolean;
  private recorder?: NodeJS.Timeout;
  private recording = false;

  constructor(
    readonly config: Config,
    readonly api: BetfairApi = new BetfairClient(config.betfair),
    state?: State,
  ) {
    this.betfairConfigured = api instanceof BetfairClient ? hasBetfairCredentials(config) : true;
    this.state = state ?? State.forDataDir(config.dataDir, config.recording.maxSnapshotsPerMarket);
    this.markets = new MarketService(api, this.state, config.recording.maxMonitoredMarkets);
    this.dataContexts = new DataContextService(this.markets, this.state);
    this.exchange =
      config.trading.mode === "live"
        ? new LiveExchange(api)
        : new PaperExchange(this.markets, this.state, config.trading.paperStartingBalance, config.trading.paperCommissionRate);
    this.strategies = new StrategyEngine(this.markets, this.exchange, this.state, config.trading);
    this.prompts = new PromptLibrary(config.promptsDir);
  }

  /** Poll monitored markets so price history, candlesticks and paper orders stay current. */
  startRecorder() {
    const seconds = this.config.recording.intervalSeconds;
    if (!seconds || this.recorder || !this.betfairConfigured) return;
    this.recorder = setInterval(() => void this.recordOnce(), seconds * 1000);
    this.recorder.unref();
  }

  stopRecorder() {
    if (this.recorder) clearInterval(this.recorder);
    this.recorder = undefined;
  }

  async recordOnce() {
    if (this.recording) return;
    this.recording = true;
    try {
      const ids = [...this.state.monitored.values()].filter((m) => m.status !== "Closed").map((m) => m.marketId);
      for (let i = 0; i < ids.length; i += 10) {
        await this.markets.getBooks(ids.slice(i, i + 10), ["EX_BEST_OFFERS"], 1);
      }
    } catch (error) {
      console.error(`[recorder] ${(error as Error).message}`);
    } finally {
      this.recording = false;
    }
  }
}
