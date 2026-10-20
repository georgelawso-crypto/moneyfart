// Regression test from a second independent review: bots treat every guard refusal of a closing bet as "wait and retry" (bots.ts
// closeStep, guardRefusal), including refusals that never clear.
//  1. (medium) On an Australian account a sport market that goes in-play refuses every bet, closing
//     bets included: the bot retries every tick until the market closes, then reports "Market closed;
//     bot finished." with status finished, so get_bots shows a normal finish although the position was
//     never closed (failures are reset every tick, so it never reaches "failed").
//  2. (low) guardRefusal() parses the errorCode prefix, and Betfair's own ExecutionReportErrorCode
//     INVALID_ORDER is also a GUARD_CODES entry: an exchange rejection is retried forever as a guard refusal.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };
const sel101 = [{ selectionId: 101, handicap: 0 }];

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe("review 2: guardRefusal matches Betfair's own INVALID_ORDER execution-report code", () => {
  test("a closing bet Betfair rejects with INVALID_ORDER is retried every tick instead of failing the bot", async () => {
    // guardRefusal() reads the errorCode prefix; LiveExchange reports a whole-request failure without
    // instruction reports as the execution report's code, and Betfair's ExecutionReportErrorCode has
    // INVALID_ORDER, which is also one of GUARD_CODES.
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [{ selectionId: 101, handicap: 0, side: "BACK", price: 3.0, size: 10, persistenceType: "LAPSE" }], TAG))[0].sizeMatched, 10);
    const started = await c.executeStrategy("Close Selection Bet Position", WIN_MARKET, sel101, { Loss: 2 });
    assert.equal(started.outcome, "Started", JSON.stringify(started));
    fake.placeOrders = async (args) => {
      fake.calls.push({ method: "placeOrders", args });
      return { status: "FAILURE", errorCode: "INVALID_ORDER", marketId: args.marketId, instructionReports: [] };
    };
    fake.setOffers(101, [[3.3, 100]], [[3.35, 100]]); // the 2-tick stop-loss is reached
    for (let i = 0; i < 8; i++) await quietly(() => c.bots.tick());
    const [bot] = c.bots.list();
    const attempts = fake.calls.filter((call) => call.method === "placeOrders").length - 1;
    assert.notEqual(
      bot.status,
      "running",
      `Betfair rejected ${attempts} closing bets with INVALID_ORDER; the bot reads them as risk-guard refusals and keeps retrying: "${bot.log.map((l) => l.message).filter((m) => /refused/.test(m))[0]}"`,
    );
  });
});

describe("review 2: a close refused for good is reported as a normal finish", () => {
  test("AU account, soccer in-play: the bot never closes, never fails, and ends 'finished'", async () => {
    const fake = new FakeBetfair();
    fake.catalogues.get(WIN_MARKET)!.eventType = { id: "1", name: "Soccer" };
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "au", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [{ selectionId: 101, handicap: 0, side: "BACK", price: 3.0, size: 10, persistenceType: "LAPSE" }], TAG))[0].sizeMatched, 10);
    // A bot that closes the position on a 2-tick loss.
    const started = await c.executeStrategy("Close Selection Bet Position", WIN_MARKET, sel101, { Loss: 2 });
    assert.equal(started.outcome, "Started", JSON.stringify(started));

    // Kick-off, and 101 drifts: the stop-loss is reached, but every bet on in-play sport is refused.
    fake.book().inplay = true;
    fake.setOffers(101, [[3.3, 100]], [[3.35, 100]]);
    for (let i = 0; i < 8; i++) await quietly(() => c.bots.tick());
    // Fixed: a refusal that can't clear while the market lasts ends the bot at once, saying why.
    const [early] = c.bots.list();
    assert.equal(early.status, "failed");
    assert.match(early.log[early.log.length - 1].message, /refused \(IN_PLAY_SPORT_NOT_ALLOWED: .*\); the bot can't close the position, which stays open/);

    // Full time: the market closes with the back lost.
    fake.settle([102]);
    await quietly(() => c.bots.tick());
    const [bot] = c.bots.list();
    const last = bot.log[bot.log.length - 1].message;
    assert.equal(
      bot.status,
      "failed",
      `the position was never closed (every closing bet refused: IN_PLAY_SPORT_NOT_ALLOWED), yet the bot ended "${bot.status}": "${last}"`,
    );
  });
});
