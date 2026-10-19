import type { BetfairApi } from "../src/betfair/client.js";
import type {
  ClearedOrderSummary,
  CurrentOrderSummary,
  MarketBook,
  MarketCatalogue,
  PlaceExecutionReport,
  PriceSize,
  Runner,
  RunnerCatalog,
} from "../src/betfair/types.js";

/** Shared test fixture: an in-memory Betfair Exchange with one horse race (WIN + PLACE markets). */

export const WIN_MARKET = "1.200000001";
export const PLACE_MARKET = "1.200000002";
/** Backwards-compatible alias. */
export const MARKET_ID = WIN_MARKET;
export const EVENT_ID = "33";

const levels = (pairs: Array<[number, number]>): PriceSize[] => pairs.map(([price, size]) => ({ price, size }));

function runner(selectionId: number, ltp: number, back: Array<[number, number]>, lay: Array<[number, number]>, matched: number): Runner {
  return {
    selectionId,
    handicap: 0,
    status: "ACTIVE",
    lastPriceTraded: ltp,
    totalMatched: matched,
    sp: { nearPrice: ltp + 0.1, farPrice: ltp - 0.2, backStakeTaken: [{ price: 1.01, size: 50 }], layLiabilityTaken: [] },
    ex: {
      availableToBack: levels(back),
      availableToLay: levels(lay),
      tradedVolume: levels([
        [ltp - 0.1, Math.round(matched * 40) / 100],
        [ltp, Math.round(matched * 60) / 100],
      ]),
    },
  };
}

const RUNNERS: RunnerCatalog[] = [
  {
    selectionId: 101,
    runnerName: "Fast Horse",
    handicap: 0,
    sortPriority: 1,
    metadata: {
      FORM: "1-21",
      OFFICIAL_RATING: "85",
      AGE: "5",
      SEX_TYPE: "g",
      JOCKEY_NAME: "J Smith",
      TRAINER_NAME: "T Jones",
      FORECASTPRICE_NUMERATOR: "2",
      FORECASTPRICE_DENOMINATOR: "1",
      WEIGHT_VALUE: "140",
      WEIGHT_UNITS: "pounds",
      STALL_DRAW: "3",
      DAYS_SINCE_LAST_RUN: "21",
    },
  },
  { selectionId: 102, runnerName: "Slow Horse", handicap: 0, sortPriority: 2, metadata: { FORM: "7-9", AGE: "4", SEX_TYPE: "f", FORECASTPRICE_NUMERATOR: "5", FORECASTPRICE_DENOMINATOR: "1", WEIGHT_VALUE: "126" } },
  { selectionId: 103, runnerName: "Mid Horse", handicap: 0, sortPriority: 3, metadata: { FORM: "3-4", AGE: "6", SEX_TYPE: "m", FORECASTPRICE_NUMERATOR: "7", FORECASTPRICE_DENOMINATOR: "2", WEIGHT_VALUE: "133" } },
];

export class FakeBetfair implements BetfairApi {
  readonly startTime = new Date(Math.ceil((Date.now() + 30 * 60000) / 60000) * 60000).toISOString();
  catalogues = new Map<string, MarketCatalogue>();
  books = new Map<string, MarketBook>();
  calls: Array<{ method: string; args: any }> = [];
  liveOrders: CurrentOrderSummary[] = [];
  cleared: ClearedOrderSummary[] = [];
  currencyCode = "GBP";
  funds = { availableToBetBalance: 500, exposure: -20, retainedCommission: 0, exposureLimit: -10000 };

  constructor() {
    const event = { id: EVENT_ID, name: "Ascot 19th Oct", venue: "Ascot", countryCode: "GB", timezone: "Europe/London" };
    const base = {
      marketStartTime: this.startTime,
      eventType: { id: "7", name: "Horse Racing" },
      event,
      runners: RUNNERS,
    };
    this.catalogues.set(WIN_MARKET, {
      ...structuredClone(base),
      marketId: WIN_MARKET,
      marketName: "2m Hcap",
      totalMatched: 5000,
      description: { marketType: "WIN", bspMarket: true, bettingType: "ODDS", marketBaseRate: 5, priceLadderDescription: { type: "CLASSIC" } },
    });
    this.catalogues.set(PLACE_MARKET, {
      ...structuredClone(base),
      marketId: PLACE_MARKET,
      marketName: "To Be Placed",
      totalMatched: 1500,
      description: { marketType: "PLACE", bspMarket: true, bettingType: "ODDS", marketBaseRate: 5, priceLadderDescription: { type: "CLASSIC" } },
    });
    this.books.set(WIN_MARKET, {
      marketId: WIN_MARKET,
      isMarketDataDelayed: false,
      status: "OPEN",
      inplay: false,
      betDelay: 0,
      numberOfWinners: 1,
      numberOfActiveRunners: 3,
      totalMatched: 5000,
      runners: [
        runner(101, 3.0, [[3.0, 100], [2.98, 80], [2.96, 60]], [[3.05, 80], [3.1, 60], [3.15, 40]], 3000),
        runner(102, 6.0, [[5.9, 100], [5.8, 80]], [[6.2, 80], [6.4, 60]], 800),
        runner(103, 4.5, [[4.4, 100], [4.3, 80]], [[4.6, 80], [4.7, 60]], 1200),
      ],
    });
    this.books.set(PLACE_MARKET, {
      marketId: PLACE_MARKET,
      isMarketDataDelayed: false,
      status: "OPEN",
      inplay: false,
      betDelay: 0,
      numberOfWinners: 2,
      numberOfActiveRunners: 3,
      totalMatched: 1500,
      runners: [
        runner(101, 1.5, [[1.5, 100]], [[1.52, 80]], 900),
        runner(102, 2.4, [[2.38, 100]], [[2.42, 80]], 300),
        runner(103, 1.9, [[1.89, 100]], [[1.91, 80]], 300),
      ],
    });
  }

  // ---------------------------------------------------------------- test helpers

  book(marketId = WIN_MARKET): MarketBook {
    return this.books.get(marketId)!;
  }

  runner(selectionId: number, marketId = WIN_MARKET): Runner {
    return this.book(marketId).runners.find((r) => r.selectionId === selectionId)!;
  }

  setRunner(selectionId: number, patch: Partial<Runner>, marketId = WIN_MARKET) {
    const book = this.book(marketId);
    book.runners = book.runners.map((r) => (r.selectionId === selectionId ? { ...r, ...patch } : r));
  }

  /** Replace the offered prices of a runner. */
  setOffers(selectionId: number, back: Array<[number, number]>, lay: Array<[number, number]>, marketId = WIN_MARKET) {
    const r = this.runner(selectionId, marketId);
    r.ex = { ...r.ex, availableToBack: levels(back), availableToLay: levels(lay) };
  }

  /** Simulate a trade: grows the traded-volume ladder, totalMatched and sets the last traded price. */
  trade(selectionId: number, price: number, size: number, marketId = WIN_MARKET) {
    const book = this.book(marketId);
    const r = this.runner(selectionId, marketId);
    const traded = r.ex?.tradedVolume ?? [];
    const level = traded.find((l) => l.price === price);
    if (level) level.size = Math.round((level.size + size) * 100) / 100;
    else traded.push({ price, size });
    traded.sort((a, b) => a.price - b.price);
    r.ex = { ...r.ex, tradedVolume: traded };
    r.totalMatched = Math.round(((r.totalMatched ?? 0) + size) * 100) / 100;
    r.lastPriceTraded = price;
    book.totalMatched = Math.round(((book.totalMatched ?? 0) + size) * 100) / 100;
  }

  /** Close (settle) a market: winners get WINNER (or the given status), everyone else LOSER. */
  settle(winners: number[], marketId = WIN_MARKET, options: { bsp?: Record<number, number>; removed?: number[] } = {}) {
    const book = this.book(marketId);
    book.status = "CLOSED";
    book.inplay = true;
    book.runners = book.runners.map((r) => ({
      ...r,
      status: options.removed?.includes(r.selectionId) ? "REMOVED" : winners.includes(r.selectionId) ? "WINNER" : "LOSER",
      lastPriceTraded: winners.includes(r.selectionId) ? 1.01 : 1000,
      sp: { ...r.sp, actualSP: options.bsp?.[r.selectionId] ?? r.sp?.nearPrice },
    }));
  }

  // ---------------------------------------------------------------- API

  async listEventTypes() {
    this.calls.push({ method: "listEventTypes", args: {} });
    return [
      { eventType: { id: "1", name: "Soccer" }, marketCount: 100 },
      { eventType: { id: "7", name: "Horse Racing" }, marketCount: 50 },
      { eventType: { id: "4339", name: "Greyhound Racing" }, marketCount: 20 },
    ];
  }

  async listMarketCatalogue(args: Parameters<BetfairApi["listMarketCatalogue"]>[0]) {
    this.calls.push({ method: "listMarketCatalogue", args });
    const f = args.filter;
    const projection = new Set(args.marketProjection ?? []);
    return [...this.catalogues.values()]
      .filter((c) => this.books.get(c.marketId)!.status !== "CLOSED") // Betfair never returns closed catalogues
      .filter((c) => !f.marketIds || f.marketIds.includes(c.marketId))
      .filter((c) => !f.eventIds || f.eventIds.includes(c.event!.id))
      .filter((c) => !f.marketTypeCodes || f.marketTypeCodes.includes(c.description!.marketType!))
      .filter((c) => !f.eventTypeIds || f.eventTypeIds.includes(c.eventType!.id))
      .filter((c) => !f.marketCountries || f.marketCountries.includes(c.event!.countryCode!))
      .slice(0, args.maxResults)
      .map((c) => {
        const copy = structuredClone(c);
        if (!projection.has("RUNNER_METADATA")) copy.runners = copy.runners?.map(({ metadata: _m, ...r }) => r);
        if (!projection.has("RUNNER_DESCRIPTION")) delete copy.runners;
        if (!projection.has("MARKET_DESCRIPTION")) delete copy.description;
        return copy;
      });
  }

  async listMarketBook(args: Parameters<BetfairApi["listMarketBook"]>[0]) {
    this.calls.push({ method: "listMarketBook", args });
    let books = args.marketIds.map((id) => this.books.get(id)).filter((b): b is MarketBook => Boolean(b));
    // Betfair: requests mixing OPEN and CLOSED markets only return the OPEN ones.
    if (books.some((b) => b.status === "CLOSED") && books.some((b) => b.status !== "CLOSED")) books = books.filter((b) => b.status !== "CLOSED");
    const priceData = new Set(args.priceProjection?.priceData ?? []);
    const depth = args.priceProjection?.exBestOffersOverrides?.bestPricesDepth ?? 3;
    return books.map((b) => {
      const copy = structuredClone(b);
      for (const r of copy.runners) {
        const ex = r.ex ?? {};
        const offers = priceData.has("EX_ALL_OFFERS") || priceData.has("EX_BEST_OFFERS");
        r.ex = {
          availableToBack: offers ? (priceData.has("EX_ALL_OFFERS") ? ex.availableToBack : ex.availableToBack?.slice(0, depth)) ?? [] : undefined,
          availableToLay: offers ? (priceData.has("EX_ALL_OFFERS") ? ex.availableToLay : ex.availableToLay?.slice(0, depth)) ?? [] : undefined,
          tradedVolume: priceData.has("EX_TRADED") ? (ex.tradedVolume ?? []) : undefined,
        };
        if (!priceData.size) delete r.ex;
        if (!priceData.has("SP_AVAILABLE") && !priceData.has("SP_TRADED")) delete r.sp;
      }
      return copy;
    });
  }

  async placeOrders(args: Parameters<BetfairApi["placeOrders"]>[0]): Promise<PlaceExecutionReport> {
    this.calls.push({ method: "placeOrders", args });
    return {
      status: "SUCCESS",
      marketId: args.marketId,
      customerRef: args.customerRef,
      instructionReports: args.instructions.map((instruction) => {
        const betId = `L${this.liveOrders.length + 1}`;
        this.liveOrders.push({
          betId,
          marketId: args.marketId,
          selectionId: instruction.selectionId,
          handicap: instruction.handicap ?? 0,
          priceSize: { price: instruction.limitOrder.price, size: instruction.limitOrder.size },
          side: instruction.side,
          status: "EXECUTION_COMPLETE",
          persistenceType: instruction.limitOrder.persistenceType,
          orderType: "LIMIT",
          placedDate: new Date().toISOString(),
          averagePriceMatched: instruction.limitOrder.price,
          sizeMatched: instruction.limitOrder.size,
          sizeRemaining: 0,
          customerStrategyRef: args.customerStrategyRef,
          customerOrderRef: instruction.customerOrderRef,
        });
        return {
          status: "SUCCESS" as const,
          instruction,
          betId,
          orderStatus: "EXECUTION_COMPLETE" as const,
          sizeMatched: instruction.limitOrder.size,
          averagePriceMatched: instruction.limitOrder.price,
          placedDate: new Date().toISOString(),
        };
      }),
    };
  }

  async cancelOrders(args: Parameters<BetfairApi["cancelOrders"]>[0]) {
    this.calls.push({ method: "cancelOrders", args });
    const targets = this.liveOrders.filter(
      (o) => o.marketId === args.marketId && (o.sizeRemaining ?? 0) > 0 && (!args.instructions || args.instructions.some((i) => i.betId === o.betId)),
    );
    return {
      status: "SUCCESS" as const,
      marketId: args.marketId ?? "",
      instructionReports: targets.map((o) => {
        const sizeCancelled = o.sizeRemaining ?? 0;
        o.sizeCancelled = (o.sizeCancelled ?? 0) + sizeCancelled;
        o.sizeRemaining = 0;
        o.status = "EXECUTION_COMPLETE";
        return { status: "SUCCESS" as const, instruction: { betId: o.betId }, sizeCancelled, cancelledDate: new Date().toISOString() };
      }),
    };
  }

  async listCurrentOrders(args: Parameters<BetfairApi["listCurrentOrders"]>[0]) {
    this.calls.push({ method: "listCurrentOrders", args });
    const orders = this.liveOrders
      .filter((o) => !args.marketIds || args.marketIds.includes(o.marketId))
      .filter((o) => !args.betIds || args.betIds.includes(o.betId))
      .filter((o) => !args.customerOrderRefs || (o.customerOrderRef !== undefined && args.customerOrderRefs.includes(o.customerOrderRef)))
      .filter((o) => !args.customerStrategyRefs || (o.customerStrategyRef !== undefined && args.customerStrategyRefs.includes(o.customerStrategyRef)))
      .filter((o) => args.orderProjection !== "EXECUTABLE" || o.status === "EXECUTABLE");
    const from = args.fromRecord ?? 0;
    const count = args.recordCount ?? 1000;
    return { currentOrders: orders.slice(from, from + count), moreAvailable: orders.length > from + count };
  }

  async listClearedOrders(args: Parameters<BetfairApi["listClearedOrders"]>[0]) {
    this.calls.push({ method: "listClearedOrders", args });
    const rows = this.cleared.filter((o) => !args.marketIds || args.marketIds.includes(o.marketId ?? ""));
    if (args.groupBy === "MARKET") {
      const byMarket = new Map<string, ClearedOrderSummary>();
      for (const o of rows) {
        const m = byMarket.get(o.marketId!) ?? { marketId: o.marketId, profit: 0, commission: 0, betCount: 0 };
        m.profit = (m.profit ?? 0) + (o.profit ?? 0);
        m.commission = (m.commission ?? 0) + (o.commission ?? 0);
        m.betCount = (m.betCount ?? 0) + 1;
        byMarket.set(o.marketId!, m);
      }
      return { clearedOrders: [...byMarket.values()], moreAvailable: false };
    }
    const from = args.fromRecord ?? 0;
    const count = args.recordCount ?? 1000;
    return { clearedOrders: rows.slice(from, from + count), moreAvailable: rows.length > from + count };
  }

  async getAccountFunds() {
    this.calls.push({ method: "getAccountFunds", args: {} });
    return { ...this.funds };
  }

  async getAccountDetails() {
    this.calls.push({ method: "getAccountDetails", args: {} });
    return { currencyCode: this.currencyCode };
  }
}
