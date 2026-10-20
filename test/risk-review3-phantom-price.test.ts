// Regression test from a third independent review (low): the closing rule's "help" figure counts an uncertain bet's winnings at its limit
// price (exposure.ts scenarioLosses). For a possibly-placed bet (an UNKNOWN placement) that is not a
// lower bound on the loss: a back sent with a 2.0 limit is matched at the best price on offer, say
// 4.0, and wins twice as much. The rule can then call a request "closing" although, in the state the
// market is really in, it raises the worst case; the kill switch lets it through. (The market's
// "hurt" upper bound does not rise, so no limit is exceeded: the README's promise "whatever the
// market's possibly-placed bets do, the market's worst case can't rise" is what fails.)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BetfairApiError } from "../src/betfair/client.js";
import type { CurrentOrderSummary } from "../src/betfair/types.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { betOutcomeProfit } from "../src/exchange/math.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" };
}

/** Worst-case loss of the matched bets of the single-winner market 101/102/103. */
function worst(orders: CurrentOrderSummary[]): number {
  const outcomes = [101, 102, 103].map((winner) =>
    orders.reduce((t, o) => t + (o.sizeMatched ? betOutcomeProfit(o.side, o.averagePriceMatched!, o.sizeMatched, o.selectionId === winner) : 0), 0),
  );
  return Math.max(0, -Math.min(...outcomes));
}

describe("review 3: a possibly-placed back matched at a better price than its limit", () => {
  test("kill switch on: a 'closing' lay raises the market's worst case from 0 to 9.80", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 5.0, 10)], TAG))[0].sizeMatched, 10);
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(103, "BACK", 3.0, 10)], TAG))[0].sizeMatched, 10);

    // A back of 10 on 102 with a 2.0 limit: Betfair matches it at once at the 4.0 on offer, but the
    // answer times out and the order does not show among the current orders yet.
    const place = fake.placeOrders.bind(fake);
    let hidden: CurrentOrderSummary | undefined;
    fake.placeOrders = async (args) => {
      const instruction = args.instructions[0];
      if (instruction.selectionId !== 102) return place(args);
      fake.calls.push({ method: "placeOrders", args });
      hidden = {
        betId: "SLOW1",
        marketId: args.marketId,
        selectionId: 102,
        handicap: 0,
        priceSize: { price: 2.0, size: 10 },
        side: "BACK",
        status: "EXECUTION_COMPLETE",
        persistenceType: "LAPSE",
        orderType: "LIMIT",
        placedDate: new Date().toISOString(),
        averagePriceMatched: 4.0,
        sizeMatched: 10,
        sizeRemaining: 0,
        customerOrderRef: instruction.customerOrderRef,
      };
      throw new BetfairApiError("Betfair placeOrders failed: timed out", "TIMEOUT");
    };
    const [unknown] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 2.0, 10)], TAG);
    assert.equal(unknown.status, "UNKNOWN");

    await c.engageKillSwitch("no new risk");
    // Long 101 (if win 40, if lose -10): a lay of 14.90 @ 3.0 is on the closing side and not past flat.
    // Fixed: a possibly-placed back's winnings are counted at the best price it could have matched at,
    // so the lay isn't a close the guard can vouch for, and the kill switch refuses it.
    const [lay] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.0, 14.9)], TAG);
    assert.match(lay.errorCode ?? "", /^KILL_SWITCH_ENGAGED: .*it isn't counted as a closing bet: on its own it could raise the market's worst case/);

    fake.liveOrders.push(hidden!); // the back shows up
    const placed = fake.liveOrders.filter((o) => o.selectionId === 101 && o.side === "LAY");
    assert.equal(placed.length, 0, "the lay never reached Betfair");
    assert.ok(worst(fake.liveOrders) <= 1e-9, "the market's worst case is unchanged (0)");
  });
});
