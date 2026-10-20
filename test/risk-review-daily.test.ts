// Regression test from an independent review: DAILY_LOSS_LIMIT accounting.
//  1. accountRisk reads the account exposure and today's cleared orders in parallel: a market that
//     settles between the two reads is in neither (no longer open, not yet settled).
//  2. A failed commission lookup (LiveExchange logs it and returns commission undefined) is read as
//     zero commission, understating today's net loss.
//  3. startOfDay drops the first hour of a day whose clocks go back at 01:00 to 00:00 (America/Havana).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BetfairApiError } from "../src/betfair/client.js";
import type { ClearedOrderSummary } from "../src/betfair/types.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { startOfDay } from "../src/exchange/guard.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" };
}

function live(env: Record<string, string>, fake = new FakeBetfair()) {
  const config = loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...env });
  return { fake, c: new Connector(config, fake) };
}

/** Account exposure of the fake's open orders: every matched back loses its stake (enough for these tests). */
const openBacks = (fake: FakeBetfair) => fake.liveOrders.filter((o) => o.side === "BACK").reduce((t, o) => t + (o.sizeMatched ?? 0), 0);

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe("review: daily loss accounting", () => {
  test("a market settling between the funds read and the cleared-orders read is counted nowhere", async () => {
    const { c, fake } = live({ DAILY_LOSS_LIMIT: "30" });
    fake.getAccountFunds = async () => ({ ...fake.funds, exposure: -openBacks(fake) });
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].status, "SUCCESS");

    // Betfair settles the WIN market (the back loses 20) after answering listClearedOrders and before
    // answering getAccountFunds; the guard sends both requests at once.
    fake.getAccountFunds = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const settled = fake.liveOrders.filter((o) => o.marketId === WIN_MARKET);
      fake.liveOrders = fake.liveOrders.filter((o) => o.marketId !== WIN_MARKET);
      for (const o of settled) {
        fake.cleared.push({ betId: o.betId, marketId: o.marketId, selectionId: o.selectionId, side: o.side, profit: -(o.sizeMatched ?? 0), settledDate: new Date().toISOString() });
      }
      return { ...fake.funds, exposure: -openBacks(fake) };
    };
    const [bet] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 25)], TAG);
    assert.equal(bet.status, "FAILURE", "settled loss 20 + open worst case 25 = 45 > DAILY_LOSS_LIMIT 30, yet the bet was placed");
  });

  test("a failed commission lookup is read as no commission", async () => {
    const fake = new FakeBetfair();
    const now = new Date().toISOString();
    const rows: ClearedOrderSummary[] = [
      { betId: "A1", marketId: "1.300000001", selectionId: 1, side: "BACK", profit: 100, commission: 5, settledDate: now },
      { betId: "B1", marketId: "1.300000002", selectionId: 2, side: "BACK", profit: -105, commission: 0, settledDate: now },
    ];
    fake.cleared = rows;
    const original = fake.listClearedOrders.bind(fake);
    fake.listClearedOrders = async (args) => {
      if (args.groupBy === "MARKET") throw new BetfairApiError("Betfair listClearedOrders failed: TOO_MUCH_DATA", "TOO_MUCH_DATA");
      return original(args);
    };
    const { c } = live({ DAILY_LOSS_LIMIT: "10" }, fake);
    // Net today: +100 - 5 commission - 105 = -10, which reaches the limit.
    const hit = await quietly(() => c.guard.dailyLimitHit());
    assert.equal(hit, true, "today's net loss is 10 (after 5 commission), the limit is 10");
  });

  test("startOfDay in a zone whose clocks go back from 01:00 to 00:00 starts the day an hour late", () => {
    // Cuba, Sunday 1 Nov 2026: 00:00 CDT (04:00Z) ... 00:59 CDT, then 00:00 CST (05:00Z) again.
    const start = startOfDay(Date.parse("2026-11-01T12:00:00Z"), "America/Havana");
    assert.equal(new Date(start).toISOString(), "2026-11-01T04:00:00.000Z");
  });
});
