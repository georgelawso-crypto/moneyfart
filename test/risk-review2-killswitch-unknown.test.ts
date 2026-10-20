// Regression test from a second independent review (medium): "bets that land after the kill switch engaged get their unmatched part
// cancelled" (guard.ts cancelLanded) only covers bets reported SUCCESS. A bet sent before the switch
// engaged whose placement times out and is not found by the reconcile comes back UNKNOWN: the guard
// only records it as possibly placed. When Betfair shows it a moment later (resting, unmatched),
// nothing cancels it: engage's cancelAllUnmatched ran before it existed, and the owner's riskCheck
// only stops bots while the switch is on. A kill switch pressed because Betfair is slow is exactly
// when timeouts happen.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BetfairApiError } from "../src/betfair/client.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

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

describe("review 2: an UNKNOWN bet that lands after the kill switch engaged", () => {
  test("rests unmatched with the switch on, and the owner's risk check leaves it there", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    // Betfair is slow: the request hangs, then times out; Betfair processes it a little later.
    let sent!: (instruction: { customerOrderRef: string }) => void;
    const inFlight = new Promise<{ customerOrderRef: string }>((resolve) => (sent = resolve));
    let timeOut!: () => void;
    const timedOut = new Promise<void>((resolve) => (timeOut = resolve));
    fake.placeOrders = async (args) => {
      fake.calls.push({ method: "placeOrders", args });
      sent(args.instructions[0] as { customerOrderRef: string });
      await timedOut;
      throw new BetfairApiError("Betfair placeOrders failed: timed out", "TIMEOUT");
    };

    const placing = c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 2.5, 20)], TAG); // rests below the market
    const instruction = await inFlight; // checked and sent
    const report = await c.engageKillSwitch("Betfair is misbehaving");
    assert.deepEqual(report.cancelled, [], "nothing rests yet");
    timeOut();
    const [bet] = await placing; // the reconcile does not find it (yet)
    assert.equal(bet.status, "UNKNOWN");

    // Betfair shows the bet now: a lay of 20 @ 2.5 (liability 30), unmatched.
    fake.liveOrders.push({
      betId: "LATE1",
      marketId: WIN_MARKET,
      selectionId: 101,
      handicap: 0,
      priceSize: { price: 2.5, size: 20 },
      side: "LAY",
      status: "EXECUTABLE",
      persistenceType: "LAPSE",
      orderType: "LIMIT",
      placedDate: new Date().toISOString(),
      sizeMatched: 0,
      sizeRemaining: 20,
      customerOrderRef: instruction.customerOrderRef,
    });
    await quietly(() => c.riskCheck()); // the owner's 30-second check
    await quietly(() => c.riskCheck());

    const resting = (await c.exchange.currentOrders()).filter((o) => o.sizeRemaining > 0);
    assert.equal(
      resting.length,
      0,
      `kill switch engaged at ${report.killSwitch.engagedAt}; ${resting.map((o) => `${o.side} ${o.sizeRemaining} @ ${o.price} (${o.betId})`).join(", ")} still rests, and nothing will cancel it`,
    );
  });
});
