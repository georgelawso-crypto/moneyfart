import type { PriceSize } from "../betfair/types.js";
import type { SelectionRecording, Trade } from "../recorder.js";

/** BFExplorer's candle window (MarketSelectionsCandleStickData) and price-metric window. */
export const CANDLE_WINDOW_MS = 300_000;
export const CANDLE_COUNT = 12;
export const METRIC_WINDOW_MS = 3_600_000;
export const METRIC_COUNT = 2;

export interface PricePoint {
  /** Epoch ms. */
  t: number;
  price: number;
  /** Matched size (0 when the point is a last-traded-price change without volume data). */
  size: number;
}

export interface PriceWindow {
  /** Time of the trade that opened the window (epoch ms). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Unrounded matched volume and Σ price·size of the window's trades. */
  volume: number;
  notional: number;
}

/**
 * BFExplorer's anchored windows: the first window opens at the first trade; each later one at
 * the first trade at or after the previous window's time + windowMs, so stretches without trades
 * produce no window. open = previous close (first window: its first price); high/low include the open.
 */
export function anchoredWindows(points: PricePoint[], windowMs: number): PriceWindow[] {
  const sorted = points.filter((p) => Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.t - b.t); // stable
  const windows: PriceWindow[] = [];
  let current: PriceWindow | undefined;
  for (const point of sorted) {
    if (!current || point.t >= current.time + windowMs) {
      const open = current?.close ?? point.price;
      current = { time: point.t, open, high: open, low: open, close: open, volume: 0, notional: 0 };
      windows.push(current);
    }
    current.high = Math.max(current.high, point.price);
    current.low = Math.min(current.low, point.price);
    current.close = point.price;
    current.volume += point.size;
    current.notional += point.price * point.size;
  }
  return windows;
}

/**
 * Recorded history of a selection: reconstructed trades when traded volume is available,
 * otherwise last-traded-price changes with zero volume (delayed application keys).
 */
export function recordedPoints(selection: SelectionRecording | undefined, volumeData: boolean): PricePoint[] {
  if (!selection) return [];
  if (volumeData) return selection.trades.map((t) => ({ t: t.t, price: t.price, size: t.size }));
  return selection.prices.map(([t, price]) => ({ t, price, size: 0 }));
}

export function sumSizes(levels: Array<{ size: number }> | undefined): number {
  return (levels ?? []).reduce((total, level) => total + level.size, 0);
}

/** Σp·s/Σs over a traded-volume ladder (unrounded); undefined without volume. */
export function ladderVwap(levels: PriceSize[] | undefined): number | undefined {
  const volume = sumSizes(levels);
  if (!levels?.length || !(volume > 0)) return undefined;
  return levels.reduce((total, level) => total + level.price * level.size, 0) / volume;
}

export interface SideVolume {
  volume: number;
  notional: number;
}

/** Volume and Σ price·size of back-initiated and lay-initiated trades (unclassified trades are ignored). */
/** Back/lay volumes since monitoring began, from the recorder's running totals (not limited to the retained trades). */
export function recordedSideVolumes(sel: SelectionRecording | undefined): { back: SideVolume; lay: SideVolume } {
  if (!sel) return { back: { volume: 0, notional: 0 }, lay: { volume: 0, notional: 0 } };
  return { back: { ...sel.totals.back }, lay: { ...sel.totals.lay } };
}

export function sideVolumes(trades: Trade[] | undefined): { back: SideVolume; lay: SideVolume } {
  const back = { volume: 0, notional: 0 };
  const lay = { volume: 0, notional: 0 };
  for (const trade of trades ?? []) {
    const side = trade.side === "back" ? back : trade.side === "lay" ? lay : undefined;
    if (!side) continue;
    side.volume += trade.size;
    side.notional += trade.price * trade.size;
  }
  return { back, lay };
}
