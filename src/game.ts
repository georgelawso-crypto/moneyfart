import { EventEmitter } from 'node:events';
import { DEFAULT_SETTINGS, type GameSettings, type MarketSpec } from './config.js';
import { DEFAULT_HERMES_URL, PythFeed, SimulatedFeed, type PriceFeed, type PriceListener } from './feeds.js';
import { clock, money } from './format.js';
import { Market, type MarketStatus } from './market.js';
import { bandProbability, oddsFor } from './pricing.js';

/** A rule violation the player should see (bad cell id, insufficient balance, ...). */
export class GameError extends Error {}

/** A box on the chart: one time window × one price band. */
export interface Cell {
  /** `<SYMBOL>-<window start, unix seconds>-<band index>` */
  id: string;
  windowStart: number;
  windowEnd: number;
  band: number;
  low: number;
  high: number;
  /** Chance the price is inside [low, high) when the window closes. */
  probability: number;
  /** Total payout per 1 staked, or null when not offered (betting closed, or too likely to win). */
  odds: number | null;
}

export interface GridWindow {
  start: number;
  end: number;
  /** Last second bets are accepted for this window. */
  closesAt: number;
  bettable: boolean;
}

export interface GridBand {
  index: number;
  low: number;
  high: number;
  containsPrice: boolean;
}

export interface Grid {
  symbol: string;
  now: number;
  price: number;
  bandSize: number;
  sigmaPerSecond: number;
  windows: GridWindow[];
  /** Highest band first, like a chart. */
  bands: GridBand[];
  /** cells[row][column], rows matching `bands`, columns matching `windows`. */
  cells: Cell[][];
}

export type BetStatus = 'pending' | 'won' | 'lost' | 'void';

export interface Bet {
  id: string;
  cellId: string;
  symbol: string;
  windowStart: number;
  windowEnd: number;
  low: number;
  high: number;
  amount: number;
  odds: number;
  probability: number;
  priceAtBet: number;
  placedAt: number;
  status: BetStatus;
  /** Credited on settlement: amount × odds if won, 0 if lost, the stake back if void. */
  payout: number;
  settlePrice?: number;
  settledAt?: number;
  note?: string;
}

export interface Account {
  player: string;
  balance: number;
  /** Pending bets plus the most recent settled ones, oldest first. */
  bets: Bet[];
  wins: number;
  losses: number;
  voids: number;
  /** Totals over won and lost bets. */
  staked: number;
  returned: number;
}

export interface MarketInfo {
  symbol: string;
  name: string;
  source: MarketSpec['source'];
  status: MarketStatus;
  price?: number;
  /** Seconds since the feed last published a price. */
  priceAge?: number;
  bandSize?: number;
  sigmaPerSecond?: number;
  feedError?: string;
}

const MAX_SETTLED_HISTORY = 50;
const PLAYER_NAME = /^[\w .-]{1,32}$/;

const round2 = (x: number) => Math.round(x * 100) / 100;
const roundPrice = (x: number) => Number(x.toFixed(10));

/**
 * The whole game: markets fed by live prices, a grid of boxes priced with the
 * Bachelier model, play-money accounts, and settlement once a second.
 * Everything lives in memory.
 */
export class Game extends EventEmitter {
  readonly markets = new Map<string, Market>();
  private readonly accounts = new Map<string, Account>();
  private feeds: PriceFeed[] = [];
  private pyth?: PythFeed;
  private timer?: NodeJS.Timeout;
  private betCounter = 0;

  constructor(
    specs: MarketSpec[],
    readonly settings: GameSettings = DEFAULT_SETTINGS,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super();
    // One 'settled' listener per in-flight wait_for_results call, from any number of players.
    this.setMaxListeners(0);
    for (const spec of specs) this.markets.set(spec.symbol, new Market(spec, settings.staleAfterSeconds));
  }

  get now(): number {
    return this.clock();
  }

  /** Starts the price feeds and the once-a-second clock that closes candles and settles bets. */
  start(hermesUrl = DEFAULT_HERMES_URL): void {
    if (this.timer) return;
    const onPrice: PriceListener = (symbol, price, publishTime) => this.markets.get(symbol)?.onPrice(price, publishTime);
    const pythFeeds = new Map<string, string>();
    for (const { spec } of this.markets.values()) {
      if (spec.source === 'pyth' && spec.pythFeedId) pythFeeds.set(spec.pythFeedId, spec.symbol);
      if (spec.source === 'simulated') {
        this.feeds.push(new SimulatedFeed(spec.symbol, spec.startPrice ?? 100, spec.annualVolatility, onPrice));
      }
    }
    if (pythFeeds.size > 0) {
      this.pyth = new PythFeed(pythFeeds, onPrice, hermesUrl);
      this.feeds.push(this.pyth);
    }
    for (const feed of this.feeds) feed.start();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const feed of this.feeds) feed.stop();
    this.feeds = [];
  }

  /** Closes candles up to `now` and settles every bet whose window has closed. */
  tick(now = this.now): void {
    for (const market of this.markets.values()) market.advanceTo(now);
    this.settle();
  }

  /** Looks up a market, accepting "BTC", "btc/usd", "BTC-USD" and so on. */
  market(symbol: string): Market {
    const key = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const market = this.markets.get(key) ?? this.markets.get(`${key}USD`);
    if (!market) {
      throw new GameError(`Unknown market "${symbol}". Available: ${[...this.markets.keys()].join(', ')}.`);
    }
    return market;
  }

  marketInfo(market: Market): MarketInfo {
    const now = this.now;
    const status = market.status(now);
    return {
      symbol: market.spec.symbol,
      name: market.spec.name,
      source: market.spec.source,
      status,
      price: market.price,
      priceAge: market.priceAge,
      bandSize: market.bandSize,
      sigmaPerSecond: market.price === undefined ? undefined : market.sigmaPerSecond(),
      feedError: market.spec.source === 'pyth' && status !== 'live' ? this.pyth?.lastError : undefined,
    };
  }

  /** The market, provided it has a fresh price; otherwise explains why play is paused. */
  private liveMarket(symbol: string): { market: Market; price: number; bandSize: number } {
    const market = this.market(symbol);
    const info = this.marketInfo(market);
    const why = info.feedError ? ` (feed error: ${info.feedError})` : '';
    if (info.status === 'waiting') {
      throw new GameError(`${info.symbol} has no price yet${why}. Try again in a few seconds.`);
    }
    if (info.status === 'stale') {
      throw new GameError(
        `${info.symbol}'s price hasn't updated for ${info.priceAge}s${why}; the market is probably closed. ` +
          'Betting is paused until prices resume. SIM is always open.',
      );
    }
    return { market, price: market.price!, bandSize: market.bandSize! };
  }

  /** Start of the next window that hasn't opened yet. */
  private nextWindowStart(now: number): number {
    const w = this.settings.windowSeconds;
    return (Math.floor(now / w) + 1) * w;
  }

  private centerBand(price: number, bandSize: number): number {
    let index = Math.floor(price / bandSize);
    if (price < roundPrice(index * bandSize)) index--;
    if (price >= roundPrice((index + 1) * bandSize)) index++;
    return index;
  }

  private cell(symbol: string, windowStart: number, band: number, bandSize: number, price: number, sigma: number, now: number): Cell {
    const windowEnd = windowStart + this.settings.windowSeconds;
    const low = roundPrice(band * bandSize);
    const high = roundPrice((band + 1) * bandSize);
    const probability = bandProbability(price, low, high, sigma, windowEnd - now);
    const bettable = now < windowStart - this.settings.betCloseSeconds;
    return {
      id: `${symbol}-${windowStart}-${band}`,
      windowStart,
      windowEnd,
      band,
      low,
      high,
      probability,
      odds: bettable ? oddsFor(probability, this.settings) : null,
    };
  }

  /** The boxes currently on offer: `columns` upcoming windows × `layers` bands around the price. */
  grid(symbol: string, columns = this.settings.columns, layers = this.settings.layers): Grid {
    const { market, price, bandSize } = this.liveMarket(symbol);
    const now = this.now;
    const sigma = market.sigmaPerSecond();
    const first = this.nextWindowStart(now);
    const windows: GridWindow[] = [];
    for (let i = 0; i < Math.min(columns, this.settings.columns); i++) {
      const start = first + i * this.settings.windowSeconds;
      const closesAt = start - this.settings.betCloseSeconds - 1;
      windows.push({ start, end: start + this.settings.windowSeconds, closesAt, bettable: now <= closesAt });
    }
    const center = this.centerBand(price, bandSize);
    const below = Math.floor((layers - 1) / 2);
    const bands: GridBand[] = [];
    for (let index = center + (layers - 1 - below); index >= Math.max(0, center - below); index--) {
      bands.push({
        index,
        low: roundPrice(index * bandSize),
        high: roundPrice((index + 1) * bandSize),
        containsPrice: index === center,
      });
    }
    const cells = bands.map((b) =>
      windows.map((w) => this.cell(market.spec.symbol, w.start, b.index, bandSize, price, sigma, now)),
    );
    return { symbol: market.spec.symbol, now, price, bandSize, sigmaPerSecond: sigma, windows, bands, cells };
  }

  account(player: string): Account {
    const name = player.trim();
    if (!PLAYER_NAME.test(name)) {
      throw new GameError('Player names are 1-32 characters: letters, digits, spaces, "_", "-" or ".".');
    }
    const key = name.toLowerCase();
    let account = this.accounts.get(key);
    if (!account) {
      account = { player: name, balance: this.settings.startingBalance, bets: [], wins: 0, losses: 0, voids: 0, staked: 0, returned: 0 };
      this.accounts.set(key, account);
    }
    return account;
  }

  /** Starts the player over with a fresh balance. Pending bets are forfeited. */
  resetAccount(player: string): Account {
    this.accounts.delete(this.account(player).player.toLowerCase());
    return this.account(player);
  }

  placeBet(player: string, cellId: string, amount: number): Bet {
    const account = this.account(player);
    const parts = /^([A-Za-z0-9]+)-(\d+)-(\d+)$/.exec(cellId.trim());
    if (!parts) {
      throw new GameError(
        `"${cellId}" isn't a cell id. Cell ids look like SIM-1760877060-2000 (symbol-windowStart-band); ` +
          'copy one from get_prediction_grid.',
      );
    }
    const { market, price, bandSize } = this.liveMarket(parts[1]);
    const windowStart = Number(parts[2]);
    const band = Number(parts[3]);
    const now = this.now;
    const { windowSeconds, betCloseSeconds, columns, layers, minBet } = this.settings;

    if (windowStart % windowSeconds !== 0) {
      throw new GameError(`${windowStart} isn't the start of a ${windowSeconds}-second window.`);
    }
    if (now >= windowStart - betCloseSeconds) {
      throw new GameError(
        `Betting on the ${clock(windowStart)} UTC window closed ${betCloseSeconds}s before it opened ` +
          `(it's now ${clock(now)} UTC). Pick a later window from a fresh grid.`,
      );
    }
    const lastWindow = this.nextWindowStart(now) + (columns - 1) * windowSeconds;
    if (windowStart > lastWindow) {
      throw new GameError(`That window is too far ahead; the latest open window starts at ${clock(lastWindow)} UTC.`);
    }
    const center = this.centerBand(price, bandSize);
    if (Math.abs(band - center) > layers) {
      throw new GameError(`Band #${band} is too far from the current price (band #${center}). Get a fresh grid.`);
    }
    if (!Number.isFinite(amount)) throw new GameError('Amount must be a number.');
    const stake = round2(amount);
    if (stake < minBet) throw new GameError(`The minimum bet is ${money(minBet)}.`);
    if (stake > account.balance) {
      throw new GameError(`Insufficient balance: you have ${money(account.balance)}, the bet is ${money(stake)}.`);
    }
    const cell = this.cell(market.spec.symbol, windowStart, band, bandSize, price, market.sigmaPerSecond(), now);
    if (account.bets.some((b) => b.cellId === cell.id)) {
      throw new GameError(`You already have a bet on ${cell.id}; one bet per box.`);
    }
    if (cell.odds === null) {
      throw new GameError(
        `That box is too likely to win (${(cell.probability * 100).toFixed(1)}%) to offer odds above ` +
          `${this.settings.minOdds}. Pick another band or a later window.`,
      );
    }

    account.balance = round2(account.balance - stake);
    const bet: Bet = {
      id: `bet-${++this.betCounter}`,
      cellId: cell.id,
      symbol: market.spec.symbol,
      windowStart,
      windowEnd: cell.windowEnd,
      low: cell.low,
      high: cell.high,
      amount: stake,
      odds: cell.odds,
      probability: cell.probability,
      priceAtBet: price,
      placedAt: now,
      status: 'pending',
      payout: 0,
    };
    account.bets.push(bet);
    return bet;
  }

  private settle(): void {
    const settledByPlayer = new Map<string, Bet[]>();
    for (const [key, account] of this.accounts) {
      for (const bet of account.bets) {
        if (bet.status !== 'pending') continue;
        const market = this.markets.get(bet.symbol)!;
        const latest = market.time;
        if (latest === undefined || latest < bet.windowEnd) continue;

        const candle = market.candleAt(bet.windowEnd);
        bet.settledAt = latest;
        if (!candle?.fresh) {
          bet.status = 'void';
          bet.payout = bet.amount;
          bet.note = 'No fresh price when the window closed, so the stake was refunded.';
          account.voids++;
        } else {
          const won = candle.close >= bet.low && candle.close < bet.high;
          bet.settlePrice = candle.close;
          bet.status = won ? 'won' : 'lost';
          bet.payout = won ? round2(bet.amount * bet.odds) : 0;
          if (won) account.wins++;
          else account.losses++;
          account.staked = round2(account.staked + bet.amount);
          account.returned = round2(account.returned + bet.payout);
        }
        account.balance = round2(account.balance + bet.payout);
        settledByPlayer.set(key, [...(settledByPlayer.get(key) ?? []), bet]);
      }
      const settled = account.bets.filter((b) => b.status !== 'pending');
      if (settled.length > MAX_SETTLED_HISTORY) {
        const dropped = new Set(settled.slice(0, settled.length - MAX_SETTLED_HISTORY));
        account.bets = account.bets.filter((b) => !dropped.has(b));
      }
    }
    for (const [key, bets] of settledByPlayer) this.emit('settled', key, bets);
  }

  /**
   * Resolves with the player's next batch of settled bets, or with nothing after
   * `timeoutSeconds` (or straight away if they have no pending bets).
   */
  waitForResults(player: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ settled: Bet[]; timedOut: boolean }> {
    const account = this.account(player);
    if (!account.bets.some((b) => b.status === 'pending')) return Promise.resolve({ settled: [], timedOut: false });
    const key = account.player.toLowerCase();
    return new Promise((resolve) => {
      const finish = (settled: Bet[], timedOut: boolean) => {
        clearTimeout(timer);
        this.off('settled', onSettled);
        signal?.removeEventListener('abort', onAbort);
        resolve({ settled, timedOut });
      };
      const onSettled = (settledKey: string, bets: Bet[]) => {
        if (settledKey === key) finish(bets, false);
      };
      const onAbort = () => finish([], true);
      const timer = setTimeout(() => finish([], true), timeoutSeconds * 1000);
      this.on('settled', onSettled);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
