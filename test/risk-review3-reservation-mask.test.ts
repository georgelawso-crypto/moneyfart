// Regression test from a third independent review (high): a request's account reservation is the change of its market's worst case
// (guard.ts assess: added = after - worstLoss(market.legs, "hurt")), measured with the market's
// unmatched bets counted where they lose. An unmatched bet in the same market can hide the request's
// risk completely (added = 0): a lay resting below the market already "loses" in the outcome where
// the new back wins. When that unmatched bet is cancelled while the request is still on its way, the
// request's risk is in nobody's figure: not in the exchange's exposure (not landed yet), not in the
// reservations (0), and the freed headroom is used by a request on another market.
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

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("review 3: a reservation hidden by an unmatched bet in the same market", () => {
  test("MAX_TOTAL_EXPOSURE 100: a cancelled resting lay lets a back in flight and a back on another market both through", async () => {
    const fake = new FakeBetfair();
    const limits = { MAX_STAKE: "100", MAX_LIABILITY: "100", MAX_MARKET_LIABILITY: "100", MAX_TOTAL_EXPOSURE: "100", DAILY_LOSS_LIMIT: "1000" };
    const c = new Connector(
      loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", PAPER_STARTING_BALANCE: "10000", ...limits }),
      fake,
    );

    // 1. A lay resting below the market (the best price to lay 101 is 3.05): liability 100, the whole MAX_TOTAL_EXPOSURE.
    const [lay] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 2.0, 100)], TAG);
    assert.equal(lay.status, "SUCCESS");
    assert.equal(lay.sizeMatched, 0, "the lay rests");
    assert.equal((await c.exchange.accountFunds()).exposure, 100);

    // 2. A back of 50 on the same runner: it wins exactly where the resting lay loses, so the market's
    //    "hurt" worst case falls from 100 to 50 and the guard reserves nothing for it. It is slow to land
    //    (in-play bet delay, a busy exchange).
    const inner = c.guard.inner;
    const place = inner.placeOrders.bind(inner);
    const winSent = gate();
    const winLand = gate();
    inner.placeOrders = async (marketId, orders, strategy) => {
      if (marketId === WIN_MARKET && orders[0]?.side === "BACK") {
        winSent.open();
        await winLand.opened;
      }
      return place(marketId, orders, strategy);
    };
    // Fixed: the back is charged what it can add whatever happens to the resting lay (its own 50, as the
    // lay can be cancelled), so with the lay's 100 already open it is refused at once and never in flight.
    const [b] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 50)], TAG);
    assert.match(b.errorCode ?? "", /^MAX_TOTAL_EXPOSURE: open worst-case loss would be 150.00/);
    winLand.open();
    void winSent;

    // 3. The resting lay is cancelled (cancel_bets, a bot re-pricing, a lapse).
    const cancelled = await c.exchange.cancelOrders(WIN_MARKET, [lay.betId!]);
    assert.equal(cancelled[0].status, "SUCCESS");

    // 4. A back of 100 on another market now fits the freed headroom.
    const [other] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 100)], TAG);
    assert.equal(other.sizeMatched, 100);
    const exposure = (await c.exchange.accountFunds()).exposure;
    assert.ok(
      exposure <= 100 + 1e-9,
      `WIN back ${b.status} (matched ${b.sizeMatched}), PLACE back ${other.status} (matched ${other.sizeMatched}): ` +
        `open worst case ${exposure} > MAX_TOTAL_EXPOSURE 100`,
    );
  });
});
