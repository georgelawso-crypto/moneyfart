// Regression test from an independent review: "closing bets still go through" (kill switch message, kill_switch tool, engage notes)
// does not hold in single-winner markets with positions on several runners. A lay on one runner
// partly hedges a lay on another, so greening up one of them alone raises the market's worst case
// (even fully matched) and the guard, which judges each order on its own, classes it as new risk.
//  1. Under the kill switch a book of lays on two runners cannot be closed at all: each hedge alone
//     takes the worst case from 16 to 26.17 / 20.75, both together cut it to about 0.44.
//  2. A Lay Trade bot whose green-up is refused (here by MAX_MARKET_LIABILITY) treats the refusal
//     as an error, fails after 5 ticks and leaves its position unmanaged (no stop-loss, no close
//     before the off), even though the refusal could clear later (e.g. once the other lay is closed).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function connector(env: Record<string, string> = {}, fake = new FakeBetfair()) {
  const config = loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...env });
  return { fake, c: new Connector(config, fake) };
}

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

describe("review: closing bets refused as new risk", () => {
  test("kill switch on: lays on two runners that cover each other can't be closed (a partly matched close would raise the worst case)", async () => {
    // Updated after the second review: closing both together only lowers the worst case if both
    // match in full; with one partly matched it rises (16 -> 21.27 in review2-partial-close), so
    // neither hedge counts as closing and the kill switch refuses them, saying why.
    const { c } = connector();
    // Lay 101 10 @ 3.05 (liability 20.50) and lay 102 5 @ 6.2 (liability 26): worst case 16 (102 wins).
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 10)], TAG))[0].sizeMatched, 10);
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(102, "LAY", 6.2, 5)], TAG))[0].sizeMatched, 5);
    const report = await c.engageKillSwitch("something looks wrong");
    assert.match(report.notes.join(" "), /lays on two runners that cover each other\) is refused while the kill switch is on: close those on Betfair/);

    const result = await c.executeStrategy("Close Market Bet Position", WIN_MARKET, []);
    assert.equal(result.status, false);
    assert.equal(result.bets.length, 2);
    for (const bet of result.bets) {
      assert.match(bet.errorCode!, /^KILL_SWITCH_ENGAGED: .*it isn't counted as a closing bet: on its own it could raise the market's worst case \(for example lays on two runners that cover each other/);
    }
    assert.equal((await c.exchange.currentOrders([WIN_MARKET])).length, 2, "only the two lays");
  });

  test("kill switch on: Close Market Bet Position closes positions that don't cover each other, one selection at a time", async () => {
    const { c } = connector();
    // Back 101 10 @ 3.0 and back 102 5 @ 5.9: each green-up lowers the worst case on its own.
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG))[0].sizeMatched, 10);
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 5)], TAG))[0].sizeMatched, 5);
    await c.engageKillSwitch("flatten everything");
    const result = await c.executeStrategy("Close Market Bet Position", WIN_MARKET, []);
    assert.equal(result.status, true, JSON.stringify(result.bets));
    assert.deepEqual(result.bets.map((b) => [b.selectionId, b.side, b.status]), [["101", "LAY", "SUCCESS"], ["102", "LAY", "SUCCESS"]]);
  });

  test("a Lay Trade bot whose green-up is refused stops managing its position after 5 ticks", async () => {
    const { c, fake } = connector({ MAX_MARKET_LIABILITY: "21" });
    const started = await c.executeStrategy("Lay Trade", WIN_MARKET, [{ selectionId: 101, handicap: 0 }]);
    assert.equal(started.outcome, "Started", JSON.stringify(started));
    // A second lay on 102 (it does not raise the worst case, so it is accepted): worst case 16 (102 wins).
    const [other] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "LAY", 6.2, 5)], TAG);
    assert.equal(other.sizeMatched, 5, JSON.stringify(other));

    // 101 shortens: the bot's 10% stop-loss is reached and it greens up by backing 101 at 2.5.
    fake.setOffers(101, [[2.5, 100]], [[2.52, 80]]);
    for (let i = 0; i < 5; i++) await quietly(() => c.bots.tick());
    const [bot] = c.bots.list();
    const position = (await c.exchange.currentOrders([WIN_MARKET])).filter((o) => o.selectionId === "101");
    assert.notEqual(
      bot.status,
      "failed",
      `bot ${bot.id} gave up with ${position.length} open bet(s) on 101:\n${bot.log.map((l) => l.message).slice(-3).join("\n")}`,
    );
  });
});
