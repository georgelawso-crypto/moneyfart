// Regression test from a third independent review (low, latent): in a LINE market Betfair's "price" is the line and every bet is at evens
// (BACK = over the line, LAY = under). The guard prices legs as odds and, for any non-ODDS market,
// falls back to "every bet is on one selection, so condition 2 decides" (exposure.ts closingVerdict:
// !scenarios && live.every(same key)) - which a single-runner line market always is. A sell (LAY) at a
// far lower line than an open buy is then "closing" by the odds maths and skips every limit and the
// kill switch, although the two bets both lose for any result between the lines. Paper mode refuses
// line markets and the strategy engine only runs on ODDS markets, so only a direct caller of
// connector.exchange in live mode gets here today.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CurrentOrderSummary } from "../src/betfair/types.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };
const LINE_MARKET = "1.200000009";

function order(side: "BACK" | "LAY", line: number, size: number): OrderRequest {
  return { selectionId: 501, handicap: 0, side, price: line, size, persistenceType: "LAPSE" };
}

/** Worst case of line bets at evens over every result: a back wins above its line, a lay below. */
function lineWorst(orders: CurrentOrderSummary[]): number {
  const lines = orders.map((o) => o.averagePriceMatched!);
  const results = [Math.min(...lines) - 1, Math.max(...lines) + 1, ...lines.map((l) => l + 0.25)];
  let worst = 0;
  for (const r of results) {
    const profit = orders.reduce((t, o) => t + ((o.side === "BACK") === r > o.averagePriceMatched! ? o.sizeMatched! : -o.sizeMatched!), 0);
    worst = Math.max(worst, -profit);
  }
  return worst;
}

describe("review 3: line markets", () => {
  test("live, kill switch on: a sell 50 lines under an open buy counts as closing", async () => {
    const fake = new FakeBetfair();
    fake.catalogues.set(LINE_MARKET, {
      marketId: LINE_MARKET,
      marketName: "1st Innings 20 Overs Line",
      marketStartTime: fake.startTime,
      eventType: { id: "4", name: "Cricket" },
      event: { id: "44", name: "A v B", countryCode: "GB", timezone: "Europe/London" },
      runners: [{ selectionId: 501, runnerName: "Runs", handicap: 0, sortPriority: 1 }],
      description: { marketType: "INNINGS_RUNS", bettingType: "LINE", priceLadderDescription: { type: "LINE_RANGE" } },
    });
    fake.books.set(LINE_MARKET, {
      marketId: LINE_MARKET,
      isMarketDataDelayed: false,
      status: "OPEN",
      inplay: false,
      betDelay: 0,
      numberOfWinners: 1,
      numberOfActiveRunners: 1,
      runners: [{ selectionId: 501, handicap: 0, status: "ACTIVE", ex: { availableToBack: [{ price: 150.5, size: 100 }], availableToLay: [{ price: 151.5, size: 100 }] } }],
    });
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);

    // Fixed: the guard only places bets on fixed-odds markets (its maths price bets as odds), like the strategy engine.
    const [buy] = await c.exchange.placeOrders(LINE_MARKET, [order("BACK", 150.5, 10)], TAG);
    assert.match(buy.errorCode ?? "", /^INVALID_ORDER: this is a LINE market; the connector only places bets on fixed-odds \(ODDS\) markets/);
    await c.engageKillSwitch("no new risk");
    const [sell] = await c.exchange.placeOrders(LINE_MARKET, [order("LAY", 100.5, 15)], TAG);
    assert.match(sell.errorCode ?? "", /^INVALID_ORDER: this is a LINE market/);
    assert.equal(fake.liveOrders.length, 0, "nothing reached Betfair");
    assert.equal(lineWorst([]), 0);
  });
});
