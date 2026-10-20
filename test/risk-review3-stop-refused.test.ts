// Regression test from a third independent review (low): stop_bot with closePosition marks the bot stopped, then makes one closing attempt
// (bots.ts closeNow -> closeStep). When the risk guard refuses that close, closeStep's message is
// "...refused by the risk guard; trying again on the next tick", and stop() passes it on in its
// error. The bot is stopped, so nothing tries again: the caller is told the position is being
// handled while it is left open and unmanaged.
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

describe("review 3: stop_bot closePosition with a refused close", () => {
  test("the error says the bot will try again, but it is stopped", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", MAX_MARKET_LIABILITY: "21" }), fake);
    const started = await c.executeStrategy("Lay Trade", WIN_MARKET, [{ selectionId: 101, handicap: 0 }]);
    assert.equal(started.outcome, "Started", JSON.stringify(started));
    // A lay on 102 that the green-up of 101 would leave uncovered: the close is not "closing" and,
    // checked as new risk, exceeds MAX_MARKET_LIABILITY 21.
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(102, "LAY", 6.2, 5)], TAG))[0].sizeMatched, 5);
    fake.setOffers(101, [[2.5, 100]], [[2.52, 80]]);

    const error = await c.bots.stop(started.botId!, { closePosition: true }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    assert.ok(error, "the close was refused, so stop reports the position as not closed");
    const [bot] = c.bots.list();
    assert.equal(bot.status, "stopped");
    assert.doesNotMatch(error!, /trying again on the next tick/, `the bot is stopped, yet the caller is told: ${error}`);
  });
});
