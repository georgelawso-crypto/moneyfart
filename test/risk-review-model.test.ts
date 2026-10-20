// Regression test from an independent review: gaps in the guard's exposure model.
//  1. Multi-winner (PLACE) and handicap markets are modelled selection by selection. That figure
//     never understates the true worst case, but a bet can raise the true worst case without
//     raising it, so under the kill switch ("no new risk") real new risk is still accepted.
//  2. Betfair SP bets (bspLiability) are dropped by LiveExchange.orderView, so an SP lay placed on
//     the website does not count toward MAX_MARKET_LIABILITY.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { betOutcomeProfit } from "../src/exchange/math.js";
import type { OrderRequest, OrderView } from "../src/exchange/types.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number, extra: Partial<OrderRequest> = {}): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE", ...extra };
}

function connector(env: Record<string, string> = {}, fake = new FakeBetfair()) {
  const config = loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...env });
  return { fake, c: new Connector(config, fake) };
}

/** True worst case of matched bets in a 2-place market of 101/102/103 (every pair of placed runners). */
function placeWorstCase(orders: OrderView[]): number {
  const outcomes = [
    [101, 102],
    [101, 103],
    [102, 103],
  ];
  const profits = outcomes.map((placed) =>
    orders.reduce((t, o) => t + (o.sizeMatched ? betOutcomeProfit(o.side, o.averagePriceMatched!, o.sizeMatched, placed.includes(Number(o.selectionId))) : 0), 0),
  );
  return Math.max(0, -Math.min(...profits));
}

describe("review: exposure model gaps", () => {
  test("kill switch on: a lay in a PLACE market doubles the true worst case", async () => {
    const { c, fake } = connector();
    // 101 back 10 @ 1.5 (+5 / -10); 102 traded to a green +5 / +5 (back 10 @ 3.0, lay 15 @ 2.0).
    assert.equal((await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 10)], TAG))[0].sizeMatched, 10);
    fake.setOffers(102, [[3.0, 100]], [[3.05, 80]], PLACE_MARKET);
    assert.equal((await c.exchange.placeOrders(PLACE_MARKET, [order(102, "BACK", 3.0, 10)], TAG))[0].sizeMatched, 10);
    fake.setOffers(102, [[1.98, 100]], [[2.0, 80]], PLACE_MARKET);
    assert.equal((await c.exchange.placeOrders(PLACE_MARKET, [order(102, "LAY", 2.0, 15)], TAG))[0].sizeMatched, 15);
    const before = placeWorstCase(await c.exchange.currentOrders([PLACE_MARKET]));
    assert.equal(before, 5);

    c.guard.engageKillSwitch("no new risk");
    const [lay] = await c.exchange.placeOrders(PLACE_MARKET, [order(102, "LAY", 2.0, 5)], TAG);
    const after = placeWorstCase(await c.exchange.currentOrders([PLACE_MARKET]));
    assert.ok(after <= before + 1e-9, `with the kill switch on the worst case went from ${before} to ${after} (lay ${lay.status})`);
  });

  test("an SP lay on the account is invisible to MAX_MARKET_LIABILITY", async () => {
    const fake = new FakeBetfair();
    // Placed on the website: lay 101 at Betfair SP for a liability of 100 (unmatched until the off).
    fake.liveOrders.push({
      betId: "SP1",
      marketId: WIN_MARKET,
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
    const { c } = connector({ TRADING_MODE: "live", MAX_MARKET_LIABILITY: "50" }, fake);
    const [lay] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 20)], TAG);
    assert.equal(lay.status, "FAILURE", "the market already carries a 100 SP liability on 101 (MAX_MARKET_LIABILITY 50), yet a 41 lay on 101 was placed");
  });
});
