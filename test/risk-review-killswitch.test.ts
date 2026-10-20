// Regression test from an independent review: kill switch robustness.
//  1. Engaging fails open when DATA_DIR/kill-switch.json cannot be written (disk full, read-only
//     remount): engageKillSwitch throws before stopping bots or cancelling anything, and nothing is
//     blocked, although none of that needs the disk.
//  2. A placement already past the guard's checks when the switch is engaged lands after the
//     "cancel every unmatched bet" pass, so engage reports success while a new unmatched risk-adding
//     bet rests on the exchange.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };
const sel101 = [{ selectionId: 101, handicap: 0 }];
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bat-review-ks-"));

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" };
}

describe("review: kill switch robustness", () => {
  test("disk full: engaging throws and nothing is stopped, cancelled or blocked", async () => {
    const dir = tmpDir();
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir }), fake);
    const started = await c.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101, { PlaceBetTimeSpan: "-0:25:00" });
    assert.equal(started.outcome, "Started");
    const [resting] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 2.5, 5)], TAG);
    assert.equal(resting.orderStatus, "EXECUTABLE");

    const writeFileSync = fs.writeFileSync;
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes("kill-switch.json")) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      return (writeFileSync as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync;
    let error: Error | undefined;
    try {
      await c.engageKillSwitch("losing too fast");
    } catch (e) {
      error = e as Error;
    } finally {
      (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = writeFileSync;
    }

    const running = c.bots.list({ status: "running" }).length;
    const unmatched = (await c.exchange.currentOrders([WIN_MARKET])).filter((o) => o.sizeRemaining > 0).length;
    const [after] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 10)], TAG);
    c.shutdown();
    assert.ok(
      running === 0 && unmatched === 0 && after.status === "FAILURE",
      `engage ${error ? `threw "${error.message}"` : "returned"}; afterwards ${running} bot(s) running, ${unmatched} unmatched bet(s), new back ${after.status}`,
    );
  });

  test("one market's cancel error leaves every other market's unmatched bets resting", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    const [win] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 2.5, 5)], TAG);
    const [place] = await c.exchange.placeOrders("1.200000002", [order(102, "BACK", 3.0, 5)], TAG);
    assert.equal(win.orderStatus, "EXECUTABLE");
    assert.equal(place.orderStatus, "EXECUTABLE");
    const inner = c.guard.inner;
    const cancel = inner.cancelOrders.bind(inner);
    inner.cancelOrders = async (marketId, betIds) => {
      if (marketId === WIN_MARKET) throw new Error("Betfair cancelOrders failed: timed out");
      return cancel(marketId, betIds);
    };
    const report = await c.engageKillSwitch("stop");
    const resting = (await c.exchange.currentOrders()).filter((o) => o.sizeRemaining > 0).map((o) => `${o.marketId} ${o.betId}`);
    assert.deepEqual(resting, [`${WIN_MARKET} ${win.betId}`], `only the failing market should keep its bet; still resting: ${resting.join(", ")}; notes: ${report.notes.join(" ")}`);
  });

  test("a bet in flight when the switch is engaged rests after engage reported every unmatched bet cancelled", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    // Betfair holds the request (in-play bet delay, slow network) and the bet does not match.
    const original = fake.placeOrders.bind(fake);
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fake.placeOrders = async (args) => {
      entered();
      await held;
      const report = await original(args);
      for (const o of fake.liveOrders.slice(-args.instructions.length)) {
        o.status = "EXECUTABLE";
        o.sizeMatched = 0;
        o.averagePriceMatched = 0;
        o.sizeRemaining = o.priceSize!.size;
      }
      report.instructionReports = report.instructionReports!.map((r) => ({ ...r, orderStatus: "EXECUTABLE" as const, sizeMatched: 0, averagePriceMatched: 0 }));
      return report;
    };

    const placing = c.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101, { Odds: 3.2 }); // the agent's bet
    await inFlight; // the guard has checked it and sent it
    const report = await c.engageKillSwitch("the human pressed stop");
    assert.deepEqual(report.cancelled, [], "nothing was resting yet");
    release();
    const result = await placing;

    const resting = (await c.exchange.currentOrders()).filter((o) => o.sizeRemaining > 0);
    assert.equal(
      resting.length,
      0,
      `after the kill switch was engaged and reported every unmatched bet cancelled, ${resting.map((o) => `${o.side} ${o.size} @ ${o.price}`).join(", ")} rests (strategy outcome ${result.outcome})`,
    );
  });
});
