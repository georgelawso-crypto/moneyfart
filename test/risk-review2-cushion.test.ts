// Regression test from a second independent review (critical): the closing rule compares the market's worst case with MATCHED bets only
// (guard.ts closes(): worstLoss(matched, ..., "ignore")). Unmatched bets on other selections, and
// possibly-placed UNKNOWN ones, are left out, although MAX_MARKET_LIABILITY counted them "where they
// hurt" when they were accepted. A matched bet that covers them (a cushion) can then be closed as a
// "closing" bet, skipping every check, and the resting bets it covered are left naked.
//
// Reachable from the MCP tools: lay the favourite (Lay 10 Euro, Stake override), rest lays on another
// runner below the market (Lay 10 Euro, Stake + Odds overrides: each accepted only because the
// favourite's lay pays out when that runner wins), then Close Selection Bet Position on the favourite.
// A Lay Trade bot greening up the favourite does the same with no adversarial intent.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { betOutcomeProfit } from "../src/exchange/math.js";
import type { OrderView } from "../src/exchange/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

// MAX_TOTAL_EXPOSURE / DAILY_LOSS_LIMIT 120: the third resting lay is charged 60 (what it can add if the
// other two match, whatever else happens) on top of the 55 open, so 100 would refuse the setup itself.
const LIMITS = { MAX_STAKE: "25", MAX_LIABILITY: "250", MAX_MARKET_LIABILITY: "60", MAX_TOTAL_EXPOSURE: "120", DAILY_LOSS_LIMIT: "120" };
const sel = (selectionId: number) => [{ selectionId, handicap: 0 }];

/** True worst case of a single-winner market of 101/102/103: matched bets, unmatched ones only where they lose. */
function worstCase(orders: OrderView[]): number {
  const outcomes = [101, 102, 103].map((winner) =>
    orders.reduce((total, o) => {
      const wins = Number(o.selectionId) === winner;
      const matched = o.sizeMatched ? betOutcomeProfit(o.side, o.averagePriceMatched!, o.sizeMatched, wins) : 0;
      const resting = o.sizeRemaining ? Math.min(0, betOutcomeProfit(o.side, o.price, o.sizeRemaining, wins)) : 0;
      return total + matched + resting;
    }, 0),
  );
  return Math.max(0, -Math.min(...outcomes));
}

async function cushioned(env: Record<string, string> = {}) {
  const fake = new FakeBetfair();
  fake.setOffers(101, [[1.1, 2000]], [[1.11, 2000]]); // 101 is a 1.1 favourite
  const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...LIMITS, ...env }), fake);
  // Lay 101 500 @ 1.11: liability 55, and +500 whenever 101 loses.
  const cushion = await c.executeStrategy("Lay 10 Euro", WIN_MARKET, sel(101), { Stake: 500 });
  assert.equal(cushion.bets[0]?.sizeMatched, 500, JSON.stringify(cushion));
  // Three lays on 102 at 5.0 rest below the market (liabilities 200 + 200 + 160 = 560). Each is
  // accepted because, when 102 wins, 101 loses and the lay on 101 pays 500: market worst case 60.
  for (const stake of [50, 50, 40]) {
    const lay = await c.executeStrategy("Lay 10 Euro", WIN_MARKET, sel(102), { Stake: stake, Odds: 5.0 });
    assert.equal(lay.bets[0]?.orderStatus, "EXECUTABLE", JSON.stringify(lay));
  }
  return { c, fake };
}

describe("review 2: a 'closing' bet that removes a cushion skips every limit", () => {
  test("Close Selection Bet Position on the favourite leaves 560 of resting lays naked (MAX_MARKET_LIABILITY 60, DAILY_LOSS_LIMIT 100)", async () => {
    const { c, fake } = await cushioned();
    const before = worstCase(await c.exchange.currentOrders([WIN_MARKET]));
    assert.ok(before <= 60 + 1e-9, `setup: worst case ${before}`);

    // Green up the favourite: BACK 504.55 @ 1.1. It reduces 101's own position and, matched bets only,
    // the market's worst case (55 -> 4.55), so it is "closing" and skips every check.
    const close = await c.executeStrategy("Close Selection Bet Position", WIN_MARKET, sel(101));
    const after = worstCase(await c.exchange.currentOrders([WIN_MARKET]));

    // The lays on 102 get matched and 102 wins.
    fake.setOffers(102, [[4.9, 1000]], [[5.0, 1000]]);
    await c.exchange.currentOrders([WIN_MARKET]);
    fake.settle([102]);
    const status = await c.guard.riskStatus();
    assert.ok(
      -(status.settledToday ?? 0) <= 120 + 1e-9,
      `the close (${close.bets.map((b) => `${b.side} ${b.size} @ ${b.price} ${b.status}`).join(", ")}) took the market's worst case from ` +
        `${before.toFixed(2)} to ${after.toFixed(2)} (MAX_MARKET_LIABILITY 60, MAX_TOTAL_EXPOSURE 120); settled loss today ${(-(status.settledToday ?? 0)).toFixed(2)} > DAILY_LOSS_LIMIT 120`,
    );
  });

  test("kill switch on: a resting SP lay on the same selection is not counted, so the 'close' over-hedges once SP matches", async () => {
    // closes() counts resting bets on the closing side as matched only when they have a price and a
    // remainder: an SP bet (price 0, sizeRemaining 0, bspLiability) is skipped.
    const fake = new FakeBetfair();
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
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    const tag = { name: "t", ref: "t" };
    // Back 101 10 @ 3.0 (placed before the switch): +20 if 101 wins; with the SP lay matched, -80.
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [{ selectionId: 101, handicap: 0, side: "BACK", price: 3.0, size: 10, persistenceType: "LAPSE" }], tag))[0].sizeMatched, 10);
    c.guard.engageKillSwitch("no new risk");
    const [lay] = await c.exchange.placeOrders(WIN_MARKET, [{ selectionId: 101, handicap: 0, side: "LAY", price: 3.05, size: 9.84, persistenceType: "LAPSE" }], tag);
    // If 101 wins: before the lay 20 - 100 (SP lay) = -80; after it -100.17.
    assert.notEqual(lay.status, "SUCCESS", "kill switch on: a lay that takes the loss if 101 wins from 80 to 100.17 (once the SP lay matches) was placed as a 'close'");
  });

  test("the same close goes through with the kill switch on (engaged keeping unmatched bets)", async () => {
    const { c } = await cushioned();
    const before = worstCase(await c.exchange.currentOrders([WIN_MARKET]));
    await c.engageKillSwitch("stop adding risk", { cancelUnmatched: false });
    const close = await c.executeStrategy("Close Selection Bet Position", WIN_MARKET, sel(101));
    const after = worstCase(await c.exchange.currentOrders([WIN_MARKET]));
    assert.ok(
      after <= before + 1e-9,
      `kill switch on ("no new risk"), yet ${close.bets.map((b) => `${b.side} ${b.size} @ ${b.price} ${b.status}`).join(", ")} took the market's worst case from ${before.toFixed(2)} to ${after.toFixed(2)}`,
    );
  });
});
