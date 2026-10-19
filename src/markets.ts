import type { BetfairApi } from "./betfair/client.js";
import type { MarketBook, MarketCatalogue, PriceData, Runner, RunnerCatalog } from "./betfair/types.js";
import type { MonitoredMarket, SelectionTick, State } from "./state.js";

export interface SelectionRef {
  selectionId: number;
  handicap: number;
}

/** BFExplorer formats selection ids as "<selectionId>_<handicap with 2 decimals>". */
export function formatSelectionId(selectionId: number, handicap = 0): string {
  return `${selectionId}_${handicap.toFixed(2)}`;
}

export function parseSelectionId(value: string | number): SelectionRef {
  if (typeof value === "number") return { selectionId: value, handicap: 0 };
  const match = /^\s*(\d+)(?:_(-?\d+(?:\.\d+)?))?\s*$/.exec(value);
  if (!match) throw new Error(`Invalid selectionId "${value}". Use the id from GetActiveMarket/GetMarket, e.g. "12345678_0.00".`);
  return { selectionId: Number(match[1]), handicap: match[2] ? Number(match[2]) : 0 };
}

export function sameSelection(a: SelectionRef, b: SelectionRef): boolean {
  return a.selectionId === b.selectionId && Math.abs(a.handicap - b.handicap) < 1e-9;
}

const MARKET_ID = /^\d\.\d+$/;

export function assertMarketId(marketId: string): string {
  const id = marketId.trim();
  if (!MARKET_ID.test(id)) throw new Error(`Invalid marketId "${marketId}". Betfair market ids look like "1.234567890".`);
  return id;
}

const titleCase = (value?: string) =>
  value ? value.toLowerCase().replace(/(^|_)([a-z])/g, (_, sep: string, c: string) => (sep ? " " : "") + c.toUpperCase()) : undefined;

const round = (value: number | undefined, digits = 2) =>
  value === undefined || value === null || !Number.isFinite(value) ? undefined : Math.round(value * 10 ** digits) / 10 ** digits;

const CATALOGUE_PROJECTION = [
  "EVENT",
  "EVENT_TYPE",
  "COMPETITION",
  "MARKET_START_TIME",
  "MARKET_DESCRIPTION",
  "RUNNER_DESCRIPTION",
  "RUNNER_METADATA",
];

const SPORT_ALIASES: Record<string, string> = {
  football: "soccer",
  horses: "horse racing",
  horse: "horse racing",
  racing: "horse racing",
  greyhounds: "greyhound racing",
  dogs: "greyhound racing",
  nfl: "american football",
};

const CATALOGUE_TTL_MS = 5 * 60 * 1000;
const EVENT_TYPES_TTL_MS = 60 * 60 * 1000;

export interface FindMarketsQuery {
  sport?: string;
  textQuery?: string;
  countries?: string[];
  venues?: string[];
  marketTypes?: string[];
  competitionIds?: string[];
  eventIds?: string[];
  inPlayOnly?: boolean;
  hoursAhead?: number;
  sort?: "FIRST_TO_START" | "MAXIMUM_TRADED" | "MAXIMUM_AVAILABLE" | "LAST_TO_START";
  maxResults?: number;
}

export interface MarketHeader {
  marketId: string;
  marketName: string;
  eventType?: string;
  eventName?: string;
  venue?: string;
  countryCode?: string;
  competition?: string;
  marketType?: string;
  startTime?: string;
  minutesToStart?: number;
  status?: string;
  inPlay?: boolean;
  betDelay?: number;
  totalMatched?: number;
  numberOfWinners?: number;
  numberOfActiveRunners?: number;
  bspMarket?: boolean;
  isMarketDataDelayed?: boolean;
}

export interface SelectionView {
  selectionId: string;
  name: string;
  status: string;
  price?: number;
  lastPriceTraded?: number;
  backPrice?: number;
  backSize?: number;
  layPrice?: number;
  laySize?: number;
  totalMatched?: number;
  impliedProbability?: number;
  sortPriority: number;
}

export interface MarketView {
  market: MarketHeader;
  selections: SelectionView[];
  bookPercentage?: number;
  activeSelectionId?: string;
}

type BookListener = (book: MarketBook) => void | Promise<void>;

export class MarketService {
  private catalogueCache = new Map<string, { at: number; catalogue: MarketCatalogue }>();
  private eventTypes?: { at: number; items: { id: string; name: string }[] };
  private listeners: BookListener[] = [];

  constructor(
    readonly api: BetfairApi,
    private readonly state: State,
    private readonly maxMonitoredMarkets = 20,
  ) {}

  /** Called for every market book fetched (paper trading uses this to match and settle). */
  onBook(listener: BookListener) {
    this.listeners.push(listener);
  }

  async resolveEventTypeIds(sport: string): Promise<string[]> {
    const wanted = sport.trim().toLowerCase();
    if (/^\d+$/.test(wanted)) return [wanted];
    if (!this.eventTypes || Date.now() - this.eventTypes.at > EVENT_TYPES_TTL_MS) {
      const result = await this.api.listEventTypes({});
      this.eventTypes = { at: Date.now(), items: result.map((r) => r.eventType) };
    }
    const target = SPORT_ALIASES[wanted] ?? wanted;
    const exact = this.eventTypes.items.filter((e) => e.name.toLowerCase() === target);
    const matches = exact.length ? exact : this.eventTypes.items.filter((e) => e.name.toLowerCase().includes(target));
    if (!matches.length) {
      const names = this.eventTypes.items.map((e) => e.name).sort().join(", ");
      throw new Error(`Unknown sport "${sport}". Available: ${names}`);
    }
    return matches.map((e) => e.id);
  }

  async findMarkets(query: FindMarketsQuery) {
    const now = Date.now();
    const hoursAhead = query.hoursAhead ?? 24;
    const filter = {
      textQuery: query.textQuery,
      eventTypeIds: query.sport ? await this.resolveEventTypeIds(query.sport) : undefined,
      marketCountries: query.countries?.map((c) => c.toUpperCase()),
      venues: query.venues,
      marketTypeCodes: query.marketTypes?.map((t) => t.toUpperCase()),
      competitionIds: query.competitionIds,
      eventIds: query.eventIds,
      inPlayOnly: query.inPlayOnly || undefined,
      marketStartTime: query.inPlayOnly
        ? undefined
        : { from: new Date(now - 5 * 60 * 1000).toISOString(), to: new Date(now + hoursAhead * 3600 * 1000).toISOString() },
    };
    const catalogues = await this.api.listMarketCatalogue({
      filter,
      marketProjection: ["EVENT", "EVENT_TYPE", "COMPETITION", "MARKET_START_TIME", "MARKET_DESCRIPTION", "RUNNER_DESCRIPTION"],
      sort: query.sort ?? "FIRST_TO_START",
      maxResults: Math.min(Math.max(query.maxResults ?? 10, 1), 100),
    });
    return catalogues.map((c) => ({ ...this.header(c), runners: c.runners?.length ?? 0 }));
  }

  async getCatalogue(marketId: string, refresh = false): Promise<MarketCatalogue> {
    const id = assertMarketId(marketId);
    const cached = this.catalogueCache.get(id);
    if (cached && !refresh && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.catalogue;
    const [catalogue] = await this.api.listMarketCatalogue({
      filter: { marketIds: [id] },
      marketProjection: CATALOGUE_PROJECTION,
      maxResults: 1,
    });
    if (!catalogue) throw new Error(`Market ${id} was not found (it may be closed, settled or not yet published).`);
    this.catalogueCache.set(id, { at: Date.now(), catalogue });
    return catalogue;
  }

  async getBook(marketId: string, priceData: PriceData[] = ["EX_BEST_OFFERS"], depth = 3): Promise<MarketBook> {
    const [book] = await this.getBooks([assertMarketId(marketId)], priceData, depth);
    if (!book) throw new Error(`No market book returned for ${marketId}. The market may have been purged after settlement.`);
    return book;
  }

  async getBooks(marketIds: string[], priceData: PriceData[] = ["EX_BEST_OFFERS"], depth = 3): Promise<MarketBook[]> {
    if (!marketIds.length) return [];
    const books = await this.api.listMarketBook({
      marketIds,
      priceProjection: {
        priceData,
        exBestOffersOverrides: priceData.includes("EX_BEST_OFFERS") ? { bestPricesDepth: depth } : undefined,
        virtualise: true,
      },
    });
    for (const book of books) {
      this.record(book);
      for (const listener of this.listeners) await listener(book);
    }
    return books;
  }

  private record(book: MarketBook) {
    const s: Record<string, SelectionTick> = {};
    for (const runner of book.runners) {
      if (runner.status !== "ACTIVE") continue;
      s[formatSelectionId(runner.selectionId, runner.handicap)] = [
        runner.lastPriceTraded ?? null,
        runner.ex?.availableToBack?.[0]?.price ?? null,
        runner.ex?.availableToLay?.[0]?.price ?? null,
        runner.totalMatched ?? null,
      ];
    }
    if (Object.keys(s).length) this.state.recordSnapshot(book.marketId, { t: Date.now(), s });
    const monitored = this.state.monitored.get(book.marketId);
    const status = titleCase(book.status);
    if (monitored && monitored.status !== status) {
      monitored.status = status;
      this.state.changed();
    }
  }

  header(catalogue: MarketCatalogue, book?: MarketBook): MarketHeader {
    const startTime = catalogue.marketStartTime ?? catalogue.description?.marketTime;
    return {
      marketId: catalogue.marketId,
      marketName: catalogue.marketName,
      eventType: catalogue.eventType?.name,
      eventName: catalogue.event?.name,
      venue: catalogue.event?.venue,
      countryCode: catalogue.event?.countryCode,
      competition: catalogue.competition?.name,
      marketType: catalogue.description?.marketType,
      startTime,
      minutesToStart: startTime ? Math.round((Date.parse(startTime) - Date.now()) / 60000) : undefined,
      status: book ? titleCase(book.status) : undefined,
      inPlay: book?.inplay,
      betDelay: book?.betDelay,
      totalMatched: round(book?.totalMatched ?? catalogue.totalMatched),
      numberOfWinners: book?.numberOfWinners,
      numberOfActiveRunners: book?.numberOfActiveRunners,
      bspMarket: catalogue.description?.bspMarket,
      isMarketDataDelayed: book?.isMarketDataDelayed,
    };
  }

  buildView(catalogue: MarketCatalogue, book: MarketBook): MarketView {
    const runnersById = new Map(book.runners.map((r) => [formatSelectionId(r.selectionId, r.handicap), r]));
    const selections: SelectionView[] = (catalogue.runners ?? [])
      .map((rc) => selectionView(rc, runnersById.get(formatSelectionId(rc.selectionId, rc.handicap))))
      .sort((a, b) => a.sortPriority - b.sortPriority);
    const backPrices = selections.filter((s) => s.status === "Active" && s.backPrice).map((s) => 1 / s.backPrice!);
    const view: MarketView = {
      market: this.header(catalogue, book),
      selections,
      bookPercentage: backPrices.length ? round(backPrices.reduce((a, b) => a + b, 0) * 100, 1) : undefined,
    };
    if (this.state.activeMarketId === catalogue.marketId && this.state.activeSelectionId) {
      view.activeSelectionId = this.state.activeSelectionId;
    }
    return view;
  }

  async getMarketView(marketId: string): Promise<MarketView> {
    const catalogue = await this.getCatalogue(marketId);
    const book = await this.getBook(marketId, ["EX_BEST_OFFERS"], 1);
    return this.buildView(catalogue, book);
  }

  /** Start monitoring a market (like opening it in BFExplorer) and make it the active market. */
  async openMarket(marketId: string): Promise<MarketView> {
    const catalogue = await this.getCatalogue(marketId, true);
    const view = await this.getMarketView(marketId);
    const entry: MonitoredMarket = {
      marketId: catalogue.marketId,
      marketName: catalogue.marketName,
      eventName: catalogue.event?.name ?? "",
      eventType: catalogue.eventType?.name ?? "",
      startTime: catalogue.marketStartTime,
      openedAt: new Date().toISOString(),
      status: view.market.status,
    };
    this.state.monitored.delete(entry.marketId);
    this.state.monitored.set(entry.marketId, entry);
    while (this.state.monitored.size > this.maxMonitoredMarkets) {
      const oldest = this.state.monitored.keys().next().value as string;
      this.state.monitored.delete(oldest);
    }
    if (this.state.activeMarketId !== entry.marketId) this.state.activeSelectionId = undefined;
    this.state.activeMarketId = entry.marketId;
    this.state.changed();
    return view;
  }

  findRunner(catalogue: MarketCatalogue, ref: SelectionRef): RunnerCatalog {
    const runner = catalogue.runners?.find((r) => sameSelection({ selectionId: r.selectionId, handicap: r.handicap }, ref));
    if (!runner) {
      throw new Error(
        `Selection ${formatSelectionId(ref.selectionId, ref.handicap)} is not in market ${catalogue.marketId} (${catalogue.marketName}).`,
      );
    }
    return runner;
  }
}

function selectionView(rc: RunnerCatalog, runner?: Runner): SelectionView {
  const back = runner?.ex?.availableToBack?.[0];
  const lay = runner?.ex?.availableToLay?.[0];
  const price = runner?.lastPriceTraded ?? back?.price ?? lay?.price;
  return {
    selectionId: formatSelectionId(rc.selectionId, rc.handicap),
    name: rc.runnerName,
    status: titleCase(runner?.status) ?? "Unknown",
    price,
    lastPriceTraded: runner?.lastPriceTraded,
    backPrice: back?.price,
    backSize: round(back?.size),
    layPrice: lay?.price,
    laySize: round(lay?.size),
    totalMatched: round(runner?.totalMatched),
    impliedProbability: price ? round(1 / price, 4) : undefined,
    sortPriority: rc.sortPriority,
  };
}

export { round, titleCase };
