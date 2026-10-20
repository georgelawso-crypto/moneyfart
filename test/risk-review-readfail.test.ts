// Regression test from an independent review: when the guard cannot read the market it trusts the caller's reducesRisk label (no
// kill switch, no limits, no in-play rule), and when only the catalogue is missing the Australian
// in-play sport rule is skipped. Both are fail-open on a transient Betfair read error.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BetfairApiError } from "../src/betfair/client.js";
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

const placeCalls = (fake: FakeBetfair) => fake.calls.filter((call) => call.method === "placeOrders").length;

/** The next call of `method` fails with a timeout (later calls work). */
function failOnce(fake: FakeBetfair, method: "listMarketBook" | "listMarketCatalogue" | "listCurrentOrders") {
  const original = (fake[method] as (args: unknown) => Promise<unknown>).bind(fake);
  let failures = 1;
  (fake as unknown as Record<string, unknown>)[method] = async (args: unknown) => {
    if (failures-- > 0) throw new BetfairApiError(`Betfair ${method} failed: timed out`, "TIMEOUT");
    return original(args);
  };
}

describe("review: a failed market read lets any bet labelled reducesRisk through", () => {
  test("kill switch engaged, no position at all: a 102.50-liability 'closing' lay reaches Betfair", async () => {
    const { c, fake } = connector({ TRADING_MODE: "live", MAX_STAKE: "10", MAX_LIABILITY: "20" });
    c.guard.engageKillSwitch("emergency stop");
    failOnce(fake, "listMarketBook"); // the guard's book read
    const before = placeCalls(fake);
    const [bet] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 50, { reducesRisk: true })], TAG);
    assert.equal(
      placeCalls(fake),
      before,
      `a naked lay (liability 102.50 > MAX_LIABILITY 20) was sent with the kill switch on, only because it was labelled reducesRisk (${bet.status})`,
    );
  });

  test("the same happens when listCurrentOrders fails", async () => {
    const { c, fake } = connector({ TRADING_MODE: "live", MAX_STAKE: "10", MAX_LIABILITY: "20" });
    c.guard.engageKillSwitch("emergency stop");
    failOnce(fake, "listCurrentOrders");
    const before = placeCalls(fake);
    await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 500, { reducesRisk: true })], TAG);
    assert.equal(placeCalls(fake), before, "a 500 back was sent with the kill switch on (MAX_STAKE 10)");
  });
});

describe("review: the Australian in-play sport rule is skipped when the catalogue cannot be read", () => {
  const sportInPlay = () => {
    const fake = new FakeBetfair();
    fake.catalogues.get(WIN_MARKET)!.eventType = { id: "1", name: "Soccer" };
    fake.book().inplay = true;
    return fake;
  };

  test("live: an in-play soccer bet is sent to Betfair", async () => {
    const { c, fake } = connector({ BETFAIR_JURISDICTION: "au", TRADING_MODE: "live" }, sportInPlay());
    failOnce(fake, "listMarketCatalogue"); // only the guard's catalogue read fails
    const before = placeCalls(fake);
    const [bet] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG);
    assert.equal(placeCalls(fake), before, `in-play sport bet sent for an AU account (${bet.status})`);
    assert.match(bet.errorCode ?? "", /^IN_PLAY_SPORT_NOT_ALLOWED/);
  });

  test("paper: an in-play soccer bet is filled", async () => {
    const { c, fake } = connector({ BETFAIR_JURISDICTION: "au" }, sportInPlay());
    failOnce(fake, "listMarketCatalogue");
    const [bet] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG);
    assert.equal(bet.status, "FAILURE", `paper filled an in-play sport bet for an AU account (matched ${bet.sizeMatched})`);
  });
});
