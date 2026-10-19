import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { createServer } from "../src/server.js";
import { FakeBetfair, MARKET_ID } from "./fakeBetfair.js";

async function connect(env: Record<string, string> = {}) {
  const fake = new FakeBetfair();
  const connector = new Connector(loadConfig({ RECORD_INTERVAL_SECONDS: "0", ...env }), fake);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(connector).connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = result.content[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { fake, connector, client, call };
}

describe("paper trading workflow", () => {
  let ctx: Awaited<ReturnType<typeof connect>>;
  before(async () => {
    ctx = await connect();
  });

  test("exposes the BFExplorer-compatible tools and the prompt library", async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      "GetActiveMarket",
      "GetAllDataContextForMarket",
      "ExecuteBfexplorerStrategySettings",
      "SetAIAgentDataContextForBetfairMarket",
      "GetDataContextForMarketSelection",
      "GetAllBetResults",
    ]) {
      assert.ok(names.includes(name), name);
    }
    const { prompts } = await ctx.client.listPrompts();
    assert.ok(prompts.length > 100, `only ${prompts.length} prompts`);
    const instructions = ctx.client.getInstructions();
    assert.match(instructions ?? "", /PAPER TRADING/);
  });

  test("status reports mode, limits and Betfair connectivity", async () => {
    const status = await ctx.call("GetConnectorStatus");
    assert.equal(status.mode, "paper");
    assert.deepEqual(status.limits, { maxStake: 25, maxLiability: 250 });
    assert.equal(status.betfair.connected, true);
    assert.equal(status.betfair.accountAvailableToBetBalance, 500);
    assert.equal(status.paperFunds.availableToBetBalance, 1000);
  });

  test("GetActiveMarket explains how to pick a market when none is active", async () => {
    await assert.rejects(ctx.call("GetActiveMarket"), /FindMarkets/);
  });

  test("finds and opens a market", async () => {
    const found = await ctx.call("FindMarkets", { sport: "horses", countries: ["gb"], marketTypes: ["win"] });
    assert.equal(found.markets[0].marketId, MARKET_ID);
    const filter = ctx.fake.calls.find((c) => c.method === "listMarketCatalogue")!.args as { filter: Record<string, unknown> };
    assert.deepEqual(filter.filter.eventTypeIds, ["7"]);
    assert.deepEqual(filter.filter.marketCountries, ["GB"]);

    await ctx.call("OpenMarket", { marketId: MARKET_ID });
    const view = await ctx.call("GetActiveMarket");
    assert.equal(view.market.marketId, MARKET_ID);
    assert.equal(view.market.eventType, "Horse Racing");
    assert.equal(view.market.status, "Open");
    assert.equal(view.selections[0].selectionId, "101_0.00");
    assert.equal(view.selections[0].backPrice, 3.0);
    assert.equal(view.selections[0].layPrice, 3.05);
  });

  test("builds data contexts and reports BFExplorer-only ones as unavailable", async () => {
    const data = await ctx.call("GetAllDataContextForMarket", {
      marketId: MARKET_ID,
      dataContextNames: ["HorsesBaseBetfairFormData", "WeightOfMoneyData", "BetfairSpData", "MarketSelectionsTradedPricesData", "RacingpostDataForHorses"],
    });
    const fav = data.selectionsData[0];
    assert.equal(fav.name, "Fast Horse");
    assert.equal(fav.HorsesBaseBetfairFormData.officialRating, 85);
    assert.equal(fav.HorsesBaseBetfairFormData.forecastPrice, 3);
    assert.equal(fav.HorsesBaseBetfairFormData.weight, "140 pounds");
    assert.equal(fav.BetfairSpData.industryStartingPrice, 3);
    assert.equal(fav.BetfairSpData.nearPrice, 3.1);
    assert.ok(fav.WeightOfMoneyData.backingPressure > 0 && fav.WeightOfMoneyData.backingPressure < 1);
    assert.equal(fav.MarketSelectionsTradedPricesData.tradedVolume, 3000);
    assert.match(data.unavailableDataContexts.RacingpostDataForHorses, /BFExplorer only/);
    const book = ctx.fake.calls.filter((c) => c.method === "listMarketBook").at(-1)!.args as { priceProjection: { priceData: string[] } };
    assert.ok(book.priceProjection.priceData.includes("EX_ALL_OFFERS"));
    assert.ok(!book.priceProjection.priceData.includes("EX_BEST_OFFERS"));
  });

  test("stores and reads back AI agent data contexts", async () => {
    await ctx.call("SetAIAgentDataContextForBetfairMarket", {
      marketId: MARKET_ID,
      dataContextName: "HorseRacingEVAnalysisResults",
      jsonData: JSON.stringify({ pick: "101_0.00", ev: 12.5 }),
    });
    const data = await ctx.call("GetAllDataContextForMarket", { marketId: MARKET_ID, dataContextNames: ["HorseRacingEVAnalysisResults"] });
    assert.equal(data.marketDataContexts.HorseRacingEVAnalysisResults.data.ev, 12.5);
  });

  test("price history and candlesticks come from recorded snapshots", async () => {
    ctx.fake.setRunner(101, { lastPriceTraded: 2.9, totalMatched: 3400, ex: { availableToBack: [{ price: 2.9, size: 50 }], availableToLay: [{ price: 2.92, size: 50 }] } });
    await new Promise((r) => setTimeout(r, 1100));
    await ctx.connector.recordOnce();
    const data = await ctx.call("GetDataContextForMarketSelection", {
      marketId: MARKET_ID,
      selectionId: "101_0.00",
      dataContextNames: ["MarketSelectionsPriceHistoryData", "MarketSelectionsCandleStickData", "MarketSelectionsTradedPricesData"],
    });
    assert.ok(data.selection.MarketSelectionsPriceHistoryData.points.length >= 2);
    assert.ok(data.selection.MarketSelectionsCandleStickData.candles.length >= 1);
    assert.equal(data.selection.MarketSelectionsTradedPricesData.startPrice, 3);
    assert.equal(data.selection.MarketSelectionsTradedPricesData.endPrice, 2.9);
  });

  test("executes a built-in strategy against the order book", async () => {
    ctx.fake.setRunner(101, {
      lastPriceTraded: 3.0,
      ex: { availableToBack: [{ price: 3.0, size: 100 }], availableToLay: [{ price: 3.05, size: 100 }] },
    });
    const result = await ctx.call("ExecuteBfexplorerStrategySettings", { strategyName: "bet 10 euro", marketId: MARKET_ID, selectionId: "101_0.00" });
    assert.equal(result.mode, "paper");
    assert.equal(result.status, "Executed");
    assert.equal(result.bets[0].side, "BACK");
    assert.equal(result.bets[0].price, 3.0);
    assert.equal(result.bets[0].sizeMatched, 10);
    assert.equal(ctx.fake.calls.filter((c) => c.method === "placeOrders").length, 0, "paper mode must never call placeOrders");

    const orders = await ctx.call("GetCurrentOrders", { marketId: MARKET_ID });
    const position = orders.positions.find((p: { selectionId: string }) => p.selectionId === "101_0.00");
    assert.equal(position.ifWin, 20);
    assert.equal(position.ifLose, -10);
  });

  test("enforces risk limits", async () => {
    const result = await ctx.call("ExecuteBfexplorerStrategySettingsWithParameters", {
      strategyName: "Bet 10 Euro",
      marketId: MARKET_ID,
      selectionId: "102_0.00",
      parameters: JSON.stringify({ Stake: 500 }),
    });
    assert.equal(result.status, "Failed");
    assert.match(result.messages[0], /MAX_STAKE/);
    assert.equal(result.bets.length, 0);
  });

  test("respects odds limits and parameter overrides", async () => {
    const skipped = await ctx.call("ExecuteBfexplorerStrategySettingsWithParameters", {
      strategyName: "Lay 10 Euro",
      marketId: MARKET_ID,
      selectionId: "102_0.00",
      parameters: JSON.stringify({ MaximumOdds: 5 }),
    });
    assert.equal(skipped.status, "Skipped");
    assert.match(skipped.messages[0], /outside the allowed range/);
  });

  test("an unmatched resting bet fills when the market trades through it", async () => {
    const result = await ctx.call("ExecuteBfexplorerStrategySettingsWithParameters", {
      strategyName: "Bet 10 Euro",
      marketId: MARKET_ID,
      selectionId: "103_0.00",
      parameters: JSON.stringify({ Stake: 5, Odds: 5.0 }),
    });
    assert.equal(result.bets[0].sizeMatched, 0);
    ctx.fake.setRunner(103, { lastPriceTraded: 5.1, ex: { availableToBack: [{ price: 5.1, size: 30 }], availableToLay: [{ price: 5.2, size: 30 }] } });
    const orders = await ctx.call("GetCurrentOrders", { marketId: MARKET_ID });
    const filled = orders.orders.find((o: { betId: string }) => o.betId === result.bets[0].betId);
    assert.equal(filled.sizeMatched, 5);
    assert.equal(filled.averagePriceMatched, 5.0);
  });

  test("closes a position by greening up", async () => {
    ctx.fake.setRunner(101, { ex: { availableToBack: [{ price: 2.5, size: 100 }], availableToLay: [{ price: 2.52, size: 100 }] } });
    const result = await ctx.call("ExecuteBfexplorerStrategySettings", { strategyName: "Close Selection Bet Position", marketId: MARKET_ID, selectionId: "101_0.00" });
    assert.equal(result.bets[0].side, "LAY");
    assert.equal(result.bets[0].price, 2.52);
    const orders = await ctx.call("GetCurrentOrders", { marketId: MARKET_ID });
    const position = orders.positions.find((p: { selectionId: string }) => p.selectionId === "101_0.00");
    assert.ok(Math.abs(position.ifWin - position.ifLose) < 0.05, JSON.stringify(position));
    assert.ok(position.ifWin > 0);
  });

  test("dutches across selections", async () => {
    const result = await ctx.call("ExecuteBfexplorerStrategySettingsOnSelections", {
      strategyName: "Dutch 10 Euro stake",
      marketId: MARKET_ID,
      selectionIds: ["102_0.00", "103_0.00"],
    });
    assert.equal(result.bets.length, 2);
    const total = result.bets.reduce((t: number, b: { size: number }) => t + b.size, 0);
    assert.ok(Math.abs(total - 10) < 0.05);
  });

  test("settles paper bets with real results when the market closes", async () => {
    const before = await ctx.call("GetAccountFunds");
    assert.ok(before.exposure > 0);
    ctx.fake.book.status = "CLOSED";
    ctx.fake.book.runners = ctx.fake.book.runners.map((r) => ({ ...r, status: r.selectionId === 101 ? "WINNER" : "LOSER" }));
    const results = await ctx.call("GetAllBetResults", {});
    assert.ok(results.summary.bets >= 4);
    const fav = results.bets.filter((b: { selectionId: string }) => b.selectionId === "101_0.00");
    assert.ok(fav.some((b: { outcome: string }) => b.outcome === "WON"));
    const after = await ctx.call("GetAccountFunds");
    assert.equal(after.exposure, 0);
    assert.equal(after.balance, 1000 + results.summary.netProfit);
    const monitored = await ctx.call("GetBetfairMonitoredMarkets");
    assert.equal(monitored.markets[0].status, "Closed");
  });
});

test("paper settlement waits until the closed market has final results", async () => {
  const { call, fake } = await connect();
  await call("ExecuteBfexplorerStrategySettings", { strategyName: "Lay 2 Euro", marketId: MARKET_ID, selectionId: "102_0.00" });
  fake.book.status = "CLOSED";
  assert.equal((await call("GetAllBetResults", {})).summary.bets, 0);
  fake.book.runners = fake.book.runners.map((r) => ({ ...r, status: r.selectionId === 101 ? "WINNER" : "LOSER" }));
  const results = await call("GetAllBetResults", {});
  assert.equal(results.summary.bets, 1);
  assert.equal(results.bets[0].profit, 2);
  assert.equal(results.summary.commission, 0.1);
  assert.equal(results.summary.netProfit, 1.9);
});

describe("strategy settings and prompt library", () => {
  test("custom strategy settings can be saved and executed", async () => {
    const { call } = await connect();
    await call("SaveBfexplorerStrategySettings", {
      strategyName: "Back 3 between 2 and 4",
      templateName: "place bet",
      parameters: JSON.stringify({ BetType: "Back", Stake: 3, MinimumOdds: 2, MaximumOdds: 4 }),
    });
    const all = await call("GetAllBfexplorerStrategySettings");
    assert.ok(all.strategies.some((s: { name: string }) => s.name === "Back 3 between 2 and 4"));
    const result = await call("ExecuteBfexplorerStrategySettings", { strategyName: "Back 3 between 2 and 4", marketId: MARKET_ID, selectionId: "101_0.00" });
    assert.equal(result.bets[0].size, 3);
    await assert.rejects(call("ExecuteBfexplorerStrategySettings", { strategyName: "Nope", marketId: MARKET_ID, selectionId: "101_0.00" }), /not found/);
  });

  test("searches and renders library prompts with connector notes", async () => {
    const { call, client } = await connect();
    const found = await call("SearchStrategyPrompts", { query: "weight of money" });
    assert.ok(found.prompts.some((p: { id: string }) => p.id === "General/WeightOfMoneyAnalysisPrompt"));
    const timeform = await call("GetStrategyPrompt", { id: "HorseRacingEVAnalysisFavouriteR3" });
    assert.equal(timeform.compatibility, "partial");
    assert.deepEqual(timeform.missingDataContexts, ["TimeformDataForHorses"]);
    assert.match(timeform.text, /PAPER trading/);
    assert.match(timeform.text, /GetAllDataContextForMarket/);

    const fully = await call("SearchStrategyPrompts", { onlyFullySupported: true, limit: 130 });
    assert.ok(fully.prompts.every((p: { compatibility: string }) => p.compatibility === "full"));

    const prompt = await client.getPrompt({ name: "WeightOfMoneyAnalysisPrompt", arguments: { marketId: MARKET_ID } });
    const text = (prompt.messages[0].content as { text: string }).text;
    assert.match(text, new RegExp(`OpenMarket with this marketId`));

    const { resources } = await client.listResources();
    assert.ok(resources.length > 100);
    const read = await client.readResource({ uri: "betfair-prompts://General/WeightOfMoneyAnalysisPrompt" });
    assert.match((read.contents[0] as { text: string }).text, /Weight of Money/);
  });
});

describe("live mode", () => {
  test("sends real orders through the Betfair API with the strategy reference", async () => {
    const { call, fake } = await connect({ TRADING_MODE: "live" });
    const result = await call("ExecuteBfexplorerStrategySettings", { strategyName: "Lay 10 Euro", marketId: MARKET_ID, selectionId: "103_0.00" });
    assert.equal(result.mode, "live");
    const place = fake.calls.find((c) => c.method === "placeOrders")!.args as {
      customerStrategyRef: string;
      instructions: Array<{ side: string; limitOrder: { price: number; size: number; persistenceType: string } }>;
    };
    assert.equal(place.customerStrategyRef, "Lay 10 Euro");
    assert.deepEqual(place.instructions[0].limitOrder, { price: 4.6, size: 10, persistenceType: "LAPSE" });
    assert.equal(place.instructions[0].side, "LAY");

    const funds = await call("GetAccountFunds");
    assert.equal(funds.mode, "live");
    assert.equal(funds.exposure, 20);
  });

  test("a back trade places an offset lay after the entry matches", async () => {
    const { call, fake } = await connect({ TRADING_MODE: "live" });
    const result = await call("ExecuteBfexplorerStrategySettings", { strategyName: "Back Trade", marketId: MARKET_ID, selectionId: "101_0.00" });
    const [entry, offset] = result.bets;
    assert.equal(entry.role, "entry");
    assert.equal(entry.price, 3.0);
    assert.equal(offset.role, "offset");
    assert.equal(offset.side, "LAY");
    assert.equal(offset.price, 2.96);
    assert.equal(offset.size, 10.14);
    assert.equal(fake.calls.filter((c) => c.method === "placeOrders").length, 2);
  });
});
