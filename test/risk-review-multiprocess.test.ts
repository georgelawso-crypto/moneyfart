// Regression test from an independent review: placements are serialised per GuardedExchange instance only. Two connector processes on
// the same Betfair account (the documented DATA_DIR owner + read-only process setup) check their
// headroom concurrently and can both use it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { State } from "../src/state.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" };
}

async function quietly<T>(fn: () => T): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe("review: headroom is shared across processes", () => {
  test("an owner and a read-only process on one account both use the same MAX_MARKET_LIABILITY headroom", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bat-review-mp-"));
    const env = {
      BETFAIR_JURISDICTION: "com",
      TRADING_MODE: "live",
      RECORD_INTERVAL_SECONDS: "0",
      BOT_INTERVAL_SECONDS: "0",
      DATA_DIR: dir,
      MAX_MARKET_LIABILITY: "30",
    };
    const account = new FakeBetfair(); // one Betfair account
    const owner = new Connector(loadConfig(env), account, State.forDataDir(dir));
    const reader = await quietly(() => new Connector(loadConfig(env), account, State.forDataDir(dir)));
    assert.equal(reader.state.readOnly, true, "second process sharing DATA_DIR");

    const [a, b] = await Promise.all([
      owner.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG),
      reader.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 20)], TAG),
    ]);
    const placed = [a[0], b[0]].filter((bet) => bet.status === "SUCCESS").length;
    const atRisk = account.liveOrders.reduce((total, o) => total + (o.sizeMatched ?? 0), 0);
    owner.shutdown();
    reader.shutdown();
    assert.equal(placed, 1, `both bets were placed: the market's worst case is ${atRisk} (two backs lose together), above MAX_MARKET_LIABILITY 30`);
  });
});
