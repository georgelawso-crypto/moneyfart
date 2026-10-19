import type { BetfairApi } from "./betfair/client.js";
import type { MarketBook, MarketCatalogue, PriceData, Runner, RunnerCatalog } from "./betfair/types.js";
import {
  assertMarketId,
  formatSelectionId,
  marketStatusName,
  round,
  runnerStatusName,
  sameSelection,
  utcSeconds,
  type SelectionRef,
} from "./format.js";
import type { Recorder } from "./recorder.js";
import type { MonitoredMarket, SettledMarket, State } from "./state.js";

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

/** Market types without a near start time (outrights, ante-post): searched without a time window. */
const LONG_TERM_TYPES = new Set(["WINNER", "ANTEPOST_WIN", "OUTRIGHT", "TOP_GOALSCORER", "TOURNAMENT_WINNER", "SPECIAL"]);

const CATALOGUE_TTL_MS = 5 * 60 * 1000;
const EVENT_TYPES_TTL_MS = 60 * 60 * 1000;
/** Betfair's market data request limit (sum of projection weights x markets). */
const MAX_WEIGHT = 200;

/** BFExplorer's "My favourite bet events" groups, reproduced as market searches. */
export const FAVOURITE_BET_EVENTS: Record<string, FindMarketsQuery> = {
  "Horse Racing - GB and IE": { sport: "7", countries: ["GB", "IE"], marketTypes: ["WIN"], hoursAhead: 24 },
  Football: { sport: "1", marketTypes: ["MATCH_ODDS"], hoursAhead: 24 },
  "Football - In-Play Now": { sport: "1", marketTypes: ["MATCH_ODDS"], inPlayOnly: true },
  "Football - Over/Under 2.5 Goals": { sport: "1", marketTypes: ["OVER_UNDER_25"], hoursAhead: 24 },
  "Tennis - In-Play Now": { sport: "2", marketTypes: ["MATCH_ODDS"], inPlayOnly: true },
  "Greyhound Racing": { sport: "4339", countries: ["GB"], marketTypes: ["WIN"], hoursAhead: 12 },
  Cricket: { sport: "4", marketTypes: ["MATCH_ODDS"], hoursAhead: 48 },
};

export interface FindMarketsQuery {
  sport?: string;
  textQuery?: string;
  countries?: string[];
  venues?: string[];
  marketTypes?: string[];
  competitionIds?: string[];
  eventIds?: string[];
  marketIds?: string[];
  inPlayOnly?: boolean;
  /** Include markets that started up to this many hours ago (default 4, so in-play events are found). */
  fromHoursAgo?: number;
  hoursAhead?: number;
  sort?: "FIRST_TO_START" | "MAXIMUM_TRADED" | "MAXIMUM_AVAILABLE" | "LAST_TO_START";
  maxResults?: number;
}

export interface BookOptions {
  /** Price levels per side for EX_BEST_OFFERS (default 3). */
  depth?: number;
  /** Full ladders (EX_ALL_OFFERS) instead of best offers. */
  allOffers?: boolean;
  /** Include Betfair Starting Price data (SP_AVAILABLE + SP_TRADED). */
  sp?: boolean;
}

/** Rich connector view (get_market_details). */
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
}

/** BFExplorer's get_active_market / get_market payload (encoded as TOON by the server). */
export interface BfexplorerMarket {
  marketId: string;
  startTime?: string;
  eventType?: string;
  eventName?: string;
  marketName: string;
  totalMatched: number;
  status?: string;
  /** Connector addition (omitted with BFEXPLORER_STRICT): BFExplorer keeps status "Open" in-play. */
  inPlay?: boolean;
  selections: Array<{ selectionId: string; name: string; price: number; totalMatched: number; status: string }>;
}

type BookListener = (book: MarketBook) => void | Promise<void>;

function projectionWeight(opts: BookOptions): number {
  const depth = Math.max(1, opts.depth ?? 3);
  let weight = opts.allOffers ? 17 : Math.ceil((5 * depth) / 3);
  weight += 17; // EX_TRADED is always requested (recorder)
  if (opts.sp) weight += 3 + 7;
  return weight;
}

export class MarketService {
  private catalogueCache = new Map<string, { at: number; catalogue: MarketCatalogue }>();
  private eventTypes?: { at: number; items: { id: string; name: string }[] };
  private listeners: BookListener[] = [];

  constructor(
    readonly api: BetfairApi,
    private readonly state: State,
    readonly recorder: Recorder,
    private readonly maxMonitoredMarkets = 20,
  ) {}

  /** Called for every market book fetched (paper trading uses this to match and settle). */
  onBook(listener: BookListener) {
    this.listeners.push(listener);
  }

  // ------------------------------------------------------------------ search

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
      throw new Error(`Unknown sport "${sport}". Available: ${this.eventTypes.items.map((e) => e.name).sort().join(", ")}`);
    }
    return matches.map((e) => e.id);
  }

  async findMarkets(query: FindMarketsQuery) {
    const now = Date.now();
    const types = query.marketTypes?.map((t) => t.toUpperCase());
    const longTerm = types?.some((t) => LONG_TERM_TYPES.has(t)) ?? false;
    const timeFiltered = !query.inPlayOnly && !query.marketIds?.length && (!longTerm || query.hoursAhead !== undefined);
    const filter = {
      textQuery: query.textQuery,
      eventTypeIds: query.sport ? await this.resolveEventTypeIds(query.sport) : undefined,
      marketCountries: query.countries?.map((c) => c.toUpperCase()),
      venues: query.venues,
      marketTypeCodes: types,
      competitionIds: query.competitionIds,
      eventIds: query.eventIds,
      marketIds: query.marketIds,
      inPlayOnly: query.inPlayOnly || undefined,
      marketStartTime: timeFiltered
        ? {
            from: new Date(now - (query.fromHoursAgo ?? 4) * 3600_000).toISOString(),
            to: new Date(now + (query.hoursAhead ?? 24) * 3600_000).toISOString(),
          }
        : undefined,
    };
    const catalogues = await this.api.listMarketCatalogue({
      filter,
      marketProjection: ["EVENT", "EVENT_TYPE", "COMPETITION", "MARKET_START_TIME", "MARKET_DESCRIPTION", "RUNNER_DESCRIPTION"],
      sort: query.sort ?? "FIRST_TO_START",
      maxResults: Math.min(Math.max(query.maxResults ?? 10, 1), 100),
    });
    // Status/in-play flags so the agent can tell running events from upcoming ones (weight 2 per market).
    const status = new Map<string, MarketBook>();
    for (let i = 0; i < catalogues.length; i += 100) {
      const books = await this.api.listMarketBook({ marketIds: catalogues.slice(i, i + 100).map((c) => c.marketId) });
      for (const b of books) status.set(b.marketId, b);
    }
    return catalogues.map((c) => {
      const book = status.get(c.marketId);
      return {
        ...this.header(c, book),
        suspendTime: c.description?.suspendTime,
        runners: c.runners?.length ?? 0,
      };
    });
  }

  // ------------------------------------------------------------------ catalogue

  /** Snapshot of a catalogue fetched earlier, from memory, monitored markets or the settled archive. */
  cachedCatalogue(marketId: string): MarketCatalogue | undefined {
    return (
      this.catalogueCache.get(marketId)?.catalogue ??
      this.state.monitored.get(marketId)?.catalogue ??
      archiveCatalogue(this.state.archive.get(marketId))
    );
  }

  /**
   * Full catalogue (with runner metadata). Betfair stops returning catalogues for closed
   * markets, so fall back to the last snapshot instead of failing after settlement.
   */
  async getCatalogue(marketId: string, refresh = false): Promise<MarketCatalogue> {
    const id = assertMarketId(marketId);
    const cached = this.catalogueCache.get(id);
    if (cached && !refresh && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.catalogue;
    let catalogue: MarketCatalogue | undefined;
    try {
      [catalogue] = await this.api.listMarketCatalogue({ filter: { marketIds: [id] }, marketProjection: CATALOGUE_PROJECTION, maxResults: 1 });
    } catch (error) {
      const fallback = this.cachedCatalogue(id);
      if (fallback) return fallback;
      throw error;
    }
    if (catalogue) {
      this.catalogueCache.set(id, { at: Date.now(), catalogue });
      const monitored = this.state.monitored.get(id);
      if (monitored) {
        monitored.catalogue = catalogue;
        this.state.changed();
      }
      return catalogue;
    }
    const fallback = this.cachedCatalogue(id);
    if (fallback) return fallback;
    throw new Error(`Market ${id} was not found (it may be closed, settled or not yet published).`);
  }

  findRunner(catalogue: MarketCatalogue, ref: SelectionRef): RunnerCatalog {
    const runner = catalogue.runners?.find((r) => sameSelection({ selectionId: r.selectionId, handicap: r.handicap }, ref));
    if (!runner) {
      throw new Error(`Selection ${formatSelectionId(ref.selectionId, ref.handicap)} is not in market ${catalogue.marketId} (${catalogue.marketName}).`);
    }
    return runner;
  }

  /** The market of another type for the same race/event (e.g. the PLACE market of a WIN market). */
  async findSiblingMarket(catalogue: MarketCatalogue, marketType: string): Promise<MarketCatalogue | undefined> {
    const eventId = catalogue.event?.id;
    if (!eventId) return undefined;
    const start = catalogue.marketStartTime;
    const candidates = await this.api.listMarketCatalogue({
      filter: { eventIds: [eventId], marketTypeCodes: [marketType], marketStartTime: start ? { from: start, to: start } : undefined },
      marketProjection: CATALOGUE_PROJECTION,
      maxResults: 10,
    });
    const match = candidates.find((c) => !start || c.marketStartTime === start) ?? candidates[0];
    if (match) this.catalogueCache.set(match.marketId, { at: Date.now(), catalogue: match });
    return match;
  }

  // ------------------------------------------------------------------ books

  async getBook(marketId: string, opts: BookOptions = {}): Promise<MarketBook> {
    const id = assertMarketId(marketId);
    const [book] = await this.getBooks([id], opts);
    if (!book) throw new Error(`No market book returned for ${id}. The market may have been purged after settlement.`);
    return book;
  }

  /**
   * Fetch books in weight-limited batches. Betfair only returns OPEN markets when a request
   * mixes OPEN and CLOSED ones, so ids missing from a batch are re-requested one by one.
   */
  async getBooks(marketIds: string[], opts: BookOptions = {}): Promise<MarketBook[]> {
    const ids = [...new Set(marketIds.map(assertMarketId))];
    if (!ids.length) return [];
    const priceData: PriceData[] = [opts.allOffers ? "EX_ALL_OFFERS" : "EX_BEST_OFFERS", "EX_TRADED"];
    if (opts.sp) priceData.push("SP_AVAILABLE", "SP_TRADED");
    const projection = {
      priceData,
      exBestOffersOverrides: opts.allOffers ? undefined : { bestPricesDepth: Math.max(1, opts.depth ?? 3) },
      virtualise: true,
    };
    const perRequest = Math.max(1, Math.floor(MAX_WEIGHT / projectionWeight(opts)));
    const books: MarketBook[] = [];
    for (let i = 0; i < ids.length; i += perRequest) {
      const batch = ids.slice(i, i + perRequest);
      const result = await this.api.listMarketBook({ marketIds: batch, priceProjection: projection });
      books.push(...result);
      if (batch.length > 1) {
        const returned = new Set(result.map((b) => b.marketId));
        for (const missing of batch.filter((id) => !returned.has(id))) {
          books.push(...(await this.api.listMarketBook({ marketIds: [missing], priceProjection: projection })));
        }
      }
    }
    for (const book of books) await this.process(book);
    return books;
  }

  private async process(book: MarketBook) {
    this.recorder.ingest(book);
    const monitored = this.state.monitored.get(book.marketId);
    const status = marketStatusName(book.status);
    if (monitored && (monitored.status !== status || monitored.inPlay !== Boolean(book.inplay))) {
      monitored.status = status;
      monitored.inPlay = Boolean(book.inplay);
      this.state.changed();
    }
    if (book.status === "CLOSED" && book.runners.every((r) => r.status !== "ACTIVE")) {
      const archived = this.state.archive.get(book.marketId);
      if (!archived || archived.runners.every((r) => r.bsp === undefined)) await this.archiveWithSp(book);
    }
    for (const listener of this.listeners) {
      try {
        await listener(book);
      } catch (error) {
        console.error(`[markets] book listener failed for ${book.marketId}: ${(error as Error).message}`);
      }
    }
  }

  /** Archive a settled book, fetching Betfair Starting Prices when the book was requested without SP. */
  private async archiveWithSp(book: MarketBook) {
    let withSp = book;
    if (book.runners.every((r) => r.sp === undefined)) {
      try {
        const [spBook] = await this.api.listMarketBook({ marketIds: [book.marketId], priceProjection: { priceData: ["SP_TRADED"] } });
        if (spBook) withSp = spBook;
      } catch {
        // BSPs are optional; archive the result without them.
      }
    }
    this.archiveSettled(withSp);
  }

  /**
   * Record a settled market's results (runner statuses, BSP, in-play range) in the archive, or add
   * BSPs to an entry archived earlier without them.
   */
  archiveSettled(book: MarketBook) {
    const bsp = new Map(book.runners.map((r) => [formatSelectionId(r.selectionId, r.handicap), finiteOrUndefined(r.sp?.actualSP)]));
    const existing = this.state.archive.get(book.marketId);
    if (existing) {
      if ([...bsp.values()].every((v) => v === undefined)) return;
      const runners = existing.runners.map((r) => ({ ...r, bsp: r.bsp ?? bsp.get(formatSelectionId(r.selectionId, r.handicap)) }));
      this.state.archiveMarket({ ...existing, runners });
      return;
    }
    const catalogue = this.cachedCatalogue(book.marketId);
    const rec = this.recorder.get(book.marketId);
    const names = new Map((catalogue?.runners ?? []).map((r) => [formatSelectionId(r.selectionId, r.handicap), r]));
    const settled: SettledMarket = {
      marketId: book.marketId,
      marketName: catalogue?.marketName ?? book.marketId,
      eventId: catalogue?.event?.id || undefined,
      eventName: catalogue?.event?.name || undefined,
      venue: catalogue?.event?.venue,
      countryCode: catalogue?.event?.countryCode,
      eventType: catalogue?.eventType?.name,
      marketType: catalogue?.description?.marketType,
      startTime: catalogue?.marketStartTime,
      settledAt: new Date().toISOString(),
      numberOfWinners: book.numberOfWinners,
      runners: book.runners.map((r) => {
        const key = formatSelectionId(r.selectionId, r.handicap);
        const sel = rec?.selections.get(key);
        return {
          selectionId: r.selectionId,
          handicap: r.handicap,
          name: names.get(key)?.runnerName ?? key,
          status: runnerStatusName(r.status) ?? r.status,
          sortPriority: names.get(key)?.sortPriority,
          bsp: bsp.get(key),
          inPlayMin: sel?.inPlayMin,
          inPlayMax: sel?.inPlayMax,
          lastPriceTraded: r.lastPriceTraded,
        };
      }),
    };
    this.state.archiveMarket(settled);
  }

  // ------------------------------------------------------------------ monitoring

  /** Start monitoring a market (like opening it in BFExplorer); optionally make it the default active market. */
  async openMarket(marketId: string, options: { activate?: boolean; companionOf?: string } = {}): Promise<{ catalogue: MarketCatalogue; book: MarketBook }> {
    const catalogue = await this.getCatalogue(marketId, true);
    const book = await this.getBook(catalogue.marketId);
    const existing = this.state.monitored.get(catalogue.marketId);
    const entry: MonitoredMarket = {
      marketId: catalogue.marketId,
      openedAt: existing?.openedAt ?? new Date().toISOString(),
      status: marketStatusName(book.status),
      inPlay: Boolean(book.inplay),
      catalogue,
      // An explicit open makes the market a primary one; a companion open never demotes a primary market.
      companionOf: options.companionOf && (!existing || existing.companionOf) ? options.companionOf : undefined,
    };
    this.state.monitored.delete(entry.marketId);
    this.state.monitored.set(entry.marketId, entry);
    this.evictMonitored(entry);
    if (options.activate) {
      if (this.state.activeMarketId !== entry.marketId) this.state.activeSelectionId = undefined;
      this.state.activeMarketId = entry.marketId;
    }
    this.state.changed();
    return { catalogue, book };
  }

  /**
   * Keep the monitored list within MAX_MONITORED_MARKETS: drop closed markets first, then
   * companions (PLACE markets read for a WIN market), then the oldest primary market. Opening a
   * companion never evicts a primary market (the list may then briefly exceed the limit).
   */
  private evictMonitored(added: MonitoredMarket) {
    const monitored = this.state.monitored;
    const candidates = (predicate: (m: MonitoredMarket) => boolean) =>
      [...monitored.values()].filter((m) => m.marketId !== added.marketId && predicate(m));
    while (monitored.size > this.maxMonitoredMarkets) {
      const victim =
        candidates((m) => m.status === "Closed")[0] ??
        candidates((m) => Boolean(m.companionOf))[0] ??
        (added.companionOf ? undefined : candidates(() => true)[0]);
      if (!victim) return;
      monitored.delete(victim.marketId);
      // A companion is only useful with its primary market.
      for (const m of [...monitored.values()]) if (m.companionOf === victim.marketId) monitored.delete(m.marketId);
    }
  }

  /** Market ids the recorder should poll: monitored markets that are not closed. */
  monitoredMarketIds(): string[] {
    return [...this.state.monitored.values()].filter((m) => m.status !== "Closed").map((m) => m.marketId);
  }

  // ------------------------------------------------------------------ views

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
      startTime: startTime ? utcSeconds(startTime) : undefined,
      minutesToStart: startTime ? Math.round((Date.parse(startTime) - Date.now()) / 60000) : undefined,
      status: book ? marketStatusName(book.status) : undefined,
      inPlay: book?.inplay,
      betDelay: book?.betDelay,
      totalMatched: round(book?.totalMatched ?? catalogue.totalMatched),
      numberOfWinners: book?.numberOfWinners,
      numberOfActiveRunners: book?.numberOfActiveRunners,
      bspMarket: catalogue.description?.bspMarket,
      isMarketDataDelayed: book?.isMarketDataDelayed,
    };
  }

  /** Rich JSON view with best prices and depth-1 volumes (connector tool get_market_details). */
  buildView(catalogue: MarketCatalogue, book: MarketBook): MarketView {
    const runners = new Map(book.runners.map((r) => [formatSelectionId(r.selectionId, r.handicap), r]));
    const selections = (catalogue.runners ?? [])
      .map((rc) => selectionView(rc, runners.get(formatSelectionId(rc.selectionId, rc.handicap))))
      .sort((a, b) => a.sortPriority - b.sortPriority);
    const oddsMarket = (catalogue.description?.bettingType ?? "ODDS") === "ODDS" && (catalogue.runners ?? []).every((r) => !r.handicap);
    const backPrices = selections.filter((s) => s.status === "Active" && s.backPrice).map((s) => 1 / s.backPrice!);
    return {
      market: this.header(catalogue, book),
      selections,
      bookPercentage: oddsMarket && backPrices.length ? round(backPrices.reduce((a, b) => a + b, 0) * 100, 1) : undefined,
    };
  }

  /**
   * BFExplorer's market payload: 7 scalars plus selections{selectionId,name,price,totalMatched,status}.
   * price is the last traded price; rows are sorted by price before the off and keep the
   * pre-off order once in-play or suspended.
   */
  bfexplorerMarket(catalogue: MarketCatalogue, book: MarketBook, strict = false): BfexplorerMarket {
    const runners = new Map(book.runners.map((r) => [formatSelectionId(r.selectionId, r.handicap), r]));
    const rows = (catalogue.runners ?? [])
      .slice()
      .sort((a, b) => a.sortPriority - b.sortPriority)
      .map((rc) => {
        const key = formatSelectionId(rc.selectionId, rc.handicap);
        const runner = runners.get(key);
        return {
          selectionId: key,
          name: rc.runnerName,
          price: runner?.lastPriceTraded ?? runner?.ex?.availableToBack?.[0]?.price ?? 1000,
          totalMatched: round(runner?.totalMatched) ?? 0,
          status: runnerStatusName(runner?.status) ?? "Active",
        };
      });
    const preOff = book.status === "OPEN" && !book.inplay;
    const order = this.recorder.get(book.marketId)?.preOffOrder;
    if (preOff) rows.sort((a, b) => a.price - b.price);
    else if (order) rows.sort((a, b) => indexIn(order, a.selectionId) - indexIn(order, b.selectionId));
    const startTime = catalogue.marketStartTime ?? catalogue.description?.marketTime;
    return {
      marketId: catalogue.marketId,
      startTime: startTime ? utcSeconds(startTime) : undefined,
      eventType: catalogue.eventType?.name,
      eventName: catalogue.event?.venue ?? catalogue.event?.name,
      marketName: catalogue.marketName,
      totalMatched: round(book.totalMatched ?? catalogue.totalMatched) ?? 0,
      status: marketStatusName(book.status),
      inPlay: strict ? undefined : Boolean(book.inplay),
      selections: rows,
    };
  }

  // ------------------------------------------------------------------ favourites

  favouriteBetEvents(): string[] {
    return Object.keys(FAVOURITE_BET_EVENTS);
  }

  async favouriteBetEventMarkets(name: string) {
    const key = Object.keys(FAVOURITE_BET_EVENTS).find((k) => k.toLowerCase() === name.trim().toLowerCase());
    if (!key) throw new Error(`Unknown favourite bet event "${name}". Available: ${this.favouriteBetEvents().join(", ")}`);
    return this.findMarkets({ ...FAVOURITE_BET_EVENTS[key], maxResults: 50 });
  }
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function indexIn(order: string[], key: string): number {
  const i = order.indexOf(key);
  return i < 0 ? order.length : i;
}

function selectionView(rc: RunnerCatalog, runner?: Runner): SelectionView {
  const back = runner?.ex?.availableToBack?.[0];
  const lay = runner?.ex?.availableToLay?.[0];
  const price = runner?.lastPriceTraded ?? back?.price ?? lay?.price;
  return {
    selectionId: formatSelectionId(rc.selectionId, rc.handicap),
    name: rc.runnerName,
    status: runnerStatusName(runner?.status) ?? "Unknown",
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

/** Rebuild a minimal catalogue from an archived settled market. */
function archiveCatalogue(settled?: SettledMarket): MarketCatalogue | undefined {
  if (!settled) return undefined;
  return {
    marketId: settled.marketId,
    marketName: settled.marketName,
    marketStartTime: settled.startTime,
    description: { marketType: settled.marketType },
    eventType: settled.eventType ? { id: "", name: settled.eventType } : undefined,
    event: { id: settled.eventId ?? "", name: settled.eventName ?? "", venue: settled.venue, countryCode: settled.countryCode },
    runners: settled.runners.map((r, i) => ({
      selectionId: r.selectionId,
      handicap: r.handicap,
      runnerName: r.name,
      sortPriority: r.sortPriority ?? i + 1,
    })),
  };
}
