// Regression test from a second independent review (critical): a request's reservation is released as soon as its placement returns
// (guard.ts guardedPlace, finally: this.reservations.delete). The account section of a request on
// another market reads the account's exposure first (accountRisk: accountFunds) and sums the
// reservations only after a second await (settledBets). When the first request lands in between,
// its bet is in neither figure: not in the exposure read before it landed, and no longer reserved.
// Two concurrent requests on different markets then both use the same MAX_TOTAL_EXPOSURE headroom.
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

describe("review 2: a reservation released between another request's two account reads", () => {
  test("MAX_TOTAL_EXPOSURE 30: two concurrent 20 backs on different markets are both placed", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", MAX_TOTAL_EXPOSURE: "30" }), fake);
    const inner = c.guard.inner;

    // The WIN back is slow to land (a busy exchange); the PLACE request's cleared-orders read is slow.
    const place = inner.placeOrders.bind(inner);
    const winSent = gate();
    const winLand = gate();
    inner.placeOrders = async (marketId, orders, strategy) => {
      if (marketId === WIN_MARKET) {
        winSent.open();
        await winLand.opened;
      }
      return place(marketId, orders, strategy);
    };
    const settled = inner.settledBets.bind(inner);
    const placeReading = gate();
    const placeRead = gate();
    let reads = 0;
    inner.settledBets = async (from, marketIds) => {
      if (++reads === 2) {
        // The PLACE request: its exposure figure (read just before) does not include the WIN back yet.
        placeReading.open();
        await placeRead.opened;
      }
      return settled(from, marketIds);
    };

    const win = c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG);
    await winSent.opened; // checked (20 reserved) and on its way
    const placeBet = c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 20)], TAG);
    await placeReading.opened; // the PLACE check has read the exposure (0) and waits for today's results
    winLand.open();
    const [w] = await win; // landed: its reservation is released
    placeRead.open();
    const [p] = await placeBet;

    const exposure = (await c.exchange.accountFunds()).exposure;
    assert.ok(
      exposure <= 30 + 1e-9,
      `both backs were placed (WIN ${w.status} ${w.sizeMatched}, PLACE ${p.status} ${p.sizeMatched}): open worst case ${exposure} > MAX_TOTAL_EXPOSURE 30`,
    );
  });
});
