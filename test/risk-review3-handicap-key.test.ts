// Regression test from a third independent review (high): the guard keys a bet by formatSelectionId(selectionId, handicap), so a handicap
// of 1e-10 makes "101_0.00", a selection of its own, different from "101". The exchange matches
// runners with a tolerance (sameSelection: |difference| < 1e-9 in paper mode, the engine's
// runnerOf/findRunner too), so the bet is really on runner 101. In a single-winner market the guard
// then enumerates "101 wins" and "101_0.00 wins" as different outcomes, and two lays on the same
// runner look like a dutch that covers itself: the second lay *lowers* the guard's market worst
// case, MAX_MARKET_LIABILITY passes and nothing is charged against MAX_TOTAL_EXPOSURE or
// DAILY_LOSS_LIMIT. An agent reaches it with selectionId "101_0.0000000001" (parseSelectionId
// accepts it). In live mode the order goes to Betfair with handicap 1e-10.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { createServer } from "../src/server.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };
const LIMITS = { MAX_STAKE: "25", MAX_LIABILITY: "25", MAX_MARKET_LIABILITY: "25", MAX_TOTAL_EXPOSURE: "25", DAILY_LOSS_LIMIT: "1000" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number, extra: Partial<OrderRequest> = {}): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE", ...extra };
}

describe("review 3: a near-zero handicap makes the same runner a second selection", () => {
  test("paper, exchange level: two lays of 20.5 liability on runner 101 pass MAX_MARKET_LIABILITY / MAX_TOTAL_EXPOSURE 25", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...LIMITS }), fake);
    const [first] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 10)], TAG);
    assert.equal(first.sizeMatched, 10);
    const [second] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 10, { handicap: 1e-10 })], TAG);
    const exposure = (await c.exchange.accountFunds()).exposure;
    assert.ok(
      exposure <= 25 + 1e-9,
      `second lay ${second.status} on ${second.selectionId} (matched ${second.sizeMatched}): open worst case ${exposure} (101 wins: both lays lose) > 25`,
    );
  });

  test("MCP: the same through execute_strategy_settings_on_selections with selectionId 101_0.0000000001", async () => {
    const fake = new FakeBetfair();
    const connector = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...LIMITS }), fake);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(connector, {}).connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    const run = async (selectionId: string) => {
      const result = (await client.callTool({
        name: "execute_strategy_settings_on_selections",
        arguments: { strategyName: "Lay 10 Euro", marketId: WIN_MARKET, selectionIds: [selectionId] },
      })) as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0].text) as { status: boolean; bets: Array<{ status: string; selectionId: string; sizeMatched?: number }> };
    };
    const a = await run("101");
    assert.equal(a.bets[0]?.status, "SUCCESS");
    const b = await run("101_0.0000000001");
    const exposure = (await connector.exchange.accountFunds()).exposure;
    assert.ok(
      exposure <= 25 + 1e-9,
      `second "Lay 10 Euro" ${b.bets[0]?.status} on ${b.bets[0]?.selectionId}: open worst case ${exposure} > MAX_MARKET_LIABILITY / MAX_TOTAL_EXPOSURE 25`,
    );
  });
});
