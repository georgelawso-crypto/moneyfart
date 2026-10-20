// Regression test from an independent review: the guard judges each order of a batch on its own, so a dutch (which the engine checks
// as all-or-nothing: "every leg must pass the checks; one bad leg places nothing") can be placed in
// part when the headroom runs out mid-batch, leaving an unbalanced position.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

describe("review: a dutch is placed in part when the guard refuses a later leg", () => {
  test("MAX_MARKET_LIABILITY 7 and a 9.99 dutch on three runners: either every leg or none", async () => {
    const config = loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", MAX_MARKET_LIABILITY: "7" });
    const c = new Connector(config, new FakeBetfair());
    const result = await c.executeStrategy("Dutch for 10 Euro", WIN_MARKET, [
      { selectionId: 101, handicap: 0 },
      { selectionId: 102, handicap: 0 },
      { selectionId: 103, handicap: 0 },
    ]);
    const placed = (await c.exchange.currentOrders([WIN_MARKET])).map((o) => `${o.side} ${o.selectionId} ${o.sizeMatched}@${o.averagePriceMatched}`);
    assert.ok(
      placed.length === 0 || placed.length === 3,
      `partial dutch left on the exchange (${result.outcome}): ${placed.join(", ")}; ${result.message}`,
    );
  });

  test("the same with DAILY_LOSS_LIMIT headroom used up during the day", async () => {
    const config = loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DAILY_LOSS_LIMIT: "12" });
    const fake = new FakeBetfair();
    const c = new Connector(config, fake);
    // 5 already at risk on the PLACE market leaves 7 of headroom for the WIN market.
    const [earlier] = await c.exchange.placeOrders("1.200000002", [{ selectionId: 101, handicap: 0, side: "BACK", price: 1.5, size: 5, persistenceType: "LAPSE" }], {
      name: "test",
      ref: "test",
    });
    assert.equal(earlier.status, "SUCCESS");
    const result = await c.executeStrategy("Dutch for 10 Euro", WIN_MARKET, [
      { selectionId: 101, handicap: 0 },
      { selectionId: 102, handicap: 0 },
      { selectionId: 103, handicap: 0 },
    ]);
    const placed = (await c.exchange.currentOrders([WIN_MARKET])).length;
    assert.ok(placed === 0 || placed === 3, `partial dutch: ${placed} of 3 legs placed (${result.outcome}): ${result.message}`);
  });
});
