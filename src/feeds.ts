import { SECONDS_PER_YEAR } from './pricing.js';

/** Receives a price for `symbol`, published at `publishTime` (unix seconds). */
export type PriceListener = (symbol: string, price: number, publishTime: number) => void;

export interface PriceFeed {
  start(): void;
  stop(): void;
}

export const DEFAULT_HERMES_URL = 'https://hermes.pyth.network';

interface HermesParsedUpdate {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

/** Pulls `{ feedId, price, publishTime }` out of a Hermes /v2/updates/price/latest response. */
export function parseHermesResponse(body: unknown): { feedId: string; price: number; publishTime: number }[] {
  const parsed = (body as { parsed?: HermesParsedUpdate[] } | null)?.parsed;
  if (!Array.isArray(parsed)) throw new Error('Hermes response has no "parsed" array');
  return parsed.flatMap((update) => {
    const p = update?.price;
    if (!p) return [];
    const price = Number(p.price) * 10 ** p.expo;
    if (!Number.isFinite(price) || price <= 0) return [];
    return [{ feedId: update.id.replace(/^0x/, '').toLowerCase(), price, publishTime: p.publish_time }];
  });
}

/**
 * Polls Pyth's Hermes REST API once a second, fetching every Pyth-backed market
 * in one batched request so the public endpoint's rate limit isn't a problem.
 */
export class PythFeed implements PriceFeed {
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  private lastErrorLog = 0;
  /** Most recent polling error, cleared on the next success. */
  lastError?: string;

  constructor(
    /** Feed id (hex, no 0x) → market symbol. */
    private readonly feeds: Map<string, string>,
    private readonly onPrice: PriceListener,
    private readonly hermesUrl = DEFAULT_HERMES_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    if (this.timer || this.feeds.size === 0) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 1000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const url = new URL('/v2/updates/price/latest', this.hermesUrl);
      for (const id of this.feeds.keys()) url.searchParams.append('ids[]', id);
      url.searchParams.set('parsed', 'true');
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Hermes returned HTTP ${res.status}`);
      for (const { feedId, price, publishTime } of parseHermesResponse(await res.json())) {
        const symbol = this.feeds.get(feedId);
        if (symbol) this.onPrice(symbol, price, publishTime);
      }
      this.lastError = undefined;
    } catch (err) {
      // fetch() reports network failures as "fetch failed" with the reason in `cause`.
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
      this.lastError = err instanceof Error ? err.message + cause : String(err);
      // Log at most once a minute so an outage doesn't flood the logs.
      if (Date.now() - this.lastErrorLog > 60_000) {
        this.lastErrorLog = Date.now();
        console.error(`[pyth] price poll failed: ${this.lastError}`);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

/** Geometric random walk for markets that need no network. Moves once a second. */
export class SimulatedFeed implements PriceFeed {
  private timer?: NodeJS.Timeout;
  private price: number;
  private readonly sigmaPerSecond: number;

  constructor(
    private readonly symbol: string,
    startPrice: number,
    annualVolatility: number,
    private readonly onPrice: PriceListener,
    private readonly random: () => number = Math.random,
  ) {
    this.price = startPrice;
    this.sigmaPerSecond = annualVolatility / Math.sqrt(SECONDS_PER_YEAR);
  }

  start(): void {
    if (this.timer) return;
    this.emit();
    this.timer = setInterval(() => {
      this.step();
      this.emit();
    }, 1000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  step(): number {
    // Box-Muller: a standard normal draw from two uniforms.
    const z = Math.sqrt(-2 * Math.log(1 - this.random())) * Math.cos(2 * Math.PI * this.random());
    this.price *= Math.exp(this.sigmaPerSecond * z);
    return this.price;
  }

  private emit(): void {
    this.onPrice(this.symbol, this.price, Math.floor(Date.now() / 1000));
  }
}
