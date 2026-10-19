import type { MarketBook, PriceSize, Runner } from "./betfair/types.js";
import { formatSelectionId, marketStatusName } from "./format.js";

/**
 * Who initiated a trade, judged against the previous best prices: a backer takes
 * availableToBack liquidity, so prints at or below the previous best back price;
 * a layer prints at or above the previous best lay price.
 */
export type TradeSide = "back" | "lay" | "unknown";

export interface Trade {
  /** Poll time (ms) at which the traded volume was observed. */
  t: number;
  price: number;
  size: number;
  side: TradeSide;
  inPlay: boolean;
}

/** Aggregates over every trade recorded since monitoring began (not trimmed like `trades`). */
export interface TradeTotals {
  volume: number;
  back: { volume: number; notional: number };
  lay: { volume: number; notional: number };
  minPrice?: number;
  maxPrice?: number;
}

export interface SelectionRecording {
  /** Formatted selection id. */
  key: string;
  firstSeen: number;
  /** Last traded price / matched volume when recording started (BFExplorer's "startPrice"). */
  startPrice?: number;
  startMatched?: number;
  lastPrice?: number;
  lastMatched?: number;
  bestBack?: number;
  bestLay?: number;
  status?: string;
  /** EX_TRADED baseline: the largest cumulative size seen per price. */
  traded?: Map<number, number>;
  /** Trades reconstructed from traded-volume growth between polls, oldest first (the newest maxTradesPerSelection). */
  trades: Trade[];
  totals: TradeTotals;
  /** Last-traded-price changes [time, price], oldest first (works without volume data). */
  prices: Array<[number, number]>;
  inPlayMin?: number;
  inPlayMax?: number;
}

export interface MarketRecording {
  marketId: string;
  startedAt: number;
  lastAt: number;
  /** False with delayed application keys, which return no traded volume. */
  volumeData: boolean;
  delayed: boolean;
  inPlay: boolean;
  status?: string;
  /** Selection keys ordered by price as last seen before the off (BFExplorer keeps this order in-play). */
  preOffOrder?: string[];
  selections: Map<string, SelectionRecording>;
}

function ladderMap(levels: PriceSize[] | undefined): Map<number, number> {
  return new Map((levels ?? []).map((l) => [l.price, l.size]));
}

/** Per-price maximum of two cumulative traded-volume ladders. */
function maxLadder(baseline: Map<number, number>, ladder: Map<number, number>): Map<number, number> {
  const merged = new Map(baseline);
  for (const [price, size] of ladder) merged.set(price, Math.max(merged.get(price) ?? 0, size));
  return merged;
}

export function classifyTrade(price: number, prevBack?: number, prevLay?: number): TradeSide {
  if (prevBack !== undefined && price <= prevBack + 1e-9) return "back";
  if (prevLay !== undefined && price >= prevLay - 1e-9) return "lay";
  return "unknown";
}

export class Recorder {
  private recordings = new Map<string, MarketRecording>();

  constructor(
    private readonly maxMarkets = 60,
    private readonly maxTradesPerSelection = 5000,
  ) {}

  get(marketId: string): MarketRecording | undefined {
    return this.recordings.get(marketId);
  }

  forget(marketId: string) {
    this.recordings.delete(marketId);
  }

  marketIds(): string[] {
    return [...this.recordings.keys()];
  }

  /** Fold a market book into the recording. Books should include EX_TRADED for volume data. */
  ingest(book: MarketBook, now = Date.now()): MarketRecording {
    let rec = this.recordings.get(book.marketId);
    if (rec) this.recordings.delete(book.marketId);
    else {
      rec = {
        marketId: book.marketId,
        startedAt: now,
        lastAt: now,
        volumeData: false,
        delayed: book.isMarketDataDelayed,
        inPlay: Boolean(book.inplay),
        selections: new Map(),
      };
    }
    this.recordings.set(book.marketId, rec); // most recently used last
    while (this.recordings.size > this.maxMarkets) this.recordings.delete(this.recordings.keys().next().value as string);

    rec.lastAt = now;
    rec.delayed = book.isMarketDataDelayed;
    rec.inPlay = Boolean(book.inplay);
    rec.status = marketStatusName(book.status);
    if (book.runners.some((r) => r.totalMatched !== undefined || (r.ex?.tradedVolume?.length ?? 0) > 0)) rec.volumeData = true;

    for (const runner of book.runners) this.ingestRunner(rec, runner, Boolean(book.inplay), now);

    if (book.status === "OPEN" && !book.inplay) {
      const priceOf = (r: Runner) => r.lastPriceTraded ?? r.ex?.availableToBack?.[0]?.price ?? 1000;
      rec.preOffOrder = book.runners
        .map((r, i) => ({ key: formatSelectionId(r.selectionId, r.handicap), price: priceOf(r), i }))
        .sort((a, b) => a.price - b.price || a.i - b.i)
        .map((x) => x.key);
    }
    return rec;
  }

  private ingestRunner(rec: MarketRecording, runner: Runner, inPlay: boolean, now: number) {
    const key = formatSelectionId(runner.selectionId, runner.handicap);
    let sel = rec.selections.get(key);
    const ladder = runner.ex?.tradedVolume !== undefined ? ladderMap(runner.ex.tradedVolume) : undefined;
    if (!sel) {
      sel = {
        key,
        firstSeen: now,
        startPrice: runner.lastPriceTraded,
        startMatched: runner.totalMatched,
        trades: [],
        totals: { volume: 0, back: { volume: 0, notional: 0 }, lay: { volume: 0, notional: 0 } },
        prices: runner.lastPriceTraded ? [[now, runner.lastPriceTraded]] : [],
        traded: ladder,
      };
      rec.selections.set(key, sel);
    } else {
      if (sel.startPrice === undefined && runner.lastPriceTraded) sel.startPrice = runner.lastPriceTraded;
      if (sel.startMatched === undefined && runner.totalMatched !== undefined) sel.startMatched = runner.totalMatched;
      if (ladder && sel.traded) this.diffTraded(sel, ladder, runner.lastPriceTraded, inPlay, now);
      // Traded volume only grows: an older ladder processed late must not lower the baseline, or the
      // volume between the two snapshots would be recorded again.
      if (ladder) sel.traded = sel.traded ? maxLadder(sel.traded, ladder) : ladder;
      const lastLogged = sel.prices[sel.prices.length - 1];
      if (runner.lastPriceTraded && (!lastLogged || lastLogged[1] !== runner.lastPriceTraded)) {
        sel.prices.push([now, runner.lastPriceTraded]);
        if (sel.prices.length > this.maxTradesPerSelection) sel.prices.splice(0, sel.prices.length - this.maxTradesPerSelection);
      }
    }
    sel.status = runner.status;
    if (runner.lastPriceTraded !== undefined) sel.lastPrice = runner.lastPriceTraded;
    if (runner.totalMatched !== undefined) sel.lastMatched = runner.totalMatched;
    if (inPlay && runner.lastPriceTraded) {
      sel.inPlayMin = Math.min(sel.inPlayMin ?? Infinity, runner.lastPriceTraded);
      sel.inPlayMax = Math.max(sel.inPlayMax ?? 0, runner.lastPriceTraded);
    }
    // Keep the previous best prices when this book carried no offers (e.g. a status-only fetch).
    if (runner.ex?.availableToBack !== undefined) sel.bestBack = runner.ex.availableToBack[0]?.price;
    if (runner.ex?.availableToLay !== undefined) sel.bestLay = runner.ex.availableToLay[0]?.price;
  }

  private diffTraded(sel: SelectionRecording, ladder: Map<number, number>, ltp: number | undefined, inPlay: boolean, now: number) {
    const fresh: Trade[] = [];
    for (const [price, size] of ladder) {
      const delta = size - (sel.traded!.get(price) ?? 0);
      if (delta > 0.005) {
        fresh.push({ t: now, price, size: Math.round(delta * 100) / 100, side: classifyTrade(price, sel.bestBack, sel.bestLay), inPlay });
      }
    }
    if (!fresh.length) return;
    // Order within one poll is unknown; put the print furthest from the new LTP first so the last trade is the LTP.
    if (ltp !== undefined) fresh.sort((a, b) => Math.abs(b.price - ltp) - Math.abs(a.price - ltp));
    sel.trades.push(...fresh);
    const totals = sel.totals;
    for (const trade of fresh) {
      totals.volume += trade.size;
      if (trade.side !== "unknown") {
        totals[trade.side].volume += trade.size;
        totals[trade.side].notional += trade.size * trade.price;
      }
      totals.minPrice = Math.min(totals.minPrice ?? Infinity, trade.price);
      totals.maxPrice = Math.max(totals.maxPrice ?? 0, trade.price);
    }
    if (sel.trades.length > this.maxTradesPerSelection) sel.trades.splice(0, sel.trades.length - this.maxTradesPerSelection);
    if (inPlay) {
      for (const trade of fresh) {
        sel.inPlayMin = Math.min(sel.inPlayMin ?? Infinity, trade.price);
        sel.inPlayMax = Math.max(sel.inPlayMax ?? 0, trade.price);
      }
    }
  }
}
