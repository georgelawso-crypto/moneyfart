// Regression test from a second independent review (critical): with more than 12 positioned selections (and in handicap/line markets) the
// exposure model falls back to the sum of per-selection worst cases, an UPPER bound. closes() compares
// two such upper bounds, which does not show that the real worst case did not rise: closing one leg
// of a 13-runner dutch passes as "closing" while it takes the real worst case from 0 to 120.
// The dutch itself reserved its upper bound (130) against MAX_TOTAL_EXPOSURE, but the account figure
// (Betfair's, or the paper ledger's) shows its real worst case (0), so that headroom is used again
// elsewhere; the "close" then adds 120 of real exposure that nothing checks.
// New risk is mis-charged the same way: `added` (guard.ts assess) is the difference of two upper
// bounds, so a lay on a dutched runner is charged 130 while it adds 260 to the real worst case.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MarketBook, MarketCatalogue } from "../src/betfair/types.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const BIG_FIELD = "1.200000013";
const RUNNERS = Array.from({ length: 13 }, (_, i) => 301 + i);

/** A 13-runner single-winner race, every runner 14.0 / 14.5 (a 92.9% book). */
function bigField(fake: FakeBetfair) {
  const base = fake.catalogues.get(WIN_MARKET)!;
  const catalogue: MarketCatalogue = {
    ...structuredClone(base),
    marketId: BIG_FIELD,
    marketName: "13 runner Hcap",
    runners: RUNNERS.map((selectionId, i) => ({ selectionId, runnerName: `Runner ${i + 1}`, handicap: 0, sortPriority: i + 1 })),
  };
  const book: MarketBook = {
    ...structuredClone(fake.book(WIN_MARKET)),
    marketId: BIG_FIELD,
    numberOfActiveRunners: 13,
    runners: RUNNERS.map((selectionId) => ({
      selectionId,
      handicap: 0,
      status: "ACTIVE",
      lastPriceTraded: 14,
      totalMatched: 100,
      ex: { availableToBack: [{ price: 14, size: 500 }], availableToLay: [{ price: 14.5, size: 500 }], tradedVolume: [{ price: 14, size: 100 }] },
    })),
  };
  fake.catalogues.set(BIG_FIELD, catalogue);
  fake.books.set(BIG_FIELD, book);
}

function setup(env: Record<string, string> = {}) {
  const fake = new FakeBetfair();
  bigField(fake);
  fake.setOffers(101, [[3.0, 1000]], [[3.05, 1000]]);
  const c = new Connector(
    loadConfig({
      BETFAIR_JURISDICTION: "com",
      RECORD_INTERVAL_SECONDS: "0",
      BOT_INTERVAL_SECONDS: "0",
      MAX_STAKE: "100",
      MAX_LIABILITY: "250",
      MAX_MARKET_LIABILITY: "130",
      MAX_TOTAL_EXPOSURE: "130",
      DAILY_LOSS_LIMIT: "130",
      ...env,
    }),
    fake,
  );
  return { c, fake };
}

async function dutchAll(c: Connector) {
  // 10 on each of the 13 runners: +10 whichever wins (real worst case 0).
  const dutch = await c.executeStrategy("Dutch for 10 Euro", BIG_FIELD, RUNNERS.map((selectionId) => ({ selectionId, handicap: 0 })), { TargetValue: 130 });
  assert.equal(dutch.status, true, dutch.message);
  assert.equal(dutch.bets.filter((b) => b.sizeMatched === 10).length, 13);
}

describe("review 2: closes() compares upper bounds when more than 12 selections have a position", () => {
  test("closing one leg of a 13-runner dutch adds 120 of exposure past MAX_TOTAL_EXPOSURE 130 and DAILY_LOSS_LIMIT 130", async () => {
    const { c, fake } = setup();
    await dutchAll(c);
    assert.equal((await c.exchange.accountFunds()).exposure, 0, "the dutch wins 10 whichever runner wins");
    // The account's 130 of headroom is still there: a 100 back elsewhere is accepted.
    const [back] = await c.exchange.placeOrders(WIN_MARKET, [{ selectionId: 101, handicap: 0, side: "BACK", price: 3.0, size: 100, persistenceType: "LAPSE" }], { name: "t", ref: "t" });
    assert.equal(back.sizeMatched, 100, JSON.stringify(back));

    // Green up runner 1 alone: LAY 9.66 @ 14.5. Upper bounds: 130 -> 120.41, so it counts as closing.
    const close = await c.executeStrategy("Close Selection Bet Position", BIG_FIELD, [{ selectionId: RUNNERS[0], handicap: 0 }]);
    const exposure = (await c.exchange.accountFunds()).exposure;

    // Runner 1 wins the big race (the other 12 backs lose) and 102 wins the WIN market.
    fake.settle([RUNNERS[0]], BIG_FIELD);
    fake.settle([102], WIN_MARKET);
    const status = await c.guard.riskStatus();
    assert.ok(
      exposure <= 130 + 1e-9,
      `after the "close" (${close.bets.map((b) => `${b.side} ${b.size} @ ${b.price} ${b.status}`).join(", ")}) the open worst case is ${exposure} ` +
        `(MAX_TOTAL_EXPOSURE 130); settled loss today ${(-(status.settledToday ?? 0)).toFixed(2)} (DAILY_LOSS_LIMIT 130)`,
    );
  });

  test("new risk: a lay on a dutched runner is charged 130 against MAX_TOTAL_EXPOSURE / DAILY_LOSS_LIMIT but adds 260", async () => {
    // added = upper bound after (260) - upper bound before (130) = 130, while the account figure it is
    // added to shows the race's real worst case (0 before, 260 after).
    const { c, fake } = setup({ MAX_LIABILITY: "300", MAX_MARKET_LIABILITY: "300", MAX_TOTAL_EXPOSURE: "200", DAILY_LOSS_LIMIT: "200" });
    await dutchAll(c);
    // Lay runner 1 for 20 @ 14.5 (liability 270): if runner 1 wins, -270 + 130 - 12 x 10 = -260.
    const lay = await c.executeStrategy("Lay 10 Euro", BIG_FIELD, [{ selectionId: RUNNERS[0], handicap: 0 }], { Stake: 20 });
    const exposure = (await c.exchange.accountFunds()).exposure;
    fake.settle([RUNNERS[0]], BIG_FIELD);
    const loss = -((await c.guard.riskStatus()).settledToday ?? 0);
    assert.ok(
      exposure <= 200 + 1e-9,
      `the lay (${lay.bets.map((b) => `${b.side} ${b.size} @ ${b.price} ${b.status} ${b.errorCode ?? ""}`).join(", ")}) took the open worst case to ${exposure} ` +
        `(MAX_TOTAL_EXPOSURE 200); runner 1 won: settled loss ${loss.toFixed(2)} > DAILY_LOSS_LIMIT 200`,
    );
  });

  test("kill switch on: the same one-leg close takes the race's worst case from 0 to 120", async () => {
    const { c } = setup();
    await dutchAll(c);
    await c.engageKillSwitch("no new risk");
    const before = (await c.exchange.accountFunds()).exposure;
    const close = await c.executeStrategy("Close Selection Bet Position", BIG_FIELD, [{ selectionId: RUNNERS[0], handicap: 0 }]);
    const after = (await c.exchange.accountFunds()).exposure;
    assert.ok(after <= before + 1e-9, `kill switch on, yet ${close.bets.map((b) => `${b.side} ${b.size} @ ${b.price} ${b.status}`).join(", ")} took the worst case from ${before} to ${after}`);
  });
});
