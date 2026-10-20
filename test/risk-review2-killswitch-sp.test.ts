// Regression test from a second independent review (medium): engaging the kill switch "cancels every unmatched bet on the account", but
// guard.cancelAllUnmatched only visits markets with sizeRemaining > 0, and LiveExchange.cancelOrders
// ("ALL") only lists bets with sizeRemaining > 0. A Betfair SP bet waiting for the off has
// sizeRemaining 0 and its liability in bspLiability (the shape the guard itself handles in legOfView,
// riskCheck and cancelRiskAddingUnmatched), so it is silently left in place and matched at the off.
// Betfair's cancelOrders documentation says "Only LIMIT orders can be cancelled or partially cancelled
// once placed", so the switch may not be able to cancel it at all; it must then at least say so, so
// the human cancels it on the website. Today the report says nothing about it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { FakeBetfair, PLACE_MARKET } from "./fakeBetfair.js";

describe("review 2: the kill switch ignores Betfair SP bets", () => {
  test("an SP lay with a 100 liability is neither cancelled nor mentioned in the engage report", async () => {
    const fake = new FakeBetfair();
    // Placed on the website: lay 101 at Betfair SP for a liability of 100 (unmatched until the off).
    fake.liveOrders.push({
      betId: "SP1",
      marketId: PLACE_MARKET,
      selectionId: 101,
      handicap: 0,
      priceSize: { price: 0, size: 0 },
      bspLiability: 100,
      side: "LAY",
      status: "EXECUTABLE",
      persistenceType: "MARKET_ON_CLOSE",
      orderType: "MARKET_ON_CLOSE",
      placedDate: new Date().toISOString(),
      sizeMatched: 0,
      sizeRemaining: 0,
    });
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    const report = await c.engageKillSwitch("stop everything");
    const cancelRequests = fake.calls.filter((call) => call.method === "cancelOrders").length;
    const stillLive = (await c.exchange.currentOrders()).some((o) => o.betId === "SP1" && o.status === "EXECUTABLE");
    const mentioned = report.cancelled.some((r) => r.betId === "SP1") || report.notes.some((n) => n.includes("SP1"));
    assert.ok(
      !stillLive || mentioned,
      `after engage (${cancelRequests} cancel request(s), cancelled ${JSON.stringify(report.cancelled)}) the SP lay (liability 100) still waits for the off, ` +
        `and the report does not mention it: ${JSON.stringify(report.notes)}`,
    );
  });
});
