// Regression test from an independent review: an UNKNOWN (unconfirmed) order is counted as a resting unmatched leg. Under the
// "unmatched only where they hurt" rule such a leg gives headroom on the other side of the book,
// so while the order does not actually exist, a bet that adds real risk is classed as non-adding
// and skips every check (kill switch, MAX_TOTAL_EXPOSURE, DAILY_LOSS_LIMIT, delayed data...).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BetfairApiError } from "../src/betfair/client.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { marketExposure } from "../src/exchange/paper.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { formatSelectionId } from "../src/format.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function connector(env: Record<string, string> = {}, fake = new FakeBetfair()) {
  const config = loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...env });
  return { fake, c: new Connector(config, fake) };
}

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number, extra: Partial<OrderRequest> = {}): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE", ...extra };
}

const placeCalls = (fake: FakeBetfair) => fake.calls.filter((call) => call.method === "placeOrders").length;

/** Betfair-style exposure of the orders that really exist on the fake exchange. */
function realExposure(fake: FakeBetfair): number {
  let total = 0;
  for (const marketId of new Set(fake.liveOrders.map((o) => o.marketId))) {
    const book = fake.book(marketId);
    const legs = fake.liveOrders
      .filter((o) => o.marketId === marketId)
      .map((o) => ({
        key: formatSelectionId(o.selectionId, o.handicap ?? 0),
        side: o.side,
        price: o.priceSize?.price ?? 0,
        remaining: o.sizeRemaining ?? 0,
        fills: (o.sizeMatched ?? 0) > 0 ? [{ price: o.averagePriceMatched!, size: o.sizeMatched! }] : [],
      }));
    total += marketExposure(
      legs,
      book.numberOfWinners,
      book.runners.filter((r) => r.status === "ACTIVE").map((r) => formatSelectionId(r.selectionId, r.handicap)),
    );
  }
  return total;
}

/** The next placeOrders request times out before Betfair records anything (the order never exists). */
function timeoutOnce(fake: FakeBetfair) {
  const original = fake.placeOrders.bind(fake);
  let timeouts = 1;
  fake.placeOrders = async (args) => {
    if (timeouts-- > 0) {
      fake.calls.push({ method: "placeOrders", args });
      throw new BetfairApiError("Betfair placeOrders failed: timed out", "TIMEOUT");
    }
    return original(args);
  };
}

describe("review: unconfirmed orders give headroom to bets that add real risk", () => {
  test("MAX_TOTAL_EXPOSURE is exceeded with real money after an unconfirmed back", async () => {
    const fake = new FakeBetfair();
    // Betfair's account exposure reflects what really exists.
    fake.getAccountFunds = async () => {
      fake.calls.push({ method: "getAccountFunds", args: {} });
      return { ...fake.funds, exposure: -realExposure(fake) };
    };
    const { c } = connector({ TRADING_MODE: "live", MAX_TOTAL_EXPOSURE: "30" }, fake);

    timeoutOnce(fake);
    const [unknown] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG);
    assert.equal(unknown.status, "UNKNOWN");
    assert.equal(fake.liveOrders.length, 0, "the timed-out back never reached the exchange");

    // The guard can't know the back was never placed: it counts as possibly open (20), so 20 more is refused.
    const [place] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 20)], TAG);
    assert.equal(place.status, "FAILURE");
    assert.match(place.errorCode!, /^MAX_TOTAL_EXPOSURE: open worst-case loss would be 40.00/);

    // Liability 19.99 on WIN: the guard nets it against the phantom back's "if 101 loses" loss.
    const [lay] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 9.75)], TAG);
    const real = realExposure(fake);
    assert.ok(real <= 30 + 1e-9, `real open worst case ${real.toFixed(2)} > MAX_TOTAL_EXPOSURE 30 (the lay came back ${lay.status} ${lay.errorCode ?? ""})`);
  });

  test("with the kill switch engaged, a naked lay reaches Betfair because of the phantom back", async () => {
    const { c, fake } = connector({ TRADING_MODE: "live" });
    timeoutOnce(fake);
    const [unknown] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG);
    assert.equal(unknown.status, "UNKNOWN");
    assert.equal(fake.liveOrders.length, 0);

    c.guard.engageKillSwitch("emergency stop");
    const before = placeCalls(fake);
    const [lay] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 9.75)], TAG);
    assert.equal(placeCalls(fake), before, `a new 19.99 liability reached Betfair with the kill switch on (${lay.status})`);
    assert.match(lay.errorCode ?? "", /^KILL_SWITCH_ENGAGED/);
  });

  test("the guard itself fabricates a phantom leg when the exchange proves nothing was placed (mixed batch)", async () => {
    const { c, fake } = connector({ TRADING_MODE: "live" });
    // A refused request (HTTP 403, e.g. the wrong regional endpoint): LiveExchange rethrows it because
    // "nothing of this call reached Betfair" (outcomeUnknown is false for 4xx).
    const original = fake.placeOrders.bind(fake);
    let refusals = 1;
    let refused = 0;
    fake.placeOrders = async (args) => {
      if (refusals-- > 0) {
        refused++;
        throw new BetfairApiError("Betfair betting/placeOrders returned HTTP 403", "HTTP_403");
      }
      return original(args);
    };
    // The first order is refused by MAX_STAKE. Requests are all or nothing, so the second isn't sent either:
    // no request reaches the exchange and no possibly-placed bet is recorded.
    const [first, sent] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 30), order(101, "BACK", 3.0, 20)], TAG);
    assert.match(first.errorCode!, /^MAX_STAKE/);
    assert.match(sent.errorCode!, /^BATCH_REFUSED: not sent because the bet on 102 in the same request was refused \(MAX_STAKE\)/);
    assert.equal(refused, 0);
    assert.equal(fake.liveOrders.length, 0, "nothing was placed");

    c.guard.engageKillSwitch("emergency stop");
    const before = placeCalls(fake);
    const [lay] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 9.75)], TAG);
    assert.equal(placeCalls(fake), before, `a naked 19.99 lay reached Betfair with the kill switch on (${lay.status})`);
  });
});
