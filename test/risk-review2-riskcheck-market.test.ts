// Regression test from a second independent review (medium): once today's settled loss reaches DAILY_LOSS_LIMIT, Connector.riskCheck ->
// guard.cancelRiskAddingUnmatched keeps every resting bet that reduces its OWN selection's position
// (guard.ts cancelRiskAddingUnmatched). It never looks at the market, unlike the guard's closing
// rule: a resting green-up of one of two covering lays is kept, although the guard itself would now
// refuse it (it raises the market's worst case, and the daily limit is reached). If it matches and
// the other runner wins, the day's loss goes past the limit.
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

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" };
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

describe("review 2: the daily-limit clean-up ignores the market", () => {
  test("a resting back that greens up one of two covering lays survives the clean-up, then takes the day past DAILY_LOSS_LIMIT", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bat-review2-rc-"));
    const fake = new FakeBetfair();
    const env = { BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir };
    const first = new Connector(loadConfig({ ...env, DAILY_LOSS_LIMIT: "100" }), fake);
    // Lay 101 10 @ 3.05 and lay 102 5 @ 6.2: worst case 16 (102 wins).
    assert.equal((await first.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 10)], TAG))[0].sizeMatched, 10);
    assert.equal((await first.exchange.placeOrders(WIN_MARKET, [order(102, "LAY", 6.2, 5)], TAG))[0].sizeMatched, 5);
    // A resting back on 101 above the market (it greens 101 up if matched; the market's worst case would be 26.17).
    const [greenUp] = await first.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.5, 8.71)], TAG);
    assert.equal(greenUp.orderStatus, "EXECUTABLE", JSON.stringify(greenUp));
    // 20 lost on the PLACE market today: with DAILY_LOSS_LIMIT 20 (after a restart) the limit is reached.
    assert.equal((await first.exchange.placeOrders(PLACE_MARKET, [order(103, "BACK", 1.89, 20)], TAG))[0].sizeMatched, 20);
    fake.settle([101, 102], PLACE_MARKET);
    await first.exchange.accountFunds();
    first.shutdown();

    const second = new Connector(loadConfig({ ...env, DAILY_LOSS_LIMIT: "20" }), fake);
    assert.equal(await second.guard.dailyLimitHit(), true);
    // The guard refuses this very bet now: it is not a close (the market's worst case rises) and the daily limit is reached.
    const [again] = await second.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.5, 8.71)], TAG);
    assert.match(again.errorCode ?? "", /^DAILY_LOSS_LIMIT/);
    await quietly(() => second.riskCheck());
    const resting = (await second.exchange.currentOrders([WIN_MARKET])).filter((o) => o.sizeRemaining > 0).map((o) => `${o.side} ${o.selectionId} ${o.sizeRemaining} @ ${o.price}`);

    // The back matches (101 drifts to 3.5) and 102 wins.
    fake.setOffers(101, [[3.5, 100]], [[3.55, 100]]);
    await second.exchange.currentOrders([WIN_MARKET]);
    fake.settle([102]);
    const loss = -((await second.guard.riskStatus()).settledToday ?? 0);
    second.shutdown();
    assert.ok(
      loss <= 20 + 16 + 1e-9,
      `the clean-up kept ${resting.join(", ") || "nothing"}; after it matched and 102 won the day's loss is ${loss.toFixed(2)} ` +
        `(20 settled before + the 16 worst case open when the limit was reached = 36)`,
    );
  });
});
