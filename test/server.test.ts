import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { Connector, IMPLEMENTED_BFEXPLORER_TOOLS } from "../src/connector.js";
import { createServer } from "../src/server.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

async function connect(env: Record<string, string> = {}) {
  const fake = new FakeBetfair();
  const connector = new Connector(loadConfig({ RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...env }), fake);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(connector, {}).connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: Boolean(result.isError), text: result.content[0].text };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { isError, text } = await raw(name, args);
    if (isError) throw new Error(text);
    return text;
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await call(name, args));
  return { fake, connector, client, raw, call, json };
}

describe("paper-mode tool surface", () => {
  let ctx: Awaited<ReturnType<typeof connect>>;
  before(async () => {
    ctx = await connect();
  });

  test("registers BFExplorer's snake_case tools plus connector tools", async () => {
    const names = new Set((await ctx.client.listTools()).tools.map((t) => t.name));
    for (const tool of IMPLEMENTED_BFEXPLORER_TOOLS) assert.ok(names.has(tool), tool);
    for (const tool of ["find_markets", "get_current_orders", "cancel_bets", "get_account_funds", "get_bots", "stop_bot", "get_connector_status", "search_strategy_prompts"]) {
      assert.ok(names.has(tool), tool);
    }
    assert.ok(!names.has("GetActiveMarket"), "legacy names are off by default");
    assert.match(ctx.client.getInstructions() ?? "", /PAPER TRADING/);
  });

  test("get_active_market explains how to choose a market when none is active", async () => {
    const { isError, text } = await ctx.raw("get_active_market");
    assert.ok(isError);
    assert.match(text, /find_markets/);
  });

  test("open_market and get_active_market return BFExplorer's TOON", async () => {
    const found = await ctx.json("find_markets", { sport: "Horse Racing", countries: ["GB"], marketTypes: ["WIN"] });
    assert.equal(found.markets[0].marketId, WIN_MARKET);
    const opened = await ctx.call("open_market", { marketId: WIN_MARKET });
    assert.match(opened, /^betfairMarket:\n  marketId: "1\.200000001"\n/);
    const active = await ctx.call("get_active_market");
    const lines = active.split("\n");
    assert.equal(lines[0], "activeBetfairMarket:");
    assert.match(active, /\n  eventType: "Horse Racing"\n  eventName: Ascot\n  marketName: "2m Hcap"\n/);
    assert.match(active, /\n  selections\[3\]\{selectionId,name,price,totalMatched,status\}:\n    "101","Fast Horse",3,3000,Active\n    "103","Mid Horse",4\.5,1200,Active\n    "102","Slow Horse",6,800,Active$/);
  });

  test("data contexts use BFExplorer's envelope and merge provider keys", async () => {
    const env = await ctx.json("get_all_data_context_for_market", {
      dataContextNames: "MarketSelectionsCandleStickData, WeightOfMoneyData,BetfairSpData,RacingpostDataForHorses",
    });
    assert.deepEqual(Object.keys(env.market), ["marketId", "startTime", "eventType", "eventName", "marketName", "status"]);
    assert.equal(env.market.eventName, "Ascot");
    assert.match(env.market.startTime, /[+-]\d\d:\d\d$/);
    const fav = env.selectionsData[0];
    assert.deepEqual(Object.keys(fav).slice(0, 2), ["selectionId", "name"]);
    assert.equal(fav.selectionId, "101");
    assert.ok(fav.data.vwaPrice > 0);
    assert.ok(Array.isArray(fav.data.offeredPrices));
    assert.equal(fav.data.price, 3);
    assert.match(env.unavailableDataContexts.RacingpostDataForHorses, /BFExplorer only/);

    const one = await ctx.json("get_data_context_for_market_selection", { dataContextName: "HorsesBaseBetfairFormData", selectionId: 101 });
    assert.equal(one.selectionsData.length, 1);
    assert.equal(one.selectionsData[0].data.weight, 140);
  });

  test("activate_market_selection lets executions use the active selection", async () => {
    assert.deepEqual(await ctx.json("activate_market_selection", { marketId: WIN_MARKET, selectionId: "101" }), {
      status: true,
      marketId: WIN_MARKET,
      selectionId: "101",
    });
    const result = await ctx.json("execute_strategy_settings", { strategyName: "Bet 10 Euro" });
    assert.equal(Object.keys(result)[0], "status");
    assert.equal(result.status, true);
    assert.equal(result.mode, "paper");
    assert.equal(result.bets[0].selectionId, "101");
    assert.equal(result.bets[0].sizeMatched, 10);
    assert.equal(ctx.fake.calls.filter((c) => c.method === "placeOrders").length, 0, "paper mode never calls placeOrders");
  });

  test("Trade x profit accepts BFExplorer's dotted parameters and starts a bot", async () => {
    const result = await ctx.json("execute_strategy_settings_with_parameters", {
      strategyName: "Trade x profit",
      marketId: WIN_MARKET,
      selectionId: "103",
      parameters: JSON.stringify({ "OpenBetPosition.BetType": "Lay", "CloseBetPosition.Profit": 9 }),
    });
    assert.equal(result.status, true, JSON.stringify(result));
    assert.equal(result.outcome, "Started");
    assert.equal(result.bets[0].side, "LAY");
    const bots = await ctx.json("get_bots", { status: "running" });
    assert.ok(bots.some((b: { id: string }) => b.id === result.botId));
  });

  test("unknown parameter names reject the execution before any bet", async () => {
    const before = ctx.connector.state.paper.orders.length;
    const result = await ctx.json("execute_strategy_settings_with_parameters", {
      strategyName: "Bet 10 Euro",
      selectionId: "102",
      parameters: { "CloseBetPosition.Price": 3 },
    });
    assert.equal(result.status, false);
    assert.match(result.message, /CloseBetPosition\.Price/);
    assert.equal(ctx.connector.state.paper.orders.length, before);
  });

  test("current orders, cancel guard and funds", async () => {
    const orders = await ctx.json("get_current_orders", { marketId: WIN_MARKET });
    const position = orders.positions.find((p: { selectionId: string }) => p.selectionId === "101");
    assert.equal(position.ifWin, 20);
    assert.equal(position.ifLose, -10);
    assert.ok("marketProfitIfWins" in position);
    const { isError, text } = await ctx.raw("cancel_bets", { marketId: WIN_MARKET });
    assert.ok(isError);
    assert.match(text, /all:true/);
    const funds = await ctx.json("get_account_funds");
    assert.equal(funds.mode, "paper");
    assert.ok(funds.exposure > 0);
  });

  test("strategy templates, settings and creation", async () => {
    const template = await ctx.call("get_strategy_template", { templateName: "Place Bet and Close Selection Bet Position" });
    assert.match(template, /^strategyTemplate:\n/);
    assert.match(template, /OpenBetPosition\.Stake/);
    assert.match(await ctx.call("get_all_strategy_settings"), /"Trade x profit"/);
    const created = await ctx.json("create_strategy_settings", {
      strategyTemplateParameters: [
        { name: "Back 5 at 3-8", template: "Place Bet", parameters: { BetType: "Back", Stake: 5, MinimumOdds: 3, MaximumOdds: 8 } },
        { name: "Bet 10 Euro", template: "Place Bet", parameters: { BetType: "Lay", Stake: 50 } },
      ],
    });
    assert.equal(created[0].status, true);
    assert.equal(created[1].status, false, "create never replaces an existing setting");
    assert.match(await ctx.call("get_strategy_setting", { strategyName: "Back 5 at 3-8" }), /Stake: 5/);
  });

  test("AI contexts, settlement, bet results and feedback", async () => {
    assert.deepEqual((await ctx.json("set_ai_agent_data_context_for_market", { dataContextName: "EVAnalysis", jsonData: '{"pick":"101"}' })).status, true);
    const stored = await ctx.json("get_all_data_context_for_market", { dataContextNames: ["EVAnalysis"] });
    assert.deepEqual(stored.data.EVAnalysis, { pick: "101" });

    await ctx.json("stop_bot", { botId: (await ctx.json("get_bots", { status: "running" }))[0].id });
    ctx.fake.settle([101], WIN_MARKET, { bsp: { 101: 3.2, 102: 6.5, 103: 4.8 } });
    const results = await ctx.json("get_all_bet_results");
    const market = results.betResults.find((m: { market: { marketId: string } }) => m.market.marketId === WIN_MARKET);
    assert.equal(market.market.eventName, "Ascot");
    const fav = market.selectionsBets.find((s: { selectionId: string }) => s.selectionId === "101");
    assert.equal(fav.status, "Winner");
    assert.equal(fav.bets[0].betType, "Back");
    assert.ok(results.summary.bets >= 1);

    const feedback = await ctx.json("get_ai_agent_data_context_feedback", { dataContextName: "EVAnalysis" });
    assert.equal(feedback[0].market.settled, true);
    assert.equal(feedback[0].result.runners.find((r: { selectionId: string }) => r.selectionId === "101").isWinner, true);
    assert.equal(typeof feedback[0].profit, "number");
    assert.match(await ctx.call("get_market", { marketId: WIN_MARKET }), /"101","Fast Horse",1\.01,[\d.]+,Winner/);
  });

  test("providers, favourites, commands and status", async () => {
    const providers = await ctx.call("get_available_data_context_providers");
    assert.match(providers, /^dataContextProviders:\n  providers\[\d+\]\{name,status,dataKeys,description\}:/);
    assert.match(providers, /MarketSelectionsPriceMetricData,available/);
    assert.match(await ctx.call("get_my_favourite_bet_events"), /"Horse Racing - GB and IE"/);
    assert.match(await ctx.call("get_application_commands"), /RecordNow/);
    assert.equal((await ctx.json("execute_application_command", { id: "recordnow" })).status, true);
    const status = await ctx.json("get_connector_status");
    assert.equal(status.mode, "paper");
    assert.equal(status.betfair.connected, true);
    assert.equal(status.betfair.currency, "GBP");
  });

  test("prompt library as tools, MCP prompts and resources", async () => {
    const found = await ctx.json("search_strategy_prompts", { query: "weight of money", executesBets: false });
    assert.ok(found.prompts.length > 0);
    const prompt = await ctx.json("get_strategy_prompt", { id: "HorseRacing/HorseRacingBetfairSpDataR1_Favourite_Silent", marketId: WIN_MARKET });
    assert.equal(prompt.executesBets, true);
    assert.match(prompt.text, /PAPER/);
    assert.match(prompt.text, /open_market/);
    const { prompts } = await ctx.client.listPrompts();
    assert.ok(prompts.length > 100);
    const { resources } = await ctx.client.listResources();
    assert.ok(resources.some((r) => r.uri === "bfexplorer://activeBetfairMarket"));
    const read = await ctx.client.readResource({ uri: "bfexplorer://bfexplorerStrategySettings" });
    assert.match((read.contents[0] as { text: string }).text, /^strategySettings:/);
  });
});

describe("data context names", () => {
  test("a JSON array sent as text is parsed, not split on its commas into bogus names", async () => {
    const { json } = await connect();
    for (const dataContextNames of ['["BetfairSpData","HorsesBaseBetfairFormData"]', ' [ "BetfairSpData", "HorsesBaseBetfairFormData" ] ', "[BetfairSpData, 'HorsesBaseBetfairFormData']"]) {
      const env = await json("get_all_data_context_for_market", { marketId: WIN_MARKET, dataContextNames });
      assert.equal(env.unavailableDataContexts, undefined, dataContextNames);
      const fav = env.selectionsData.find((s: { selectionId: string }) => s.selectionId === "101");
      assert.equal(fav.data.price, 3);
      assert.equal(fav.data.weight, 140);
    }
    const one = await json("get_data_context_for_market_selection", { marketId: WIN_MARKET, selectionId: "101", dataContextNames: '["HorsesBaseBetfairFormData"]' });
    assert.equal(one.selectionsData[0].data.weight, 140);
  });
});

describe("tool naming modes", () => {
  test("legacy mode registers the PascalCase names prompts use", async () => {
    const { client, call } = await connect({ TOOL_NAMES: "legacy" });
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const name of ["GetActiveMarket", "GetAllDataContextForMarket", "ExecuteBfexplorerStrategySettings", "SetAIAgentDataContextForBetfairMarket", "OpenMarket"]) {
      assert.ok(names.has(name), name);
    }
    assert.ok(!names.has("get_active_market"));
    assert.match(await call("OpenMarket", { marketId: WIN_MARKET }), /^betfairMarket:/);
  });

  test("both mode registers each tool under both names", async () => {
    const { client } = await connect({ TOOL_NAMES: "both" });
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    assert.ok(names.has("get_active_market") && names.has("GetActiveMarket"));
  });

  test("strict mode drops connector additions from market TOON", async () => {
    const { call } = await connect({ BFEXPLORER_STRICT: "1" });
    assert.doesNotMatch(await call("open_market", { marketId: WIN_MARKET }), /inPlay/);
  });
});

describe("live mode", () => {
  test("sends real orders with strategy attribution and idempotency refs", async () => {
    const { fake, json, client } = await connect({ TRADING_MODE: "live" });
    assert.match(client.getInstructions() ?? "", /LIVE TRADING/);
    const result = await json("execute_strategy_settings", { strategyName: "Lay 10 Euro", marketId: WIN_MARKET, selectionId: "103" });
    assert.equal(result.status, true, JSON.stringify(result));
    assert.equal(result.mode, "live");
    const place = fake.calls.find((c) => c.method === "placeOrders")!.args;
    assert.equal(place.customerStrategyRef, "Lay 10 Euro");
    assert.ok(place.customerRef && place.customerRef.length <= 32);
    assert.ok(place.instructions[0].customerOrderRef);
    assert.deepEqual(place.instructions[0].limitOrder, { size: 10, price: 4.6, persistenceType: "LAPSE" });
    const funds = await json("get_account_funds");
    assert.equal(funds.mode, "live");
  });

  test("risk limits stop oversized bets before they reach Betfair", async () => {
    const { fake, json } = await connect({ TRADING_MODE: "live" });
    const result = await json("execute_strategy_settings_with_parameters", {
      strategyName: "Bet 10 Euro",
      marketId: WIN_MARKET,
      selectionId: "101",
      parameters: { Stake: 500 },
    });
    assert.equal(result.status, false);
    assert.match(result.message, /MAX_STAKE/);
    assert.equal(fake.calls.filter((c) => c.method === "placeOrders").length, 0);
  });
});
