import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BetfairApi } from "../src/betfair/client.js";
import { anchoredWindows } from "../src/contexts/candles.js";
import { raceDistanceYards, weightLbs } from "../src/contexts/racing.js";
import { DataContextService } from "../src/contexts/service.js";
import type { DataContextEnvelope } from "../src/contexts/types.js";
import { localTime } from "../src/format.js";
import { MarketService } from "../src/markets.js";
import { Recorder } from "../src/recorder.js";
import { State, type SettledMarket } from "../src/state.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

const TZ = "Europe/London";
/** Crafted trade history starts four hours ago, on a whole second. */
const T0 = Math.floor((Date.now() - 4 * 3600_000) / 1000) * 1000;
const at = (seconds: number) => T0 + seconds * 1000;
const local = (seconds: number) => localTime(at(seconds), TZ);

function setup(fake = new FakeBetfair(), timeZone = TZ) {
  const state = new State();
  const recorder = new Recorder();
  const markets = new MarketService(fake, state, recorder, 20);
  const contexts = new DataContextService(markets, state, { timeZone });
  /** Feed the recorder a snapshot of the fake book at an explicit time (seconds after T0). */
  const snap = (seconds: number, marketId = WIN_MARKET) => recorder.ingest(structuredClone(fake.book(marketId)), at(seconds));
  /** A trade observed by a poll at T0 + seconds. */
  const tradeAt = (seconds: number, price: number, size: number, selectionId = 101) => {
    fake.trade(selectionId, price, size);
    snap(seconds);
  };
  return { fake, state, recorder, markets, contexts, snap, tradeAt };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dataOf(env: DataContextEnvelope, selectionId: string): any {
  const selection = env.selectionsData.find((s) => s.selectionId === selectionId);
  assert.ok(selection, `selection ${selectionId} missing`);
  return selection.data;
}

/**
 * Runner 101 (best back 3.0, best lay 3.05). Trades: 3.0 (back), 3.05 (lay), 2.98 (back),
 * 3.1 (lay) exactly 300 s after the first trade, then 3.0 (back) after a 28-minute gap.
 */
function candleScenario(ctx: ReturnType<typeof setup>) {
  ctx.snap(0);
  ctx.tradeAt(10, 3.0, 10);
  ctx.tradeAt(100, 3.05, 5);
  ctx.tradeAt(309, 2.98, 2);
  ctx.tradeAt(310, 3.1, 7);
  ctx.tradeAt(2000, 3.0, 4);
}

function setStartTime(fake: FakeBetfair, iso: string) {
  for (const catalogue of fake.catalogues.values()) catalogue.marketStartTime = iso;
}

function settled(marketId: string, marketName: string, startTime: string, runners: SettledMarket["runners"], marketType = "WIN"): SettledMarket {
  // settledAt is recent so the 90-day archive retention keeps it; pastRaces use startTime.
  return { marketId, marketName, marketType, startTime, settledAt: new Date().toISOString(), eventType: "Horse Racing", venue: "Ffos Las", runners };
}

const runner = (selectionId: number, status: string, extra: Partial<SettledMarket["runners"][number]> = {}) => ({
  selectionId,
  handicap: 0,
  name: `Horse ${selectionId}`,
  status,
  ...extra,
});

describe("data-context envelope", () => {
  test("has BFExplorer's keys in order, the 6-key market header with venue and local offset time", async () => {
    const fake = new FakeBetfair();
    setStartTime(fake, "2026-10-06T18:00:00.000Z");
    const { contexts, state, markets } = setup(fake, "Europe/Bratislava");
    await markets.openMarket(WIN_MARKET);
    state.setDataContext(WIN_MARKET, "MyAnalysis", { pick: "101" });
    const env = await contexts.getForMarket(WIN_MARKET, ["MarketSelectionsCandleStickData", "MyAnalysis", "Nonsense"]);
    assert.deepEqual(Object.keys(env), ["market", "selectionsData", "data", "unavailableDataContexts", "recording"]);
    assert.deepEqual(Object.keys(env.market), ["marketId", "startTime", "eventType", "eventName", "marketName", "status"]);
    assert.deepEqual(env.market, {
      marketId: WIN_MARKET,
      startTime: "2026-10-06T20:00:00+02:00",
      eventType: "Horse Racing",
      eventName: "Ascot",
      marketName: "2m Hcap",
      status: "Open",
    });
    for (const selection of env.selectionsData) {
      assert.deepEqual(Object.keys(selection), ["selectionId", "name", "data"], "no price or status on selections");
    }
    assert.deepEqual(
      env.selectionsData.map((s) => [s.selectionId, s.name]),
      [["101", "Fast Horse"], ["102", "Slow Horse"], ["103", "Mid Horse"]],
    );
  });

  test("orders selections by sortPriority, not by book order or price", async () => {
    const fake = new FakeBetfair();
    const runners = fake.catalogues.get(WIN_MARKET)!.runners!;
    runners.find((r) => r.selectionId === 101)!.sortPriority = 3;
    runners.find((r) => r.selectionId === 103)!.sortPriority = 1;
    const { contexts } = setup(fake);
    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBaseBetfairFormData"]);
    assert.deepEqual(env.selectionsData.map((s) => s.selectionId), ["103", "102", "101"]);
  });

  test("merges several providers into one data object per selection, in request order", async () => {
    const { contexts, markets } = setup();
    await markets.openMarket(WIN_MARKET);
    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBaseBetfairFormData", "MarketSelectionsTradedPricesData", "BetfairSpData"]);
    assert.deepEqual(Object.keys(dataOf(env, "101")), [
      ...["forecastPrice", "form", "officialRating", "weight", "age", "sex", "jockey", "trainer", "stallDraw", "daysSinceLastRun"],
      "tradedPricesData",
      ...["price", "betfairSP", "industryStartingPrice", "eVforPriceOrBetfairSP", "nearPrice", "farPrice", "betfairSPIsProjected"],
      ...["backStakeTaken", "layLiabilityTaken"],
    ]);
    assert.equal(env.data, undefined, "no market-level data, so no top-level data key");
  });

  test("only returns exactly the requested selection and rejects selections not in the market", async () => {
    const { contexts } = setup();
    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBaseBetfairFormData"], { selectionId: 102, handicap: 0 });
    assert.equal(env.selectionsData.length, 1);
    assert.equal(env.selectionsData[0].selectionId, "102");
    assert.equal(env.selectionsData[0].name, "Slow Horse");
    await assert.rejects(contexts.getForMarket(WIN_MARKET, ["HorsesBaseBetfairFormData"], { selectionId: 999, handicap: 0 }), /999 is not in market/);
  });

  test("reports BFExplorer-only and unknown names (case-insensitively) without failing the call", async () => {
    const { contexts } = setup();
    const env = await contexts.getForMarket(WIN_MARKET, [
      "racingtvdataforhorses",
      "PlayingFootballMatchScoresData",
      "Bogus",
      "weightofmoneydata",
      "WeightOfMoneyData",
    ]);
    assert.deepEqual(env.unavailableDataContexts, {
      racingtvdataforhorses: "Not available in this connector: requires Racing TV form (BFExplorer only). Continue the analysis without it.",
      PlayingFootballMatchScoresData: "Not available in this connector: requires live football scores (BFExplorer only). Continue the analysis without it.",
      Bogus: 'Unknown data context "Bogus". Call get_available_data_context_providers for the list.',
    });
    assert.ok(dataOf(env, "101").offeredPrices, "provider names match case-insensitively (and duplicates are merged)");
  });

  test("passes stored AI-agent contexts through under top-level data, matched case-insensitively", async () => {
    const { contexts, state } = setup();
    state.setDataContext(WIN_MARKET, "HorseRacingR5_1_Trading_Analysis", { tradingDecision: { selectionId: "101" }, note: null });
    state.setDataContext(PLACE_MARKET, "OtherMarketOnly", { x: 1 });
    const env = await contexts.getForMarket(WIN_MARKET, ["horseracingr5_1_trading_analysis", "OtherMarketOnly"]);
    assert.deepEqual(env.data, { horseracingr5_1_trading_analysis: { tradingDecision: { selectionId: "101" }, note: null } });
    assert.match(env.unavailableDataContexts!.OtherMarketOnly, /Unknown data context/);
    assert.equal(env.recording, undefined, "recording only accompanies history-based providers");
    for (const selection of env.selectionsData) assert.equal(selection.data, undefined, "empty data objects are omitted");
  });

  test("accepts comma-separated names and rejects an empty request", async () => {
    const { contexts } = setup();
    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBaseBetfairFormData, BetfairSpData"]);
    assert.equal(dataOf(env, "101").weight, 140);
    assert.equal(dataOf(env, "101").price, 3);
    await assert.rejects(contexts.getForMarket(WIN_MARKET, [" ", ""]), /at least one data context name/);
    await assert.rejects(contexts.getForMarket("bad", ["BetfairSpData"]), /Invalid marketId/);
  });

  test("a provider that throws reports a reason and the other contexts are still returned", async () => {
    class SiblingLookupFails extends FakeBetfair {
      override async listMarketCatalogue(args: Parameters<BetfairApi["listMarketCatalogue"]>[0]) {
        if (args.filter.eventIds) throw new Error("ANGX-0003 sibling lookup failed");
        return super.listMarketCatalogue(args);
      }
    }
    const { contexts } = setup(new SiblingLookupFails());
    const env = await contexts.getForMarket(WIN_MARKET, ["HorseRacingWinToBePlacedData", "BetfairSpData"]);
    assert.match(env.unavailableDataContexts!.HorseRacingWinToBePlacedData, /HorseRacingWinToBePlacedData failed: ANGX-0003 sibling lookup failed/);
    assert.equal(dataOf(env, "101").winToBePlacedData, undefined, "no partial output from a failed provider");
    assert.equal(dataOf(env, "101").price, 3);
  });

  test("fetches the catalogue once and one book with the union of the options needed", async () => {
    const { contexts, fake } = setup();
    await contexts.getForMarket(WIN_MARKET, ["WeightOfMoneyData", "BetfairSpData", "MarketSelectionsCandleStickData"]);
    const books = fake.calls.filter((c) => c.method === "listMarketBook");
    assert.equal(books.length, 1);
    assert.deepEqual(books[0].args.priceProjection.priceData, ["EX_ALL_OFFERS", "EX_TRADED", "SP_AVAILABLE", "SP_TRADED"]);
    assert.equal(fake.calls.filter((c) => c.method === "listMarketCatalogue").length, 1);
    fake.calls = [];
    await contexts.getForMarket(WIN_MARKET, ["MarketSelectionsTradedPricesData"]);
    const [plain] = fake.calls.filter((c) => c.method === "listMarketBook");
    assert.deepEqual(plain.args.priceProjection.priceData, ["EX_BEST_OFFERS", "EX_TRADED"]);
    assert.equal(plain.args.priceProjection.exBestOffersOverrides.bestPricesDepth, 3);
  });

  test("serves closed markets from the catalogue snapshot", async () => {
    const { contexts, fake, markets } = setup();
    await markets.openMarket(WIN_MARKET);
    fake.settle([103]);
    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBaseBetfairFormData", "BetfairSpData"]);
    assert.equal(env.market.status, "Closed");
    assert.equal(env.market.eventName, "Ascot");
    assert.equal(dataOf(env, "103").price, 1.01);
  });
});

describe("candle algorithm", () => {
  test("anchors at the first trade, spaces windows by at least 300 s, skips empty stretches, open = previous close", () => {
    const windows = anchoredWindows(
      [
        { t: 10_000, price: 3.0, size: 10 },
        { t: 100_000, price: 3.05, size: 5 },
        { t: 309_000, price: 2.98, size: 2 },
        { t: 310_000, price: 3.1, size: 7 },
        { t: 2_000_000, price: 3.0, size: 4 },
      ],
      300_000,
    );
    assert.deepEqual(
      windows.map((w) => [w.time, w.open, w.high, w.low, w.close, w.volume]),
      [
        [10_000, 3.0, 3.05, 2.98, 2.98, 17],
        [310_000, 2.98, 3.1, 2.98, 3.1, 7],
        [2_000_000, 3.1, 3.1, 3.0, 3.0, 4],
      ],
    );
  });

  test("builds candleStickData from recorded trades with BFExplorer's keys and local times", async () => {
    const ctx = setup();
    candleScenario(ctx);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsCandleStickData"]);
    const data = dataOf(env, "101");
    assert.deepEqual(Object.keys(data), ["candleStickData", "vwaPrice", "backLayRatio"]);
    for (const candle of data.candleStickData) assert.deepEqual(Object.keys(candle), ["time", "high", "open", "close", "low", "volume"]);
    assert.deepEqual(data.candleStickData, [
      { time: local(10), high: 3.05, open: 3, close: 2.98, low: 2.98, volume: 17 },
      // high/low include the open (previous close)
      { time: local(310), high: 3.1, open: 2.98, close: 3.1, low: 2.98, volume: 7 },
      // a 28-minute gap produces no empty candles
      { time: local(2000), high: 3.1, open: 3.1, close: 3, low: 3, volume: 4 },
    ]);
    assert.match(data.candleStickData[0].time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    // back-initiated 10 + 2 + 4, lay-initiated 5 + 7 (a print at the lay price counts as laid)
    assert.equal(data.backLayRatio, 0.57);
    // vwaPrice covers the whole traded ladder, not just the recorded trades
    const ladder = ctx.fake.runner(101).ex!.tradedVolume!;
    const vwap = ladder.reduce((s, l) => s + l.price * l.size, 0) / ladder.reduce((s, l) => s + l.size, 0);
    assert.equal(data.vwaPrice, Math.round(vwap * 100) / 100);
    assert.notEqual(data.vwaPrice, 3, "not the VWAP of the recorded trades alone");
    assert.equal(dataOf(env, "102").candleStickData, undefined, "selections without trades get no candles");
  });

  test("returns only the last 12 candles; the first returned keeps the previous (dropped) close as open", async () => {
    const ctx = setup();
    const prices = [6.0, 6.2, 6.4, 6.6, 6.8, 7.0, 6.8, 6.6, 6.4, 6.2, 6.0, 5.9, 5.8, 5.7, 5.6];
    ctx.snap(0);
    prices.forEach((price, i) => {
      ctx.fake.trade(102, price, 1 + i);
      ctx.snap(10 + 300 * i);
    });
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsCandleStickData"]);
    const candles = dataOf(env, "102").candleStickData;
    assert.equal(candles.length, 12);
    assert.equal(candles[0].time, local(10 + 300 * 3));
    assert.equal(candles[0].open, 6.4);
    assert.equal(candles[0].close, 6.6);
    assert.equal(candles[11].close, 5.6);
    assert.equal(candles[11].volume, 15);
  });

  test("a 10-minute recording with a trade every minute gives 2 five-minute candles, not 10", async () => {
    const ctx = setup();
    ctx.snap(0);
    for (let minute = 1; minute <= 10; minute++) ctx.tradeAt(minute * 60, minute % 2 ? 3.0 : 3.05, 1);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsCandleStickData"]);
    const candles = dataOf(env, "101").candleStickData;
    assert.deepEqual(candles.map((c: { time: string }) => c.time), [local(60), local(360)]);
    assert.deepEqual(candles.map((c: { volume: number }) => c.volume), [5, 5]);
  });

  test("includes in-play trades (the bucket with the off reaches 1000)", async () => {
    const ctx = setup();
    ctx.snap(0);
    ctx.tradeAt(10, 3.0, 10);
    ctx.fake.book().inplay = true;
    ctx.tradeAt(400, 1000, 3);
    ctx.tradeAt(450, 500, 2);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsCandleStickData"]);
    const candles = dataOf(env, "101").candleStickData;
    assert.equal(candles.length, 2);
    assert.deepEqual(candles[1], { time: local(400), high: 1000, open: 3, close: 500, low: 3, volume: 5 });
  });

  test("vwaPrice is available straight after open_market, before any candle exists", async () => {
    const { contexts, markets } = setup();
    await markets.openMarket(WIN_MARKET);
    const env = await contexts.getForMarket(WIN_MARKET, ["MarketSelectionsCandleStickData"]);
    // Fake ladders: 40% at LTP - 0.1, 60% at LTP.
    assert.deepEqual(dataOf(env, "101"), { vwaPrice: 2.96 });
    assert.deepEqual(dataOf(env, "102"), { vwaPrice: 5.96 });
    assert.deepEqual(dataOf(env, "103"), { vwaPrice: 4.46 });
    assert.equal(env.recording!.volumeDataAvailable, true);
    assert.match(env.recording!.note!, /History starts when the market was opened with open_market; only 0 minutes recorded so far\./);
  });
});

describe("recorded-history providers", () => {
  test("recording reports since, minutes and that a market read without open_market is not monitored", async () => {
    const ctx = setup();
    candleScenario(ctx);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsTradedPricesData"]);
    assert.deepEqual(Object.keys(env.recording!), ["since", "minutes", "volumeDataAvailable", "note"]);
    assert.equal(env.recording!.since, local(0));
    assert.ok(env.recording!.minutes >= 239 && env.recording!.minutes <= 241, String(env.recording!.minutes));
    assert.equal(env.recording!.volumeDataAvailable, true);
    assert.match(env.recording!.note!, /not monitored.*open_market/);
  });

  test("a monitored market with enough history has no note", async () => {
    const ctx = setup();
    candleScenario(ctx);
    await ctx.markets.openMarket(WIN_MARKET);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsTradedPricesData"]);
    assert.equal(env.recording!.note, undefined);
  });

  test("tradedPricesData covers the observed window with unrounded aggressor ratios", async () => {
    const ctx = setup();
    candleScenario(ctx);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsTradedPricesData"]);
    const data = dataOf(env, "101").tradedPricesData;
    assert.deepEqual(Object.keys(data), ["startPrice", "endPrice", "minPrice", "maxPrice", "tradedVolume", "backRatio", "layRatio"]);
    assert.equal(data.startPrice, 3);
    assert.equal(data.endPrice, 3);
    assert.equal(data.minPrice, 2.98);
    assert.equal(data.maxPrice, 3.1, "the observed window, not the whole traded ladder (which starts at 2.9)");
    assert.equal(data.tradedVolume, 28, "volume since monitoring began, not the runner's totalMatched");
    assert.equal(data.backRatio, 16 / 28);
    assert.equal(data.layRatio, 12 / 28);
    assert.ok(Math.abs(data.backRatio + data.layRatio - 1) < 1e-12);
    const quiet = dataOf(env, "102").tradedPricesData;
    assert.deepEqual(quiet, { startPrice: 6, endPrice: 6, minPrice: 6, maxPrice: 6, tradedVolume: 0 }, "no ratios without classified volume");
  });

  test("tradedPricesData min/max include start and end prices outside the recorded trades", async () => {
    const ctx = setup();
    ctx.snap(0);
    ctx.tradeAt(60, 3.05, 5);
    ctx.fake.setRunner(101, { lastPriceTraded: 3.4 }); // e.g. a cross-matched LTP without a ladder change
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsTradedPricesData"]);
    const data = dataOf(env, "101").tradedPricesData;
    assert.equal(data.startPrice, 3);
    assert.equal(data.endPrice, 3.4);
    assert.equal(data.minPrice, 3);
    assert.equal(data.maxPrice, 3.4);
    assert.equal(data.backRatio, 0, "only lay-initiated volume was classified");
    assert.equal(data.layRatio, 1);
  });

  test("timePriceVolumes has one row per recorded trade with its own volume, oldest first", async () => {
    const ctx = setup();
    candleScenario(ctx);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsPriceHistoryData"]);
    assert.deepEqual(dataOf(env, "101").timePriceVolumes, [
      { time: local(10), price: 3, volume: 10 },
      { time: local(100), price: 3.05, volume: 5 },
      { time: local(309), price: 2.98, volume: 2 },
      { time: local(310), price: 3.1, volume: 7 },
      { time: local(2000), price: 3, volume: 4 },
    ]);
    assert.equal(dataOf(env, "102"), undefined);
    assert.equal(env.unavailableDataContexts, undefined);
  });

  test("timePriceVolumes keeps only the last 300 trades per selection and says so", async () => {
    const ctx = setup();
    ctx.snap(0);
    for (let i = 1; i <= 305; i++) ctx.tradeAt(i, i % 2 ? 3.0 : 3.05, i);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsPriceHistoryData"]);
    const rows = dataOf(env, "101").timePriceVolumes;
    assert.equal(rows.length, 300);
    assert.deepEqual(rows[0], { time: local(6), price: 3.05, volume: 6 });
    assert.deepEqual(rows[299], { time: local(305), price: 3, volume: 305 });
    assert.match(env.recording!.note!, /last 300 recorded trades/);
  });

  test("priceMetricsData uses 3600 s anchored windows, keeps the last 2 oldest first, with a 4-dp VWAP", async () => {
    const ctx = setup();
    ctx.snap(0);
    ctx.fake.setOffers(103, [[4.4, 100]], [[4.6, 100]]);
    ctx.snap(1);
    ctx.tradeAt(5, 4.5, 10, 103);
    ctx.tradeAt(1000, 4.6, 10, 103);
    ctx.tradeAt(3605, 4.4, 20, 103); // >= 5 + 3600: second window
    ctx.tradeAt(5000, 4.5, 10, 103);
    ctx.tradeAt(7300, 4.3, 5, 103); // >= 3605 + 3600: third window
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["MarketSelectionsPriceMetricData"]);
    const metrics = dataOf(env, "103").priceMetricsData;
    assert.deepEqual(metrics, [
      { time: local(3605), ohlc: { open: 4.6, high: 4.6, low: 4.4, close: 4.5 }, vwap: { price: 4.4333, volume: 30 } },
      { time: local(7300), ohlc: { open: 4.5, high: 4.5, low: 4.3, close: 4.3 }, vwap: { price: 4.3, volume: 5 } },
    ]);
    assert.deepEqual(Object.keys(metrics[0]), ["time", "ohlc", "vwap"]);
  });

  test("a market with no recorded trades reports why instead of empty arrays", async () => {
    const { contexts } = setup();
    const env = await contexts.getForMarket(WIN_MARKET, ["MarketSelectionsPriceHistoryData", "MarketSelectionsPriceMetricData"]);
    assert.match(env.unavailableDataContexts!.MarketSelectionsPriceHistoryData, /No trades recorded.*open_market/);
    assert.match(env.unavailableDataContexts!.MarketSelectionsPriceMetricData, /No trades recorded/);
    for (const selection of env.selectionsData) assert.equal(selection.data, undefined);
  });

  test("delayed application keys: candles and history from last-traded-price changes with zero volume", async () => {
    const ctx = setup();
    const book = ctx.fake.book();
    book.isMarketDataDelayed = true;
    delete book.totalMatched;
    for (const r of book.runners) {
      delete r.totalMatched;
      r.ex = { ...r.ex, tradedVolume: [] };
    }
    ctx.snap(0);
    ctx.fake.setRunner(101, { lastPriceTraded: 3.1 });
    ctx.snap(60);
    ctx.fake.setRunner(101, { lastPriceTraded: 3.2 });
    ctx.snap(400);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, [
      "MarketSelectionsCandleStickData",
      "MarketSelectionsPriceHistoryData",
      "MarketSelectionsTradedPricesData",
      "MarketSelectionsPriceMetricData",
      "WeightOfMoneyData",
    ]);
    const data = dataOf(env, "101");
    assert.deepEqual(data.candleStickData, [
      { time: local(0), high: 3.1, open: 3, close: 3.1, low: 3, volume: 0 },
      { time: local(400), high: 3.2, open: 3.1, close: 3.2, low: 3.1, volume: 0 },
    ]);
    assert.equal(data.vwaPrice, undefined);
    assert.equal(data.backLayRatio, undefined);
    assert.deepEqual(data.timePriceVolumes.map((r: { volume: number }) => r.volume), [0, 0, 0]);
    assert.deepEqual(data.tradedPricesData, { startPrice: 3, endPrice: 3.2, minPrice: 3, maxPrice: 3.2 });
    assert.equal(data.priceMetricsData[0].vwap, undefined);
    assert.equal(data.averageBackTraded, undefined);
    assert.equal(data.tradedPrices, undefined);
    assert.ok(data.offeredPrices.length > 0);
    assert.equal(env.recording!.volumeDataAvailable, false);
    assert.match(env.recording!.note!, /Delayed application key: no traded volume, so volumes\/VWAP\/ratios are unavailable\./);
  });
});

describe("book providers", () => {
  test("WeightOfMoneyData: full-depth offeredPrices with BFExplorer's betType mapping, averages and the full ladder", async () => {
    const ctx = setup();
    const back: Array<[number, number]> = [[3.0, 100], [2.98, 80], [2.96, 60], [2.94, 40], [2.92, 20], [2.9, 10]];
    const lay: Array<[number, number]> = [[3.05, 80], [3.1, 60], [3.15, 40], [3.2, 30], [3.25, 20], [3.3, 10]];
    ctx.fake.setOffers(101, back, lay);
    candleScenario(ctx);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["WeightOfMoneyData"]);
    const data = dataOf(env, "101");
    assert.deepEqual(Object.keys(data), ["averageBackTraded", "averageLayTraded", "offeredPrices", "tradedPrices", "weightOfMoneySummary"]);
    // Back rows = Betfair availableToBack (layers' money), Lay rows = availableToLay (backers' money).
    assert.deepEqual(data.offeredPrices, [
      ...back.map(([price, volume]) => ({ betType: "Back", price, volume })),
      ...lay.map(([price, volume]) => ({ betType: "Lay", price, volume })),
    ]);
    assert.deepEqual(data.averageBackTraded, { price: Math.round(((3.0 * 10 + 2.98 * 2 + 3.0 * 4) / 16) * 10000) / 10000, volume: 16 });
    assert.deepEqual(data.averageLayTraded, { price: Math.round(((3.05 * 5 + 3.1 * 7) / 12) * 10000) / 10000, volume: 12 });
    const ladder = [...ctx.fake.runner(101).ex!.tradedVolume!].sort((a, b) => a.price - b.price);
    assert.deepEqual(data.tradedPrices, ladder.map((l) => ({ price: l.price, volume: l.size })));
    assert.equal(
      data.tradedPrices.reduce((s: number, l: { volume: number }) => s + l.volume, 0),
      ladder.reduce((s, l) => s + l.size, 0),
    );
    assert.deepEqual(data.weightOfMoneySummary, {
      backersWaiting: 240,
      layersWaiting: 310,
      backingPressure: Math.round((240 / 550) * 1000) / 1000,
      nearBookBackingPressure: Math.round((230 / 530) * 1000) / 1000,
    });
    assert.ok(env.recording, "WoM averages are history-based");
  });

  test("WeightOfMoneyData falls back to best offers when EX_ALL_OFFERS comes back empty", async () => {
    class NoAllOffers extends FakeBetfair {
      override async listMarketBook(args: Parameters<BetfairApi["listMarketBook"]>[0]) {
        const books = await super.listMarketBook(args);
        if (args.priceProjection?.priceData?.includes("EX_ALL_OFFERS")) {
          for (const book of books) for (const r of book.runners) r.ex = { ...r.ex, availableToBack: [], availableToLay: [] };
        }
        return books;
      }
    }
    const ctx = setup(new NoAllOffers());
    ctx.fake.setOffers(101, [[3.0, 100], [2.98, 80], [2.96, 60], [2.94, 40]], [[3.05, 80], [3.1, 60], [3.15, 40], [3.2, 30]]);
    const env = await ctx.contexts.getForMarket(WIN_MARKET, ["WeightOfMoneyData"]);
    const offered = dataOf(env, "101").offeredPrices;
    assert.deepEqual(offered.map((o: { betType: string; price: number }) => [o.betType, o.price]), [
      ["Back", 3.0],
      ["Back", 2.98],
      ["Back", 2.96],
      ["Lay", 3.05],
      ["Lay", 3.1],
      ["Lay", 3.15],
    ]);
    assert.match(env.recording!.note!, /EX_ALL_OFFERS.*best 3 levels/);
    assert.equal(ctx.fake.calls.filter((c) => c.method === "listMarketBook").length, 2);
  });

  test("BetfairSpData: price (as the market tool), projected/actual SP, forecast and EV", async () => {
    const { contexts, fake, markets } = setup();
    fake.setRunner(102, { sp: { nearPrice: "NaN" as unknown as number, farPrice: "Infinity" as unknown as number, backStakeTaken: [], layLiabilityTaken: [{ price: 6, size: 12.5 }] } });
    fake.setRunner(103, { lastPriceTraded: undefined, ex: { availableToBack: [], availableToLay: [], tradedVolume: [] }, sp: { nearPrice: 5 } });
    let env = await contexts.getForMarket(WIN_MARKET, ["BetfairSpData"]);
    const fast = dataOf(env, "101");
    assert.deepEqual(fast, {
      price: 3,
      betfairSP: 3.1,
      industryStartingPrice: 3,
      eVforPriceOrBetfairSP: 0.0333,
      nearPrice: 3.1,
      farPrice: 2.8,
      betfairSPIsProjected: true,
      backStakeTaken: 50,
      layLiabilityTaken: 0,
    });
    assert.deepEqual(Object.keys(fast).slice(0, 4), ["price", "betfairSP", "industryStartingPrice", "eVforPriceOrBetfairSP"]);
    const slow = dataOf(env, "102");
    assert.equal(slow.betfairSP, undefined, "Betfair's NaN projections are dropped");
    assert.equal(slow.nearPrice, undefined);
    assert.equal(slow.farPrice, undefined);
    assert.equal(slow.layLiabilityTaken, 12.5);
    assert.equal(slow.eVforPriceOrBetfairSP, Math.round((6 / 6 - 1) * 10000) / 10000);
    const unpriced = dataOf(env, "103");
    assert.equal(unpriced.price, 1000, "same placeholder as get_active_market");
    assert.equal(unpriced.eVforPriceOrBetfairSP, Math.round((5 / 4.5 - 1) * 10000) / 10000, "EV never uses the 1000 placeholder");
    await markets.openMarket(WIN_MARKET);
    fake.settle([101], WIN_MARKET, { bsp: { 101: 3.4 } });
    env = await contexts.getForMarket(WIN_MARKET, ["BetfairSpData"]);
    assert.equal(dataOf(env, "101").betfairSP, 3.4);
    assert.equal(dataOf(env, "101").actualSP, 3.4);
    assert.equal(dataOf(env, "101").betfairSPIsProjected, false);
  });
});

describe("racing providers", () => {
  test("HorsesBaseBetfairFormData: prompt-read fields first, weight as a number of lbs, numbers where numeric", async () => {
    const fake = new FakeBetfair();
    const meta = fake.catalogues.get(WIN_MARKET)!.runners!.find((r) => r.selectionId === 102)!.metadata!;
    meta.WEIGHT_VALUE = "61.22";
    meta.WEIGHT_UNITS = "kilograms";
    meta.CLOTH_NUMBER_ALPHA = "1A";
    meta.FORM = "604441";
    const { contexts } = setup(fake);
    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBaseBetfairFormData"]);
    const fast = dataOf(env, "101");
    assert.deepEqual(fast, {
      forecastPrice: 3,
      form: "1-21",
      officialRating: 85,
      weight: 140,
      age: 5,
      sex: "Gelding",
      jockey: "J Smith",
      trainer: "T Jones",
      stallDraw: 3,
      daysSinceLastRun: 21,
    });
    assert.deepEqual(Object.keys(fast).slice(0, 4), ["forecastPrice", "form", "officialRating", "weight"]);
    const slow = dataOf(env, "102");
    assert.equal(slow.weight, 135, "61.22 kg in lbs");
    assert.equal(slow.form, "604441", "form stays text");
    assert.equal(slow.clothNumber, "1A");
    assert.equal(slow.forecastPrice, 6);
  });

  test("markets without runner metadata report why", async () => {
    const fake = new FakeBetfair();
    for (const r of fake.catalogues.get(PLACE_MARKET)!.runners!) delete r.metadata;
    const { contexts } = setup(fake);
    const env = await contexts.getForMarket(PLACE_MARKET, ["HorsesBaseBetfairFormData", "HorsesBetfairRaceInfoData"]);
    assert.match(env.unavailableDataContexts!.HorsesBaseBetfairFormData, /no runner metadata/);
    assert.match(env.unavailableDataContexts!.HorsesBetfairRaceInfoData, /no runner metadata/);
    assert.equal(env.partialDataContexts, undefined);
  });

  test("HorseRacingWinToBePlacedData monitors the PLACE market as a companion and compares initial vs current prices", async () => {
    const { contexts, markets, fake, state } = setup();
    await markets.openMarket(WIN_MARKET);
    let env = await contexts.getForMarket(WIN_MARKET, ["HorseRacingWinToBePlacedData"]);
    assert.equal(state.monitored.get(PLACE_MARKET)?.companionOf, WIN_MARKET);
    const place = (env.data as { placeMarket: { marketId: string; numberOfWinners: number; timeToRaceMinutes: number } }).placeMarket;
    assert.deepEqual(Object.keys(place), ["marketId", "numberOfWinners", "timeToRaceMinutes"]);
    assert.equal(place.marketId, PLACE_MARKET);
    assert.equal(place.numberOfWinners, 2);
    const expectedMinutes = (Date.parse(fake.startTime) - Date.now()) / 60_000;
    assert.ok(Math.abs(place.timeToRaceMinutes - expectedMinutes) < 0.2, `${place.timeToRaceMinutes} vs ${expectedMinutes}`);
    assert.deepEqual(dataOf(env, "101").winToBePlacedData, {
      initialWinPrice: 3,
      currentWinPrice: 3,
      initialPlacePrice: 1.5,
      currentPlacePrice: 1.5,
      winTradedVolume: 3000,
      placeTradedVolume: 900,
    });
    assert.match(env.recording!.note!, /PLACE market 1\.200000002 was not monitored/);

    fake.trade(101, 2.8, 50);
    fake.trade(101, 1.4, 30, PLACE_MARKET);
    await markets.getBooks(markets.monitoredMarketIds()); // the recorder's poll
    env = await contexts.getForMarket(WIN_MARKET, ["HorseRacingWinToBePlacedData"]);
    assert.deepEqual(dataOf(env, "101").winToBePlacedData, {
      initialWinPrice: 3,
      currentWinPrice: 2.8,
      initialPlacePrice: 1.5,
      currentPlacePrice: 1.4,
      winTradedVolume: 3050,
      placeTradedVolume: 930,
    });
    assert.doesNotMatch(env.recording!.note ?? "", /was not monitored/);
    const siblingLookups = fake.calls.filter((c) => c.method === "listMarketCatalogue" && c.args.filter.eventIds);
    assert.equal(siblingLookups.length, 1, "the PLACE market id is cached per WIN market");
    const placeOpens = fake.calls.filter((c) => c.method === "listMarketCatalogue" && c.args.filter.marketIds?.includes(PLACE_MARKET));
    assert.equal(placeOpens.length, 1, "open_market is called once for the PLACE market");
  });

  test("HorseRacingWinToBePlacedData on a settled race reads the PLACE book without monitoring it again", async () => {
    const { contexts, markets, fake, state } = setup();
    await markets.openMarket(WIN_MARKET);
    await contexts.getForMarket(WIN_MARKET, ["HorseRacingWinToBePlacedData"]);
    state.monitored.delete(PLACE_MARKET); // e.g. evicted by later open_market calls
    fake.settle([101], WIN_MARKET);
    fake.settle([101, 103], PLACE_MARKET);
    const env = await contexts.getForMarket(WIN_MARKET, ["HorseRacingWinToBePlacedData"]);
    assert.equal(state.monitored.has(PLACE_MARKET), false, "a closed market is not added back to the monitored list");
    assert.equal(dataOf(env, "101").winToBePlacedData.currentPlacePrice, 1.01);
    assert.equal((env.data as { placeMarket: { numberOfWinners: number } }).placeMarket.numberOfWinners, 2);
  });

  test("HorseRacingWinToBePlacedData without a PLACE market, or on a non-WIN market, is unavailable", async () => {
    const fake = new FakeBetfair();
    fake.catalogues.delete(PLACE_MARKET);
    const { contexts } = setup(fake);
    const env = await contexts.getForMarket(WIN_MARKET, ["HorseRacingWinToBePlacedData"]);
    assert.match(env.unavailableDataContexts!.HorseRacingWinToBePlacedData, /No PLACE \(To Be Placed\) market/);
    const other = setup();
    const placeEnv = await other.contexts.getForMarket(PLACE_MARKET, ["HorseRacingWinToBePlacedData"]);
    assert.match(placeEnv.unavailableDataContexts!.HorseRacingWinToBePlacedData, /is a PLACE market/);
  });

  test("HorsesBetfairRaceInfoData builds horseDetail with pastRaces from settled WIN markets this connector archived", async () => {
    const { contexts, state } = setup();
    state.archiveMarket(
      settled("1.9001", "2m4f Hcap Chs", "2026-09-19T13:00:00.000Z", [
        runner(101, "Winner", { bsp: 6.53, inPlayMin: 1.01, inPlayMax: 5.9 }),
        runner(102, "Loser", { bsp: 9.78, inPlayMin: 4, inPlayMax: 1000 }),
        runner(103, "Removed"),
      ]),
    );
    state.archiveMarket(
      settled("1.9002", "1m2f110y Mdn Stks", "2026-09-07T15:57:00.000Z", [
        runner(101, "Loser", { inPlayMin: 4.9, inPlayMax: 960 }),
        runner(102, "Winner", { bsp: 4.9 }),
        runner(201, "Loser"),
        runner(202, "RemovedVacant"),
      ]),
    );
    state.archiveMarket(settled("1.9003", "To Be Placed", "2026-09-25T12:00:00.000Z", [runner(101, "Winner", { bsp: 1.5 })], "PLACE"));
    state.archiveMarket(settled("1.9004", "5f Nursery", "2026-08-27T13:37:00.000Z", [runner(101, "Loser", { bsp: 5.5 })]));
    state.archiveMarket(settled("1.9005", "Novice Stakes", "2026-08-01T13:37:00.000Z", [runner(101, "Winner", { bsp: 2 }), runner(102, "Loser")]));
    state.archiveMarket(settled(WIN_MARKET, "2m Hcap", "2026-10-01T13:00:00.000Z", [runner(101, "Winner", { bsp: 9 })]));
    state.archiveMarket(settled("1.9006", "1m Hcap", "2026-09-20T13:00:00.000Z", [runner(103, "Removed")]));

    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBetfairRaceInfoData"]);
    const fast = dataOf(env, "101").horseDetail;
    assert.deepEqual(Object.keys(fast), ["age", "gender", "pastRaces", "weight"]);
    assert.deepEqual(fast, {
      age: 5,
      gender: "Gelding",
      pastRaces: [
        { date: "2026-09-19T13:00:00Z", distance: 4400, inPlayMaxPrice: 5.9, inPlayMinPrice: 1.01, position: "1/2", price: 6.53 },
        { date: "2026-09-07T15:57:00Z", distance: 2310, inPlayMaxPrice: 960, inPlayMinPrice: 4.9 },
        { date: "2026-08-27T13:37:00Z", distance: 1100, price: 5.5 },
        { date: "2026-08-01T13:37:00Z", position: "1/2", price: 2 },
      ],
      weight: 140,
    });
    assert.deepEqual(Object.keys(fast.pastRaces[0]), ["date", "distance", "inPlayMaxPrice", "inPlayMinPrice", "position", "price"]);
    const slow = dataOf(env, "102").horseDetail;
    assert.equal(slow.gender, "Filly");
    assert.deepEqual(slow.pastRaces.map((r: { position?: string }) => r.position), [undefined, "1/3", undefined], "1/N for winners only, N = runners not removed");
    const mid = dataOf(env, "103").horseDetail;
    assert.equal(mid.pastRaces, undefined, "removed runners did not run");
    assert.equal(mid.gender, "Mare");
    assert.equal(env.partialDataContexts!.HorsesBetfairRaceInfoData, "pastRaces only cover races this connector saw settle; no Racing Post/Timeform data");
    assert.equal(JSON.stringify(env).includes("nigelRace"), false);
  });

  test("pastRaces are capped at 6, newest first, and come from markets the connector saw settle", async () => {
    const fake = new FakeBetfair();
    const PAST = "1.200000009";
    fake.catalogues.set(PAST, { ...structuredClone(fake.catalogues.get(WIN_MARKET)!), marketId: PAST, marketName: "1m Hcap", marketStartTime: "2026-09-01T12:00:00.000Z" });
    fake.books.set(PAST, { ...structuredClone(fake.book(WIN_MARKET)), marketId: PAST });
    const { contexts, markets, state } = setup(fake);
    await markets.openMarket(PAST);
    fake.book(PAST).inplay = true;
    fake.trade(102, 1.5, 20, PAST);
    await markets.getBook(PAST);
    fake.trade(102, 8, 5, PAST);
    await markets.getBook(PAST);
    fake.settle([102], PAST, { bsp: { 102: 6.2 } });
    await markets.getBook(PAST, { sp: true }); // archives the settled market with its BSP
    for (let i = 1; i <= 7; i++) {
      state.archiveMarket(settled(`1.80${i}`, "6f Hcap", `2026-07-0${i}T12:00:00.000Z`, [runner(102, "Loser", { bsp: 10 + i })]));
    }
    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBetfairRaceInfoData"]);
    const races = dataOf(env, "102").horseDetail.pastRaces;
    assert.equal(races.length, 6);
    assert.deepEqual(races[0], { date: "2026-09-01T12:00:00Z", distance: 1760, inPlayMaxPrice: 8, inPlayMinPrice: 1.01, position: "1/3", price: 6.2 });
    assert.deepEqual(races.slice(1).map((r: { date: string }) => r.date), [7, 6, 5, 4, 3].map((d) => `2026-07-0${d}T12:00:00Z`));
  });

  test("race distances parse to yards and weights to lbs", () => {
    assert.equal(raceDistanceYards("2m4f Hcap Chs"), 4400);
    assert.equal(raceDistanceYards("1m2f110y Mdn"), 2310);
    assert.equal(raceDistanceYards("5f Nursery"), 1100);
    assert.equal(raceDistanceYards("1m Hcap"), 1760);
    assert.equal(raceDistanceYards("2m½f Nov Hrd"), 3630);
    assert.equal(raceDistanceYards("6f17y Hcap"), 1337);
    assert.equal(raceDistanceYards("Novice Stakes"), undefined);
    assert.equal(raceDistanceYards("A4 480m"), undefined, "greyhound metres are not miles");
    assert.equal(raceDistanceYards("To Be Placed"), undefined);
    assert.equal(weightLbs({ WEIGHT_VALUE: "137", WEIGHT_UNITS: "pounds" }), 137);
    assert.equal(weightLbs({ WEIGHT_VALUE: "61.22", WEIGHT_UNITS: "kg" }), 135);
    assert.equal(weightLbs({ WEIGHT_VALUE: "9-7" }), 133);
    assert.equal(weightLbs({ WEIGHT_VALUE: null }), undefined);
  });
});

describe("providers and feedback", () => {
  test("providers lists implemented, partial, BFExplorer-only and stored AI contexts", async () => {
    const { contexts, state } = setup();
    state.setDataContext(WIN_MARKET, "HorseRacingR5_1_Trading_Analysis", { a: 1 });
    const list = contexts.providers(WIN_MARKET);
    const byName = new Map(list.map((p) => [p.name, p]));
    for (const name of [
      "MarketSelectionsCandleStickData",
      "MarketSelectionsPriceHistoryData",
      "MarketSelectionsTradedPricesData",
      "MarketSelectionsPriceMetricData",
      "WeightOfMoneyData",
      "BetfairSpData",
      "HorsesBaseBetfairFormData",
      "HorseRacingWinToBePlacedData",
    ]) {
      assert.equal(byName.get(name)?.status, "available", name);
      assert.ok(byName.get(name)!.description.length > 20);
    }
    assert.deepEqual(byName.get("MarketSelectionsCandleStickData")!.dataKeys, ["candleStickData", "vwaPrice", "backLayRatio"]);
    assert.deepEqual(byName.get("MarketSelectionsPriceMetricData")!.dataKeys, ["priceMetricsData"]);
    assert.deepEqual(byName.get("HorseRacingWinToBePlacedData")!.marketDataKeys, ["placeMarket"]);
    const raceInfo = byName.get("HorsesBetfairRaceInfoData")!;
    assert.equal(raceInfo.status, "partial");
    assert.equal(raceInfo.reason, "pastRaces only cover races this connector saw settle; no Racing Post/Timeform data");
    assert.deepEqual(raceInfo.dataKeys, ["horseDetail"]);
    const racingTv = byName.get("RacingTvDataForHorses")!;
    assert.equal(racingTv.status, "unavailable");
    assert.deepEqual(racingTv.dataKeys, ["racingTvHorseData"]);
    assert.deepEqual(racingTv.marketDataKeys, ["racingTvRaceData"]);
    assert.match(racingTv.reason!, /Racing TV form/);
    assert.equal(byName.get("PlayingFootballMatchScoresData")?.status, "unavailable");
    const stored = byName.get("HorseRacingR5_1_Trading_Analysis")!;
    assert.deepEqual(stored, {
      name: "HorseRacingR5_1_Trading_Analysis",
      status: "available",
      description: "AI-agent data stored with set_ai_agent_data_context_for_market",
      dataKeys: [],
      marketDataKeys: ["HorseRacingR5_1_Trading_Analysis"],
    });
    assert.equal(new Set(list.map((p) => p.name)).size, list.length, "no duplicates");
    assert.equal(contexts.providers().some((p) => p.name === "HorseRacingR5_1_Trading_Analysis"), false);
    list[0].dataKeys.push("mutated");
    assert.deepEqual(contexts.providers()[0].dataKeys, ["candleStickData", "vwaPrice", "backLayRatio"]);
  });

  test("feedback returns stored contexts newest first with settled results joined", async () => {
    const { contexts, state, markets, fake } = setup();
    await markets.openMarket(WIN_MARKET);
    await markets.getCatalogue(PLACE_MARKET);
    state.setDataContext(WIN_MARKET, "EVAnalysis", { pick: "101" });
    state.setDataContext(PLACE_MARKET, "EVAnalysis", { pick: "102" });
    state.setDataContext("1.300000001", "evanalysis", { pick: "x" });
    state.setDataContext(WIN_MARKET, "Other", { ignored: true });
    state.dataContexts.get(WIN_MARKET)!.get("EVAnalysis")!.updatedAt = "2026-10-01T10:00:00.000Z";
    state.dataContexts.get(PLACE_MARKET)!.get("EVAnalysis")!.updatedAt = "2026-10-02T10:00:00.000Z";
    state.dataContexts.get("1.300000001")!.get("evanalysis")!.updatedAt = "2026-09-01T10:00:00.000Z";
    fake.settle([101], WIN_MARKET, { bsp: { 101: 3.4, 102: 7.2, 103: 5 } });
    await markets.getBook(WIN_MARKET, { sp: true });

    const entries = await contexts.feedback("EVAnalysis", 100);
    assert.deepEqual(entries.map((e) => e.market.marketId), [PLACE_MARKET, WIN_MARKET, "1.300000001"]);
    const [place, win, unknown] = entries;
    assert.deepEqual(Object.keys(win), ["market", "data", "storedAt", "result"]);
    assert.deepEqual(Object.keys(win.market), ["marketId", "startTime", "eventType", "eventName", "marketName", "status", "settled"]);
    assert.deepEqual({ ...win.market, startTime: undefined }, {
      marketId: WIN_MARKET,
      startTime: undefined,
      eventType: "Horse Racing",
      eventName: "Ascot",
      marketName: "2m Hcap",
      status: "Closed",
      settled: true,
    });
    assert.equal(win.market.startTime, localTime(fake.startTime, TZ));
    assert.deepEqual(win.data, { pick: "101" });
    assert.equal(win.storedAt, localTime("2026-10-01T10:00:00.000Z", TZ));
    assert.deepEqual(win.result!.runners, [
      { selectionId: "101", name: "Fast Horse", status: "Winner", isWinner: true, bsp: 3.4 },
      { selectionId: "102", name: "Slow Horse", status: "Loser", isWinner: false, bsp: 7.2 },
      { selectionId: "103", name: "Mid Horse", status: "Loser", isWinner: false, bsp: 5 },
    ]);
    assert.equal("profit" in win, false, "profit is added by the integration layer");
    assert.equal(place.market.settled, false);
    assert.equal(place.market.marketName, "To Be Placed");
    assert.equal(place.result, undefined);
    assert.deepEqual(unknown.market, { marketId: "1.300000001", marketName: "1.300000001", settled: false });

    assert.equal((await contexts.feedback("evanalysis", 1)).length, 1);
    assert.deepEqual(await contexts.feedback("Missing", 10), []);
    await assert.rejects(contexts.feedback(" ", 10), /dataContextName is required/);
  });

  test("feedback returns at most 1000 entries", async () => {
    const { contexts, state } = setup();
    for (let i = 0; i < 1005; i++) state.setDataContext(`1.4${String(i).padStart(8, "0")}`, "Bulk", { i });
    assert.equal((await contexts.feedback("Bulk", 5000)).length, 1000);
    assert.equal((await contexts.feedback("Bulk", Number.NaN)).length, 100);
  });
});

describe("review: degraded Betfair responses", () => {
  test("stored AI contexts stay readable when Betfair no longer knows the market and nothing is cached", async () => {
    const { contexts, state } = setup();
    const GONE = "1.500000001";
    state.setDataContext(GONE, "HorseRacingStrategyR1_Analysis", { pick: "7" });
    const env = await contexts.getForMarket(GONE, ["HorseRacingStrategyR1_Analysis", "BetfairSpData", "RacingTvDataForHorses"]);
    assert.deepEqual(Object.keys(env), ["market", "selectionsData", "data", "unavailableDataContexts"]);
    assert.deepEqual(env.market, { marketId: GONE, marketName: GONE });
    assert.deepEqual(env.selectionsData, []);
    assert.deepEqual(env.data, { HorseRacingStrategyR1_Analysis: { pick: "7" } });
    assert.match(env.unavailableDataContexts!.BetfairSpData, /was not found.*Continue the analysis without it/);
    assert.match(env.unavailableDataContexts!.RacingTvDataForHorses, /BFExplorer only/);
    // Without a stored context to return, or with a selection to resolve, the error still surfaces.
    await assert.rejects(contexts.getForMarket(GONE, ["BetfairSpData"]), /was not found/);
    await assert.rejects(contexts.getForMarket(GONE, ["HorseRacingStrategyR1_Analysis"], { selectionId: 1, handicap: 0 }), /was not found/);
  });

  test("without a market book, metadata providers still work and book providers say why", async () => {
    class NoBooks extends FakeBetfair {
      override async listMarketBook(args: Parameters<BetfairApi["listMarketBook"]>[0]) {
        this.calls.push({ method: "listMarketBook", args });
        return [];
      }
    }
    const { contexts } = setup(new NoBooks());
    const env = await contexts.getForMarket(WIN_MARKET, [
      "HorsesBaseBetfairFormData",
      "HorsesBetfairRaceInfoData",
      "BetfairSpData",
      "MarketSelectionsCandleStickData",
    ]);
    assert.equal(dataOf(env, "101").weight, 140);
    assert.equal(dataOf(env, "101").horseDetail.gender, "Gelding");
    assert.match(env.unavailableDataContexts!.BetfairSpData, /^Betfair returned no market book for 1\.200000001 \(No market book returned/);
    assert.match(env.unavailableDataContexts!.MarketSelectionsCandleStickData, /no market book/);
    assert.equal(env.market.status, undefined);
    assert.deepEqual(env.recording, {
      minutes: 0,
      volumeDataAvailable: false,
      note: "Nothing has been recorded for this market: open it with open_market so the connector records its trades.",
    });
  });
});

describe("review: feedback results", () => {
  const PAST_START = "2026-10-01T13:00:00.000Z";

  test("joins results (with BSP) for markets that settled while the connector was not watching, without recording them", async () => {
    const fake = new FakeBetfair();
    setStartTime(fake, PAST_START);
    const { contexts, state, markets, recorder } = setup(fake);
    await markets.getCatalogue(WIN_MARKET); // catalogue snapshot only: never opened, never polled
    await markets.getCatalogue(PLACE_MARKET);
    state.setDataContext(WIN_MARKET, "EVAnalysis", { pick: "101" });
    state.setDataContext(PLACE_MARKET, "EVAnalysis", { pick: "102" });
    fake.settle([102], WIN_MARKET, { bsp: { 101: 3.4, 102: 7.2, 103: 5 } });

    const entries = await contexts.feedback("EVAnalysis", 10);
    const win = entries.find((e) => e.market.marketId === WIN_MARKET)!;
    assert.equal(win.market.settled, true);
    assert.equal(win.market.status, "Closed");
    assert.deepEqual(win.result!.runners, [
      { selectionId: "101", name: "Fast Horse", status: "Loser", isWinner: false, bsp: 3.4 },
      { selectionId: "102", name: "Slow Horse", status: "Winner", isWinner: true, bsp: 7.2 },
      { selectionId: "103", name: "Mid Horse", status: "Loser", isWinner: false, bsp: 5 },
    ]);
    const place = entries.find((e) => e.market.marketId === PLACE_MARKET)!;
    assert.equal(place.market.settled, false, "the still-open PLACE market is not settled");
    assert.equal(state.archive.get(WIN_MARKET)?.marketType, "WIN", "the result is archived for race history");
    assert.equal(recorder.get(WIN_MARKET), undefined, "result lookups do not evict live recordings");

    // Betfair rule: a request mixing OPEN and CLOSED markets returns only the OPEN ones, so the missing one is asked again.
    assert.equal(fake.calls.filter((c) => c.method === "listMarketBook").length, 2);
    // Settled markets are not looked up again.
    fake.calls = [];
    await contexts.feedback("EVAnalysis", 10);
    assert.equal(fake.calls.filter((c) => c.method === "listMarketBook" && c.args.marketIds.includes(WIN_MARKET)).length, 0);
  });

  test("fills in BSPs missing from a market archived from a book without SP", async () => {
    const fake = new FakeBetfair();
    setStartTime(fake, PAST_START);
    const { contexts, state, markets } = setup(fake);
    await markets.openMarket(WIN_MARKET);
    fake.book().inplay = true;
    fake.trade(101, 1.5, 20);
    await markets.getBooks(markets.monitoredMarketIds());
    state.setDataContext(WIN_MARKET, "EVAnalysis", { pick: "101" });
    fake.settle([101], WIN_MARKET, { bsp: { 101: 3.4, 102: 7.2, 103: 5 } });
    await markets.getBooks(markets.monitoredMarketIds()); // the recorder's poll (no SP) archives the market
    assert.equal(state.archive.get(WIN_MARKET)?.runners[0].bsp, undefined);

    const [entry] = await contexts.feedback("EVAnalysis", 10);
    assert.deepEqual(entry.result!.runners.map((r) => r.bsp), [3.4, 7.2, 5]);
    const archived = state.archive.get(WIN_MARKET)!.runners[0];
    assert.equal(archived.bsp, 3.4, "the archive keeps the BSP for race history");
    assert.equal(archived.inPlayMin, 1.01, "fields recorded at settlement are kept");
  });

  test("a Betfair failure while looking up results does not fail feedback", async () => {
    class BooksFail extends FakeBetfair {
      override async listMarketBook(): Promise<never> {
        throw new Error("TOO_MUCH_DATA");
      }
    }
    const { contexts, state } = setup(new BooksFail());
    state.setDataContext(WIN_MARKET, "EVAnalysis", { pick: "101" });
    const [entry] = await contexts.feedback("EVAnalysis", 10);
    assert.equal(entry.market.settled, false);
  });

  test("race info fills pastRaces[].price for a race archived from a poll without SP", async () => {
    const fake = new FakeBetfair();
    const PAST = "1.200000009";
    fake.catalogues.set(PAST, { ...structuredClone(fake.catalogues.get(WIN_MARKET)!), marketId: PAST, marketName: "1m Hcap", marketStartTime: PAST_START });
    fake.books.set(PAST, { ...structuredClone(fake.book(WIN_MARKET)), marketId: PAST });
    const { contexts, markets, state } = setup(fake);
    await markets.openMarket(PAST);
    fake.settle([102], PAST, { bsp: { 101: 4.1, 102: 6.2, 103: 9 } });
    await markets.getBooks(markets.monitoredMarketIds()); // the recorder's poll archives it without BSPs
    assert.equal(state.archive.get(PAST)?.runners[1].bsp, undefined);
    const env = await contexts.getForMarket(WIN_MARKET, ["HorsesBetfairRaceInfoData"]);
    assert.equal(dataOf(env, "102").horseDetail.pastRaces[0].price, 6.2);
    assert.equal(dataOf(env, "101").horseDetail.pastRaces[0].price, 4.1);
    fake.calls = [];
    await contexts.getForMarket(WIN_MARKET, ["HorsesBetfairRaceInfoData"]);
    assert.equal(fake.calls.filter((c) => c.method === "listMarketBook" && c.args.marketIds.includes(PAST)).length, 0, "looked up once");
  });

  test("ids that are not Betfair market ids are never sent with a result lookup", async () => {
    const fake = new FakeBetfair();
    setStartTime(fake, PAST_START);
    const { contexts, state, markets } = setup(fake);
    await markets.getCatalogue(WIN_MARKET);
    state.setDataContext("not-a-market", "EVAnalysis", { pick: "x" });
    state.setDataContext(WIN_MARKET, "EVAnalysis", { pick: "101" });
    fake.settle([101], WIN_MARKET);
    const entries = await contexts.feedback("EVAnalysis", 10);
    assert.equal(entries.length, 2);
    assert.equal(entries.find((e) => e.market.marketId === WIN_MARKET)!.market.settled, true);
    for (const call of fake.calls.filter((c) => c.method === "listMarketBook")) assert.ok(!call.args.marketIds.includes("not-a-market"));
  });
});
