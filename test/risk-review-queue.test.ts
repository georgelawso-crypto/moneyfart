// Regression test from an independent review (regression, latency): the guard holds one account-wide queue for the whole inner
// placeOrders call, including Betfair's in-play bet delay (and, live, up to the 30 s placeOrders
// timeout plus reconciliation). Any placement on any other market, closing bets included, waits.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" };
}

describe("review: one market's bet delay holds up every other market", () => {
  test("a closing bet on a pre-off market waits for another market's 2 s in-play bet delay", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    // An open back on PLACE that needs closing before its off.
    assert.equal((await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 10)], TAG))[0].sizeMatched, 10);
    // WIN goes in-play with a 2 s bet delay.
    fake.book(WIN_MARKET).inplay = true;
    fake.book(WIN_MARKET).betDelay = 2;

    const started = Date.now();
    const inPlay = c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 5)], TAG);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await c.exchange.placeOrders(PLACE_MARKET, [order(101, "LAY", 1.52, 9.87)], TAG); // the close
    const closeTook = Date.now() - started;
    await inPlay;
    assert.ok(closeTook < 1000, `the close on another market took ${closeTook} ms (it waited for the in-play bet delay)`);
  });
});
