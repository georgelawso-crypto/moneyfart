// Regression test from a second independent review (critical): the closing rule only compares "nothing matched" with "every bet of the
// request matched" (guard.ts closes()). Bets match independently, so a request whose legs only
// close together can leave the account with more risk than before when some of them don't match.
//
//  1. One selection, two legs: an over-hedging LAY priced so it can't match (1.5 against a 3.05 lay
//     offer) flips the position "as matched", which makes a BACK the closing side for the second leg.
//     The BACK matches, the LAY rests and is cancelled: the position grows about fourfold per
//     request, kill switch on and MAX_STAKE 10, without limit.
//  2. MCP path, no bad intent: with the kill switch on, Close Market Bet Position on lays on two
//     runners (each hedge alone raises the worst case, both together lower it) where one hedge only
//     finds part of its liquidity leaves the market worst case higher than before.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { betOutcomeProfit } from "../src/exchange/math.js";
import type { OrderRequest, OrderView } from "../src/exchange/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number, extra: Partial<OrderRequest> = {}): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE", ...extra };
}

/** Worst case of the matched bets of a single-winner market of 101/102/103. */
function matchedWorstCase(orders: OrderView[]): number {
  const outcomes = [101, 102, 103].map((winner) =>
    orders.reduce((t, o) => t + (o.sizeMatched ? betOutcomeProfit(o.side, o.averagePriceMatched!, o.sizeMatched, Number(o.selectionId) === winner) : 0), 0),
  );
  return Math.max(0, -Math.min(...outcomes));
}

describe("review 2: closing requests that only close if every leg matches", () => {
  test("kill switch on, MAX_STAKE 10: an unmatchable over-hedge plus a matched back ratchets a 10 back up", async () => {
    const fake = new FakeBetfair();
    // Paper matching: backs at 3.0 match; a lay at 1.5 rests (the best price to lay is 3.05).
    fake.setOffers(101, [[3.0, 100000]], [[3.05, 100000]]);
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", MAX_STAKE: "10", PAPER_STARTING_BALANCE: "100000" }), fake);

    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG))[0].sizeMatched, 10);
    c.guard.engageKillSwitch("no new risk");
    const worst = [matchedWorstCase(await c.exchange.currentOrders([WIN_MARKET]))];
    for (let round = 0; round < 2; round++) {
      // Long S on 101 (ifWin 2S, ifLose -S): LAY 4S @ 1.5 as matched gives (0, 3S), so BACK is the closing
      // side and BACK 3S - 1 @ 3.0 keeps that worst case; together they look like a close.
      const stake = worst[worst.length - 1];
      const [lay, back] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 1.5, 4 * stake), order(101, "BACK", 3.0, 3 * stake - 1)], TAG);
      // Fixed: bets on both sides of a selection are never a close, so the kill switch refuses the request.
      for (const bet of [lay, back]) assert.match(bet.errorCode ?? "", /^KILL_SWITCH_ENGAGED/, `round ${round}`);
      worst.push(matchedWorstCase(await c.exchange.currentOrders([WIN_MARKET])));
    }
    assert.ok(
      worst[worst.length - 1] <= worst[0] + 1e-9,
      `with the kill switch on and MAX_STAKE 10, two "closing" requests took the worst case ${worst.map((w) => w.toFixed(2)).join(" -> ")}`,
    );
  });

  test("kill switch on: Close Market Bet Position with thin liquidity on one hedge raises the worst case", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    // Lay 101 10 @ 3.05 and lay 102 5 @ 6.2: worst case 16 (102 wins).
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 10)], TAG))[0].sizeMatched, 10);
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(102, "LAY", 6.2, 5)], TAG))[0].sizeMatched, 5);
    const before = matchedWorstCase(await c.exchange.currentOrders([WIN_MARKET]));
    assert.equal(before, 16);

    await c.engageKillSwitch("something looks wrong");
    fake.setOffers(102, [[5.9, 1]], [[6.2, 80]]); // only 1 on offer at 102's best back price
    const result = await c.executeStrategy("Close Market Bet Position", WIN_MARKET, []);
    const after = matchedWorstCase(await c.exchange.currentOrders([WIN_MARKET]));
    assert.ok(
      after <= before + 1e-9,
      `kill switch on: the close (${result.bets.map((b) => `${b.side} ${b.selectionId} ${b.size} @ ${b.price} matched ${b.sizeMatched}`).join(", ")}) took the worst case from ${before} to ${after.toFixed(2)}`,
    );
  });
});
