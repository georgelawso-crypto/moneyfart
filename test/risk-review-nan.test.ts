// Regression test from an independent review (defence in depth): a non-finite price makes the guard's exposure NaN. NaN > x is false,
// so that order and every later order of the same batch count as "not adding risk" and skip every
// check, kill switch included. OrderDesk validates prices today, so no current caller sends NaN,
// but the guard's stated job is to hold whatever reaches it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" };
}

describe("review: NaN in a batch disables the guard for the rest of the batch", () => {
  test("kill switch on, MAX_STAKE 10: a 500 back behind a NaN-priced order reaches Betfair", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(
      loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", MAX_STAKE: "10" }),
      fake,
    );
    c.guard.engageKillSwitch("stop");
    const [nan, big] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", Number.NaN, 5), order(102, "BACK", 5.9, 500)], TAG);
    const sent = fake.calls.filter((call) => call.method === "placeOrders").flatMap((call) => call.args.instructions);
    assert.equal(sent.length, 0, `sent to Betfair with the kill switch on: ${JSON.stringify(sent.map((i: { side: string; limitOrder: unknown }) => [i.side, i.limitOrder]))} (results ${nan.status}/${big.status})`);
  });
});
