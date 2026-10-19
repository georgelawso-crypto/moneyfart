import type { BetfairApi } from "../src/betfair/client.js";
import type {
  CurrentOrderSummary,
  MarketBook,
  MarketCatalogue,
  PlaceExecutionReport,
  Runner,
} from "../src/betfair/types.js";

export const MARKET_ID = "1.200000001";

const runner = (selectionId: number, ltp: number, back: number[], lay: number[], matched: number): Runner => ({
  selectionId,
  handicap: 0,
  status: "ACTIVE",
  lastPriceTraded: ltp,
  totalMatched: matched,
  sp: { nearPrice: ltp + 0.1, farPrice: ltp - 0.2, backStakeTaken: [{ price: 1.01, size: 50 }], layLiabilityTaken: [] },
  ex: {
    availableToBack: back.map((price, i) => ({ price, size: 100 - i * 20 })),
    availableToLay: lay.map((price, i) => ({ price, size: 80 - i * 20 })),
    tradedVolume: [
      { price: ltp - 0.1, size: matched * 0.4 },
      { price: ltp, size: matched * 0.6 },
    ],
  },
});

/** In-memory stand-in for the Betfair API with one horse race. */
export class FakeBetfair implements BetfairApi {
  catalogue: MarketCatalogue = {
    marketId: MARKET_ID,
    marketName: "2m Hcap",
    marketStartTime: new Date(Date.now() + 30 * 60000).toISOString(),
    totalMatched: 5000,
    description: { marketType: "WIN", bspMarket: true, bettingType: "ODDS" },
    eventType: { id: "7", name: "Horse Racing" },
    event: { id: "33", name: "Ascot 19th Oct", venue: "Ascot", countryCode: "GB" },
    runners: [
      {
        selectionId: 101,
        runnerName: "Fast Horse",
        handicap: 0,
        sortPriority: 1,
        metadata: { FORM: "1-21", OFFICIAL_RATING: "85", AGE: "5", JOCKEY_NAME: "J Smith", TRAINER_NAME: "T Jones", FORECASTPRICE_NUMERATOR: "2", FORECASTPRICE_DENOMINATOR: "1", WEIGHT_VALUE: "140", WEIGHT_UNITS: "pounds", STALL_DRAW: "3", DAYS_SINCE_LAST_RUN: "21" },
      },
      { selectionId: 102, runnerName: "Slow Horse", handicap: 0, sortPriority: 2, metadata: { FORM: "7-9", FORECASTPRICE_NUMERATOR: "5", FORECASTPRICE_DENOMINATOR: "1" } },
      { selectionId: 103, runnerName: "Mid Horse", handicap: 0, sortPriority: 3, metadata: { FORM: "3-4", FORECASTPRICE_NUMERATOR: "7", FORECASTPRICE_DENOMINATOR: "2" } },
    ],
  };

  book: MarketBook = {
    marketId: MARKET_ID,
    isMarketDataDelayed: false,
    status: "OPEN",
    inplay: false,
    betDelay: 0,
    numberOfWinners: 1,
    numberOfActiveRunners: 3,
    totalMatched: 5000,
    runners: [
      runner(101, 3.0, [3.0, 2.98, 2.96], [3.05, 3.1, 3.15], 3000),
      runner(102, 6.0, [5.9, 5.8], [6.2, 6.4], 800),
      runner(103, 4.5, [4.4, 4.3], [4.6, 4.7], 1200),
    ],
  };

  calls: Array<{ method: string; args: unknown }> = [];
  liveOrders: CurrentOrderSummary[] = [];

  setRunner(selectionId: number, patch: Partial<Runner>) {
    this.book.runners = this.book.runners.map((r) => (r.selectionId === selectionId ? { ...r, ...patch } : r));
  }

  async listEventTypes() {
    this.calls.push({ method: "listEventTypes", args: {} });
    return [
      { eventType: { id: "1", name: "Soccer" }, marketCount: 100 },
      { eventType: { id: "7", name: "Horse Racing" }, marketCount: 50 },
    ];
  }

  async listMarketCatalogue(args: Parameters<BetfairApi["listMarketCatalogue"]>[0]) {
    this.calls.push({ method: "listMarketCatalogue", args });
    const ids = args.filter.marketIds;
    if (ids && !ids.includes(MARKET_ID)) return [];
    if (this.book.status === "CLOSED") return [];
    return [structuredClone(this.catalogue)];
  }

  async listMarketBook(args: Parameters<BetfairApi["listMarketBook"]>[0]) {
    this.calls.push({ method: "listMarketBook", args });
    return args.marketIds.includes(MARKET_ID) ? [structuredClone(this.book)] : [];
  }

  async placeOrders(args: Parameters<BetfairApi["placeOrders"]>[0]): Promise<PlaceExecutionReport> {
    this.calls.push({ method: "placeOrders", args });
    return {
      status: "SUCCESS",
      marketId: args.marketId,
      instructionReports: args.instructions.map((instruction, i) => {
        const betId = `L${this.liveOrders.length + i + 1}`;
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
        });
        return {
          status: "SUCCESS" as const,
          instruction,
          betId,
          orderStatus: "EXECUTION_COMPLETE" as const,
          sizeMatched: instruction.limitOrder.size,
          averagePriceMatched: instruction.limitOrder.price,
        };
      }),
    };
  }

  async cancelOrders(args: Parameters<BetfairApi["cancelOrders"]>[0]) {
    this.calls.push({ method: "cancelOrders", args });
    return { status: "SUCCESS" as const, marketId: args.marketId ?? "", instructionReports: [] };
  }

  async listCurrentOrders(args: Parameters<BetfairApi["listCurrentOrders"]>[0]) {
    this.calls.push({ method: "listCurrentOrders", args });
    return { currentOrders: this.liveOrders.filter((o) => !args.marketIds || args.marketIds.includes(o.marketId)), moreAvailable: false };
  }

  async listClearedOrders(args: Parameters<BetfairApi["listClearedOrders"]>[0]) {
    this.calls.push({ method: "listClearedOrders", args });
    return { clearedOrders: [], moreAvailable: false };
  }

  async getAccountFunds() {
    this.calls.push({ method: "getAccountFunds", args: {} });
    return { availableToBetBalance: 500, exposure: -20, retainedCommission: 0, exposureLimit: -10000 };
  }
}
