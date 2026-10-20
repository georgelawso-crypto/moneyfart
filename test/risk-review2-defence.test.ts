// Regression test from a second independent review (low, defence in depth; no current caller sends these, the guard's stated job is to
// hold whatever reaches it):
//  1. invalidOrder accepts any price from 1.01 to 1000, and LiveExchange then rounds it to 2 decimals
//     before sending. The guard sizes the liability at the unrounded price: a lay at 1.015 is sent
//     at 1.02, 33% more liability than every limit was checked against.
//  2. accountRisk reads `Number(funds.exposure) || 0`: an account answer without an exposure figure
//     is read as "nothing open" instead of unreadable, so MAX_TOTAL_EXPOSURE stops counting what is open.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
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

describe("review 2: defence in depth", () => {
  test("a lay at 1.015 passes MAX_LIABILITY 250 and is sent at 1.02 (liability 333)", async () => {
    const { c, fake } = live({ MAX_LIABILITY: "250", MAX_MARKET_LIABILITY: "1000", MAX_TOTAL_EXPOSURE: "1000", DAILY_LOSS_LIMIT: "1000" });
    const [bet] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 1.015, 16666)], TAG);
    const sent = fake.calls.filter((call) => call.method === "placeOrders").flatMap((call) => call.args.instructions);
    const liabilities = sent.map((i: { limitOrder: { price: number; size: number } }) => i.limitOrder.size * (i.limitOrder.price - 1));
    assert.ok(
      liabilities.every((l: number) => l <= 250 + 1e-6),
      `sent ${JSON.stringify(sent.map((i: { limitOrder: unknown }) => i.limitOrder))} (${bet.status}): liability ${liabilities.map((l: number) => l.toFixed(2)).join(", ")} > MAX_LIABILITY 250`,
    );
  });

  test("a market id with surrounding spaces hides the market's orders from the guard (paper)", async () => {
    // The guard keys its queue and reads the market's orders with the id as given; MarketService and
    // the paper exchange trim it, so the bet lands on the real market with its positions unseen.
    const config = loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", MAX_MARKET_LIABILITY: "30" });
    const c = new Connector(config, new FakeBetfair());
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].sizeMatched, 20);
    const [control] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 20)], TAG);
    assert.match(control.errorCode ?? "", /^MAX_MARKET_LIABILITY/);
    const [bet] = await c.exchange.placeOrders(` ${WIN_MARKET} `, [order(102, "BACK", 5.9, 20)], TAG);
    assert.equal(bet.status, "FAILURE", `placed on ${WIN_MARKET} (matched ${bet.sizeMatched}): the market's worst case is now 40 > MAX_MARKET_LIABILITY 30`);
  });

  test("an account answer without an exposure figure counts as nothing open", async () => {
    const { c, fake } = live({ MAX_TOTAL_EXPOSURE: "30" });
    fake.funds.exposure = 0;
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].sizeMatched, 20);
    fake.funds.exposure = -20; // Betfair shows the back
    const [control] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 20)], TAG);
    assert.match(control.errorCode ?? "", /^MAX_TOTAL_EXPOSURE/);
    fake.getAccountFunds = async () => ({ availableToBetBalance: 480 }) as never; // exposure missing from the answer
    const [bet] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 20)], TAG);
    assert.equal(bet.status, "FAILURE", "20 is already open on WIN (MAX_TOTAL_EXPOSURE 30), yet another 20 was placed on PLACE");
  });
});
