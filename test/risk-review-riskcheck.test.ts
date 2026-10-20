// Regression test from an independent review: Connector.riskCheck's daily-limit clean-up.
//  1. It marks the day as handled before cancelling, so one failed cancel means the risk-adding
//     unmatched bets are never cancelled that day.
//  2. cancelRiskAddingUnmatched judges every unmatched bet alone, on its own selection, so two
//     resting lays that together over-hedge a position are both kept as "closing".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bat-review-rc-"));

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number, extra: Partial<OrderRequest> = {}): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE", ...extra };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe("review: daily-limit clean-up in riskCheck", () => {
  test("a cancel that fails once is never retried that day", async () => {
    const dir = tmpDir();
    const fake = new FakeBetfair();
    const env = { BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir };
    const first = new Connector(loadConfig({ ...env, DAILY_LOSS_LIMIT: "100" }), fake);
    const [entry] = await first.exchange.placeOrders(PLACE_MARKET, [order(102, "BACK", 3.0, 5)], TAG); // rests: adds risk if matched
    assert.equal(entry.orderStatus, "EXECUTABLE");
    assert.equal((await first.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].status, "SUCCESS");
    fake.settle([102]);
    await first.exchange.accountFunds(); // settles the WIN market: -20 today
    first.shutdown();

    const second = new Connector(loadConfig({ ...env, DAILY_LOSS_LIMIT: "20" }), fake);
    const inner = second.guard.inner;
    const cancel = inner.cancelOrders.bind(inner);
    let failures = 1;
    inner.cancelOrders = async (marketId, betIds) => {
      if (failures-- > 0) throw new Error("Betfair cancelOrders failed: timed out");
      return cancel(marketId, betIds);
    };
    await quietly(() => second.riskCheck()); // the cancel fails
    await quietly(() => second.riskCheck()); // 30 s later: should try again
    await quietly(() => second.riskCheck());
    const resting = (await second.exchange.currentOrders([PLACE_MARKET])).filter((o) => o.sizeRemaining > 0).map((o) => o.betId);
    second.shutdown();
    assert.deepEqual(resting, [], `the risk-adding entry ${entry.betId} is still resting after the daily limit was hit`);
  });

  test("two resting lays that together over-hedge a back are both kept", async () => {
    const dir = tmpDir();
    const fake = new FakeBetfair();
    const env = { BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir };
    const first = new Connector(loadConfig({ ...env, DAILY_LOSS_LIMIT: "100" }), fake);
    // Back 101 20 @ 3.0: +40 if 101 wins, -20 otherwise.
    assert.equal((await first.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].sizeMatched, 20);
    // Two resting lays of 30 @ 2.5 (liability 45 each). Either alone is a partial close; both matched
    // would leave -50 if 101 wins.
    const [lay1] = await first.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 2.5, 30)], TAG);
    const [lay2] = await first.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 2.5, 30)], TAG);
    assert.equal(lay1.orderStatus, "EXECUTABLE");
    assert.equal(lay2.orderStatus, "EXECUTABLE", JSON.stringify(lay2));
    // 20 lost on the PLACE market today.
    assert.equal((await first.exchange.placeOrders(PLACE_MARKET, [order(103, "BACK", 1.89, 20)], TAG))[0].sizeMatched, 20);
    fake.settle([101, 102], PLACE_MARKET);
    await first.exchange.accountFunds();
    first.shutdown();

    const second = new Connector(loadConfig({ ...env, DAILY_LOSS_LIMIT: "20" }), fake);
    assert.equal(await second.guard.dailyLimitHit(), true);
    await quietly(() => second.riskCheck());
    const resting = (await second.exchange.currentOrders([WIN_MARKET])).filter((o) => o.sizeRemaining > 0).map((o) => o.betId);
    second.shutdown();
    assert.ok(
      resting.length < 2,
      `after the daily limit was hit both lays (${resting.join(", ")}) still rest: matched together they raise the market's worst case from 20 to 50`,
    );
  });
});
