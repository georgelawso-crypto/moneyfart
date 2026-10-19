import type { MarketSpec } from './config.js';
import { SECONDS_PER_YEAR, bandSizeFor } from './pricing.js';

/** One second of price action. `fresh` is false when the feed had gone quiet by then. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  fresh: boolean;
}

export type MarketStatus = 'waiting' | 'live' | 'stale';

const HISTORY_SECONDS = 3600;
const VOLATILITY_LOOKBACK = 300;
const MIN_VOLATILITY_SAMPLES = 30;

/** Turns a stream of prices into a contiguous series of one-second candles. */
export class Market {
  private candles: Candle[] = [];
  private lastPrice?: number;
  private lastPublishTime = 0;
  private pendingHigh = -Infinity;
  private pendingLow = Infinity;
  /** Height of one price band; fixed from the first price so cell ids stay stable. */
  bandSize?: number;

  constructor(
    readonly spec: MarketSpec,
    private readonly staleAfterSeconds: number,
  ) {}

  onPrice(price: number, publishTime: number): void {
    if (!Number.isFinite(price) || price <= 0 || publishTime < this.lastPublishTime) return;
    this.lastPrice = price;
    this.lastPublishTime = publishTime;
    this.pendingHigh = Math.max(this.pendingHigh, price);
    this.pendingLow = Math.min(this.pendingLow, price);
    this.bandSize ??= bandSizeFor(price, this.spec.annualVolatility);
  }

  /** Closes one-second candles up to and including `now`, carrying the last price over quiet seconds. */
  advanceTo(now: number): void {
    if (this.lastPrice === undefined) return;
    let last = this.candles.at(-1);
    if (!last || now - last.time > HISTORY_SECONDS) {
      this.candles = [];
      last = this.closeCandle(now, this.lastPrice);
    }
    while (last.time < now) last = this.closeCandle(last.time + 1, last.close);
    if (this.candles.length > HISTORY_SECONDS) this.candles.splice(0, this.candles.length - HISTORY_SECONDS);
  }

  private closeCandle(time: number, open: number): Candle {
    const close = this.lastPrice!;
    const candle: Candle = {
      time,
      open,
      high: Math.max(open, close, this.pendingHigh),
      low: Math.min(open, close, this.pendingLow),
      close,
      fresh: time - this.lastPublishTime <= this.staleAfterSeconds,
    };
    this.pendingHigh = -Infinity;
    this.pendingLow = Infinity;
    this.candles.push(candle);
    return candle;
  }

  get price(): number | undefined {
    return this.lastPrice;
  }

  /** Time of the newest closed candle. */
  get time(): number | undefined {
    return this.candles.at(-1)?.time;
  }

  get priceAge(): number | undefined {
    return this.time === undefined ? undefined : this.time - this.lastPublishTime;
  }

  status(now: number): MarketStatus {
    if (this.lastPrice === undefined) return 'waiting';
    return now - this.lastPublishTime <= this.staleAfterSeconds ? 'live' : 'stale';
  }

  candleAt(time: number): Candle | undefined {
    const first = this.candles[0];
    if (!first) return undefined;
    const candle = this.candles[time - first.time];
    return candle?.time === time ? candle : undefined;
  }

  /**
   * Absolute volatility per √second: the RMS of recent fresh one-second moves,
   * floored at half the market's assumed volatility so a quiet spell (or a
   * closed market) doesn't make far-away bands look impossible.
   */
  sigmaPerSecond(): number {
    const price = this.lastPrice ?? 0;
    const assumed = (price * this.spec.annualVolatility) / Math.sqrt(SECONDS_PER_YEAR);
    const recent = this.candles.slice(-(VOLATILITY_LOOKBACK + 1));
    let sumSquares = 0;
    let samples = 0;
    for (let i = 1; i < recent.length; i++) {
      if (!recent[i].fresh || !recent[i - 1].fresh) continue;
      sumSquares += (recent[i].close - recent[i - 1].close) ** 2;
      samples++;
    }
    if (samples < MIN_VOLATILITY_SAMPLES) return assumed;
    return Math.max(Math.sqrt(sumSquares / samples), assumed / 2);
  }

  /** Candles over the last `lookbackSeconds`, merged into bars of `barSeconds` aligned to the clock. */
  bars(lookbackSeconds: number, barSeconds: number): Candle[] {
    const end = this.time;
    if (end === undefined) return [];
    const bars: Candle[] = [];
    for (const c of this.candles) {
      if (c.time <= end - lookbackSeconds) continue;
      const barTime = c.time - (c.time % barSeconds);
      const bar = bars.at(-1);
      if (bar?.time === barTime) {
        bar.high = Math.max(bar.high, c.high);
        bar.low = Math.min(bar.low, c.low);
        bar.close = c.close;
        bar.fresh &&= c.fresh;
      } else {
        bars.push({ ...c, time: barTime });
      }
    }
    return bars;
  }
}
