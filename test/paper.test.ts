import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { currencyRules } from "../src/betfair/currency.js";
import type { PersistenceType, Side } from "../src/betfair/types.js";
import { PaperExchange, marketExposure, type PaperOptions } from "../src/exchange/paper.js";
import type { OrderRequest, PlacedBet } from "../src/exchange/types.js";
import { MarketService } from "../src/markets.js";
import { Recorder } from "../src/recorder.js";
import { State } from "../src/state.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "Test Strategy", ref: "TestRef" };

function setup(opts: { state?: State; fake?: FakeBetfair; options?: Partial<PaperOptions> } = {}) {
  const fake = opts.fake ?? new FakeBetfair();
  const state = opts.state ?? new State();
  const markets = new MarketService(fake, state, new Recorder(), 20);
  const clock = { t: Date.now() };
  const sleeps: number[] = [];
  const hooks: { duringSleep?: () => void } = {};
  const paper = new PaperExchange(markets, state, {
    startingBalance: 1000,
    commissionRate: 0.05,
    currency: currencyRules("GBP"),
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
      hooks.duringSleep?.();
    },
    ...opts.options,
  });
  const place = (orders: OrderRequest[], marketId = WIN_MARKET) => paper.placeOrders(marketId, orders, TAG);
  const order = (betId: string) => state.paper.orders.find((o) => o.betId === betId)!;
  const view = async (betId: string) => (await paper.currentOrders()).find((o) => o.betId === betId);
  return { fake, state, markets, paper, clock, sleeps, hooks, place, order, view };
}

function req(side: Side, selectionId: number, price: number, size: number, persistenceType: PersistenceType = "LAPSE"): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType };
}
const back = (selectionId: number, price: number, size: number, persistence?: PersistenceType) => req("BACK", selectionId, price, size, persistence);
const lay = (selectionId: number, price: number, size: number, persistence?: PersistenceType) => req("LAY", selectionId, price, size, persistence);

function ok(bet: PlacedBet): string {
  assert.equal(bet.status, "SUCCESS", `expected SUCCESS, got ${bet.errorCode}`);
  return bet.betId!;
}

const close = (actual: number | undefined, expected: number, eps = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

const bookCalls = (fake: FakeBetfair) => fake.calls.filter((c) => c.method === "listMarketBook").length;

describe("paper: immediate matching", () => {
  test("matches best price first, never worse than requested, with unrounded averages", async () => {
    const { fake, place, paper, order } = setup();
    fake.setOffers(101, [[3.0, 100], [2.98, 80], [2.96, 500]], [[3.05, 80], [3.1, 60]]);
    const [bet] = await place([back(101, 2.96, 200)]);
    ok(bet);
    assert.equal(bet.sizeMatched, 200);
    assert.equal(bet.orderStatus, "EXECUTION_COMPLETE");
    close(bet.averagePriceMatched, 2.988); // stored and reported unrounded (v1 rounded to 2.99)
    assert.deepEqual(order(bet.betId!).fills.map((f) => [f.price, f.size]), [[3.0, 100], [2.98, 80], [2.96, 20]]);

    const [layBet] = await place([lay(101, 3.1, 120)]);
    assert.equal(layBet.sizeMatched, 120); // 80 @3.05 (best for the layer) then 40 @3.1, never above 3.1
    close(layBet.averagePriceMatched, (80 * 3.05 + 40 * 3.1) / 120);
    const [capped] = await place([lay(101, 3.1, 50)]);
    assert.equal(capped.sizeMatched, 20); // the 3.15 offers are worse than the limit
    assert.equal(capped.orderStatus, "EXECUTABLE");

    fake.settle([101]);
    const { bets } = await paper.settledBets(new Date(0));
    const won = bets.find((b) => b.betId === bet.betId)!;
    close(won.profit, 397.6); // from the fills, not 200 x (2.99 - 1) = 398
    close(won.priceMatched, 2.988);
  });

  test("depletes displayed liquidity within one batch", async () => {
    const { place } = setup();
    const [a, b, c] = await place([back(101, 3.0, 60), back(101, 3.0, 60), back(101, 2.98, 60)]);
    assert.equal(a.sizeMatched, 60);
    assert.equal(b.sizeMatched, 40); // only 40 of the 3.0 x 100 level is left
    assert.equal(b.orderStatus, "EXECUTABLE");
    assert.equal(c.sizeMatched, 60);
    close(c.averagePriceMatched, 2.98);
  });

  test("three orders against one 100 level total 100", async () => {
    const { place } = setup();
    const bets = await place([back(101, 3.0, 100), back(101, 3.0, 100), back(101, 3.0, 100)]);
    assert.deepEqual(bets.map((b) => b.sizeMatched), [100, 0, 0]);
  });

  test("depletes liquidity across calls while the book is unchanged", async () => {
    const { place } = setup();
    assert.equal((await place([back(101, 3.0, 100)]))[0].sizeMatched, 100);
    assert.equal((await place([back(101, 3.0, 100)]))[0].sizeMatched, 0);
    const [deeper] = await place([back(101, 2.96, 200)]);
    assert.equal(deeper.sizeMatched, 140); // 2.98 x 80 + 2.96 x 60
  });

  test("a partial fill does not refill from the same displayed level on later books", async () => {
    const { place, paper, view } = setup();
    const [bet] = await place([back(101, 3.0, 500)]);
    assert.equal(bet.sizeMatched, 100);
    assert.equal(bet.orderStatus, "EXECUTABLE");
    for (let i = 0; i < 3; i++) {
      const v = await view(bet.betId!);
      assert.equal(v!.sizeMatched, 100);
      assert.equal(v!.sizeRemaining, 400);
    }
    assert.equal((await paper.accountFunds()).exposure, 500); // 100 matched + 400 that may still match
  });

  test("Back Trade on thin liquidity keeps the entry at what matched when the offset is placed", async () => {
    const { fake, place, view } = setup();
    fake.setOffers(101, [[3.0, 8], [2.98, 80]], [[3.05, 80], [3.1, 60]]);
    const [entry] = await place([back(101, 3.0, 25)]);
    assert.equal(entry.sizeMatched, 8);
    const [offset] = await place([lay(101, 2.96, 8.11)]);
    ok(offset);
    assert.equal(offset.sizeMatched, 0);
    assert.equal((await view(entry.betId!))!.sizeMatched, 8);
    assert.equal((await view(offset.betId!))!.sizeRemaining, 8.11);
  });
});

describe("paper: resting orders", () => {
  test("a stale last traded price never fills a resting order; new volume through the price does", async () => {
    const { fake, place, view } = setup();
    fake.setRunner(101, { lastPriceTraded: 3.2 }); // left over from before the price shortened
    const [entry] = await place([lay(101, 3.05, 10)]);
    assert.equal(entry.sizeMatched, 10);
    const [exit] = await place([back(101, 3.15, 9.68)]);
    assert.equal(exit.sizeMatched, 0);
    assert.equal((await view(exit.betId!))!.sizeMatched, 0);
    assert.equal((await view(exit.betId!))!.sizeMatched, 0);
    fake.trade(101, 3.2, 20); // real volume traded through 3.15
    const v = await view(exit.betId!);
    assert.equal(v!.sizeMatched, 9.68);
    assert.equal(v!.averagePriceMatched, 3.15); // resting fills are at the order's price
  });

  test("traded volume at the price fills only beyond the queue ahead", async () => {
    const { fake, place, view, order } = setup();
    const [bet] = await place([back(101, 3.1, 20)]); // rests behind 60 offered at 3.1
    assert.equal(bet.sizeMatched, 0);
    assert.equal(order(bet.betId!).meta!.queue, 60);
    fake.trade(101, 3.1, 40);
    assert.equal((await view(bet.betId!))!.sizeMatched, 0);
    assert.equal(order(bet.betId!).meta!.queue, 20);
    fake.trade(101, 3.1, 30); // 20 clears the queue, 10 reaches the order
    assert.equal((await view(bet.betId!))!.sizeMatched, 10);
    assert.equal((await view(bet.betId!))!.sizeMatched, 10); // no new volume, no new fill
    fake.trade(101, 3.1, 50); // capped by the remaining 10
    const v = await view(bet.betId!);
    assert.equal(v!.sizeMatched, 20);
    assert.equal(v!.status, "EXECUTION_COMPLETE");
  });

  test("the queue ahead never exceeds what is still displayed at the price", async () => {
    const { fake, place, view, order } = setup();
    const [bet] = await place([back(101, 3.15, 20)]);
    assert.equal(order(bet.betId!).meta!.queue, 40);
    fake.setOffers(101, [[3.0, 100]], [[3.05, 80], [3.1, 60], [3.15, 5]]); // others cancelled ahead of us
    assert.equal((await view(bet.betId!))!.sizeMatched, 0);
    assert.equal(order(bet.betId!).meta!.queue, 5);
    fake.trade(101, 3.15, 10); // the 5 ahead, then 5 of ours (3.15 still shows 5 of newer money behind us)
    assert.equal((await view(bet.betId!))!.sizeMatched, 5);
  });

  test("a crossed book fills up to the size offered at or better than the price, once", async () => {
    const { fake, place, view } = setup();
    const [bet] = await place([back(101, 3.1, 50)]);
    fake.setOffers(101, [[3.15, 30], [3.1, 10], [3.0, 100]], [[3.2, 50]]);
    let v = await view(bet.betId!);
    assert.equal(v!.sizeMatched, 40);
    assert.equal(v!.averagePriceMatched, 3.1);
    v = await view(bet.betId!);
    assert.equal(v!.sizeMatched, 40, "the same displayed money must not fill twice");
    fake.setOffers(101, [[3.15, 50], [3.1, 10], [3.0, 100]], [[3.2, 50]]); // 20 new at 3.15
    v = await view(bet.betId!);
    assert.equal(v!.sizeMatched, 50);
  });

  test("other bettors trading the liquidity this engine took is not evidence for the remainder", async () => {
    const { fake, place, view } = setup();
    const [bet] = await place([back(101, 3.0, 150)]);
    assert.equal(bet.sizeMatched, 100);
    fake.trade(101, 3.0, 100); // the 100 we took is traded away by others
    fake.setOffers(101, [[2.98, 80], [2.96, 60]], [[3.05, 80], [3.1, 60], [3.15, 40]]);
    assert.equal((await view(bet.betId!))!.sizeMatched, 100);
    fake.trade(101, 3.0, 30); // new money traded at 3.0
    assert.equal((await view(bet.betId!))!.sizeMatched, 130);
  });

  test("consumption survives suspended books without offers and is released when the level is gone", async () => {
    const { fake, place, view } = setup();
    const [bet] = await place([back(101, 3.0, 500)]);
    const offers = { back: [[3.0, 100], [2.98, 80], [2.96, 60]] as Array<[number, number]>, lay: [[3.05, 80], [3.1, 60], [3.15, 40]] as Array<[number, number]> };
    fake.book().status = "SUSPENDED";
    fake.setOffers(101, [], []);
    assert.equal((await view(bet.betId!))!.sizeMatched, 100);
    fake.book().status = "OPEN";
    fake.setOffers(101, offers.back, offers.lay); // the same money is back: still taken
    assert.equal((await view(bet.betId!))!.sizeMatched, 100);
    fake.setOffers(101, [[2.98, 80], [2.96, 60]], offers.lay); // the 3.0 offer was cancelled (no trade)
    assert.equal((await view(bet.betId!))!.sizeMatched, 100);
    fake.setOffers(101, [[3.0, 100], [2.98, 80]], offers.lay); // new money at 3.0
    assert.equal((await view(bet.betId!))!.sizeMatched, 200);
  });

  test("an unknown queue position becomes known once the level is within the shown ladder", async () => {
    const { fake, place, view, order } = setup();
    const [bet] = await place([back(101, 3.5, 20)]); // beyond the three lay prices shown
    assert.equal(order(bet.betId!).meta!.queue, null);
    fake.trade(101, 3.5, 50);
    assert.equal((await view(bet.betId!))!.sizeMatched, 0, "unknown queue: volume at the price is not enough");
    fake.setOffers(101, [[3.0, 100]], [[3.05, 80], [3.5, 15], [3.6, 10]]);
    await view(bet.betId!);
    assert.equal(order(bet.betId!).meta!.queue, 15);
    fake.trade(101, 3.5, 25);
    assert.equal((await view(bet.betId!))!.sizeMatched, 10);
  });

  test("one traded print fills at most its size across this engine's orders", async () => {
    const { fake, place, view } = setup();
    const [a, b] = await place([back(101, 3.1, 20), back(101, 3.15, 20)]);
    fake.trade(101, 3.2, 25);
    assert.equal((await view(a.betId!))!.sizeMatched, 20); // the lower back is first in the queue for layers
    assert.equal((await view(b.betId!))!.sizeMatched, 5);
  });

  test("lay orders fill on volume traded below their price, and at it beyond their queue", async () => {
    const { fake, place, view, order } = setup();
    const [bet] = await place([lay(101, 2.96, 30)]); // rests behind the 60 offered to backers at 2.96
    assert.equal(bet.sizeMatched, 0);
    assert.equal(order(bet.betId!).meta!.queue, 60);
    fake.trade(101, 2.96, 64);
    assert.equal((await view(bet.betId!))!.sizeMatched, 4);
    fake.trade(101, 2.9, 8);
    assert.equal((await view(bet.betId!))!.sizeMatched, 12);
    fake.setOffers(101, [[2.9, 100]], [[2.94, 10], [2.96, 50]]); // back offers at or below 2.96 now cross
    assert.equal((await view(bet.betId!))!.sizeMatched, 30);
  });

  test("books without traded volume are ignored, not read as zero", async () => {
    const { fake, place, view } = setup();
    const [bet] = await place([back(101, 3.15, 10)]);
    const saved = fake.runner(101).ex!.tradedVolume;
    fake.runner(101).ex!.tradedVolume = undefined; // e.g. a delayed application key
    assert.equal((await view(bet.betId!))!.sizeMatched, 0);
    fake.runner(101).ex!.tradedVolume = saved;
    assert.equal((await view(bet.betId!))!.sizeMatched, 0, "restored volume is not new volume");
    fake.trade(101, 3.2, 4);
    assert.equal((await view(bet.betId!))!.sizeMatched, 4);
  });

  test("LAPSE orders lapse at the off, PERSIST orders stay, orders placed in-play stay until close", async () => {
    const { fake, place, paper, view, order } = setup();
    const [lapse, persist] = await place([back(101, 3.5, 10), back(101, 3.5, 10, "PERSIST")]);
    fake.book().inplay = true;
    fake.setOffers(101, [[3.6, 100]], [[3.7, 100]]); // crosses both, but LAPSE was cancelled at the off
    assert.equal(await view(lapse.betId!), undefined);
    assert.equal(order(lapse.betId!).sizeLapsed, 10);
    assert.equal(order(lapse.betId!).fills.length, 0);
    assert.equal((await view(persist.betId!))!.sizeMatched, 10);

    fake.setOffers(101, [[3.0, 100]], [[3.05, 100]]);
    const [inPlay] = await place([back(101, 3.5, 10)]);
    assert.equal(order(inPlay.betId!).placedInPlay, true);
    for (let i = 0; i < 2; i++) assert.equal((await view(inPlay.betId!))!.status, "EXECUTABLE");

    fake.settle([102]);
    assert.deepEqual(await paper.currentOrders(), []);
    assert.equal(order(inPlay.betId!).sizeLapsed, 10);
    assert.equal(order(inPlay.betId!).settlement!.outcome, "VOID");
    assert.equal(order(persist.betId!).settlement!.outcome, "LOST");
  });

  test("delayed in-play books do not fill resting orders", async () => {
    const { fake, place, view } = setup();
    fake.book().isMarketDataDelayed = true;
    const [bet] = await place([back(101, 3.2, 10, "PERSIST")]); // pre-off on delayed data is allowed
    ok(bet);
    fake.book().inplay = true;
    fake.setOffers(101, [[3.4, 100]], [[3.5, 100]]);
    fake.trade(101, 3.4, 50);
    const v = await view(bet.betId!);
    assert.equal(v!.sizeMatched, 0);
    assert.equal(v!.status, "EXECUTABLE");
  });
});

describe("paper: placement rules", () => {
  test("waits out the in-play bet delay and matches against the book after it", async () => {
    const { fake, place, sleeps, hooks, order } = setup();
    fake.book().inplay = true;
    fake.book().betDelay = 5;
    hooks.duringSleep = () => fake.setOffers(101, [[3.2, 50], [3.0, 100]], [[3.25, 50]]);
    const [bet] = await place([back(101, 3.0, 20), back(101, 3.0, 20)]);
    assert.deepEqual(sleeps, [5000], "one delay per batch");
    assert.equal(bet.sizeMatched, 20);
    assert.equal(bet.averagePriceMatched, 3.2);
    assert.equal(order(bet.betId!).placedInPlay, true);
  });

  test("a suspension or removal during the bet delay fails the order without recording it", async () => {
    const { fake, place, state, hooks, sleeps } = setup();
    fake.book().inplay = true;
    fake.book().betDelay = 1;
    hooks.duringSleep = () => {
      fake.book().status = "SUSPENDED";
    };
    const [suspended] = await place([back(101, 3.0, 10)]);
    assert.equal(suspended.status, "FAILURE");
    assert.equal(suspended.errorCode, "MARKET_SUSPENDED");
    fake.book().status = "OPEN";
    hooks.duringSleep = () => fake.setRunner(101, { status: "REMOVED" });
    const [removed] = await place([back(101, 3.0, 10)]);
    assert.equal(removed.errorCode, "RUNNER_REMOVED");
    assert.equal(state.paper.orders.length, 0);
    // Orders that fail validation do not wait.
    sleeps.length = 0;
    await place([back(102, 3.03, 10)]);
    assert.deepEqual(sleeps, []);
  });

  test("refuses in-play placement on delayed data", async () => {
    const { fake, place } = setup();
    fake.book().isMarketDataDelayed = true;
    fake.book().inplay = true;
    const [bet] = await place([back(101, 3.0, 10)]);
    assert.equal(bet.status, "FAILURE");
    assert.equal(bet.errorCode, "DELAYED_DATA_IN_PLAY");
  });

  test("applies Betfair's minimum bet size and minimum payout rules", async () => {
    const { place } = setup();
    const bets = await place([back(102, 3.0, 0.5), back(102, 30, 0.5), lay(102, 30, 0.5), back(102, 6.0, 1.005), back(102, 6.0, 0), back(102, 6.0, 1)]);
    assert.deepEqual(
      bets.map((b) => b.errorCode ?? b.status),
      ["INVALID_BET_SIZE", "SUCCESS", "SUCCESS", "INVALID_BET_SIZE", "INVALID_BET_SIZE", "SUCCESS"],
    );
    const eur = setup({ options: { currency: currencyRules("EUR") } });
    assert.equal((await eur.place([back(102, 30, 0.5)]))[0].errorCode, "INVALID_BET_SIZE"); // payout 15 < 20
  });

  test("validates market status, runner, ladder and market type", async () => {
    const { fake, place } = setup();
    assert.equal((await place([back(101, 3.03, 10)]))[0].errorCode, "INVALID_ODDS");
    assert.equal((await place([back(999, 3.0, 10)]))[0].errorCode, "INVALID_RUNNER");
    assert.equal((await place([back(101, 3.0, 10, "MARKET_ON_CLOSE")]))[0].errorCode, "MARKET_ON_CLOSE_NOT_SUPPORTED");
    assert.equal((await place([back(101, 3.0, 10, "KEEP" as PersistenceType)]))[0].errorCode, "INVALID_PERSISTENCE_TYPE");
    fake.setRunner(102, { status: "REMOVED" });
    assert.equal((await place([back(102, 6.0, 10)]))[0].errorCode, "RUNNER_REMOVED");
    fake.book().status = "SUSPENDED";
    assert.equal((await place([back(101, 3.0, 10)]))[0].errorCode, "MARKET_SUSPENDED");
    fake.book().status = "INACTIVE";
    assert.equal((await place([back(101, 3.0, 10)]))[0].errorCode, "MARKET_NOT_OPEN_FOR_BETTING");

    const closed = setup();
    closed.fake.book().status = "CLOSED"; // Betfair no longer returns its catalogue
    const bets = await closed.place([back(101, 3.0, 10), lay(102, 6.2, 10)]);
    assert.deepEqual(bets.map((b) => b.errorCode), ["MARKET_NOT_OPEN_FOR_BETTING", "MARKET_NOT_OPEN_FOR_BETTING"]);

    const finest = setup();
    finest.fake.catalogues.get(WIN_MARKET)!.description!.priceLadderDescription = { type: "FINEST" };
    ok((await finest.place([back(101, 3.03, 10)]))[0]);

    const noPersist = setup();
    noPersist.fake.catalogues.get(WIN_MARKET)!.description!.persistenceEnabled = false;
    assert.equal((await noPersist.place([back(101, 3.5, 10, "PERSIST")]))[0].errorCode, "INVALID_PERSISTENCE_TYPE");

    const line = setup();
    line.fake.catalogues.get(WIN_MARKET)!.description!.bettingType = "LINE";
    assert.equal((await line.place([back(101, 3.0, 10)]))[0].errorCode, "LINE_MARKET_NOT_SUPPORTED");
  });

  test("refuses EACH_WAY markets", async () => {
    const { fake, place, state } = setup();
    fake.catalogues.get(WIN_MARKET)!.description!.marketType = "EACH_WAY";
    fake.catalogues.get(WIN_MARKET)!.description!.eachWayDivisor = 5;
    const bets = await place([back(102, 5.9, 10), lay(101, 3.05, 10)]);
    assert.deepEqual(bets.map((b) => b.errorCode), ["EACH_WAY_NOT_SUPPORTED", "EACH_WAY_NOT_SUPPORTED"]);
    assert.equal(state.paper.orders.length, 0);
  });

  test("a failed catalogue fetch on an open market fails the call instead of guessing", async () => {
    const { fake, place, state } = setup();
    fake.listMarketCatalogue = async () => {
      throw new Error("catalogue down");
    };
    await assert.rejects(place([back(101, 3.0, 10)]), /catalogue down/);
    assert.equal(state.paper.orders.length, 0);
  });

  test("an empty batch places nothing", async () => {
    const { fake, place } = setup();
    assert.deepEqual(await place([]), []);
    assert.equal(fake.calls.length, 0);
  });

  test("records strategy, names and placement details on the order", async () => {
    const { place, order, paper } = setup();
    const [bet] = await place([back(101, 3.0, 10)]);
    const o = order(bet.betId!);
    assert.match(bet.betId!, /^P[0-9a-z]{9}1$/);
    assert.equal(o.strategyName, "Test Strategy");
    assert.equal(o.strategyRef, "TestRef");
    assert.equal(o.marketName, "2m Hcap");
    assert.equal(o.eventName, "Ascot 19th Oct");
    assert.equal(o.eventType, "Horse Racing");
    assert.equal(o.selectionName, "Fast Horse");
    assert.equal(o.marketType, "WIN");
    assert.equal(o.numberOfWinners, 1);
    assert.equal(o.placedInPlay, false);
    assert.deepEqual(await paper.currencyRules(), currencyRules("GBP"));
    const [view] = await paper.currentOrders([WIN_MARKET]);
    assert.equal(view.strategy, "Test Strategy");
    assert.equal(view.selectionId, "101");
    assert.equal(view.sizeVoided, 0);
    assert.ok(view.matchedDate);
  });
});

describe("paper: funds and exposure", () => {
  test("refuses orders that overdraw the balance while adding exposure; risk-reducing orders pass", async () => {
    const { place, paper } = setup();
    const bets = await place(Array.from({ length: 10 }, () => lay(102, 6.2, 40))); // liability 208 each
    assert.deepEqual(
      bets.map((b) => b.errorCode ?? b.status),
      ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", ...Array(6).fill("INSUFFICIENT_FUNDS")],
    );
    let funds = await paper.accountFunds();
    assert.equal(funds.exposure, 832);
    assert.equal(funds.availableToBetBalance, 168);
    ok((await place([back(102, 6.0, 40)]))[0]); // a hedge never increases the worst case
    assert.equal((await place([lay(102, 6.2, 40)]))[0].errorCode, "INSUFFICIENT_FUNDS");
    // The check spans markets: 284 liability on the PLACE market exceeds the 168 left.
    assert.equal((await place([lay(102, 2.42, 200)], PLACE_MARKET))[0].errorCode, "INSUFFICIENT_FUNDS");
    ok((await place([lay(102, 2.42, 100)], PLACE_MARKET))[0]);
    funds = await paper.accountFunds();
    assert.equal(funds.exposure, 974);
    assert.equal(funds.availableToBetBalance, 26);
    assert.ok(funds.availableToBetBalance >= 0);
  });

  test("orders that do not add exposure pass even when the account is already overdrawn", async () => {
    const { place, paper, state } = setup();
    await place([lay(102, 6.2, 10)]); // liability 52
    state.paper.settlements.push({ marketId: "1.1", marketName: "m", eventName: "e", grossProfit: -990, commission: 0, settledDate: new Date().toISOString() });
    assert.equal((await paper.accountFunds()).availableToBetBalance, -42);
    ok((await place([back(102, 6.0, 10)]))[0]); // resting hedge: no scenario gets worse
    assert.equal((await place([lay(102, 6.2, 2)]))[0].errorCode, "INSUFFICIENT_FUNDS");
    assert.equal((await place([back(101, 3.0, 2)]))[0].errorCode, "INSUFFICIENT_FUNDS");
  });

  test("single-winner exposure covers the field only when every active runner has a position", async () => {
    const all = setup();
    await all.place([back(101, 3.0, 10), back(102, 5.9, 10), back(103, 4.4, 10)]);
    assert.equal((await all.paper.accountFunds()).exposure, 0); // 101 wins: 0, 102: +29, 103: +14

    const two = setup();
    await two.place([back(101, 3.0, 10), back(102, 5.9, 10)]);
    assert.equal((await two.paper.accountFunds()).exposure, 20); // 103 (no position) can win
  });

  test("unmatched orders only worsen scenarios (folded in, not added on top)", async () => {
    const { place, paper } = setup();
    await place([back(101, 3.0, 10)]);
    const [offset] = await place([lay(101, 2.96, 10.14)]);
    assert.equal(offset.sizeMatched, 0);
    assert.equal((await paper.accountFunds()).exposure, 10);
  });

  test("multi-winner markets sum each selection's worst case, unmatched included", async () => {
    const { fake, place, paper } = setup();
    fake.book().numberOfWinners = 3;
    await place([lay(101, 3.05, 10), lay(103, 4.6, 10)]);
    assert.equal((await paper.accountFunds()).exposure, 56.5); // 20.5 + 36, not the single-winner 36
    await place([lay(102, 6.0, 10)]); // rests: its 50 liability counts too
    assert.equal((await paper.accountFunds()).exposure, 106.5);
    fake.settle([101, 103]);
    const funds = await paper.accountFunds();
    assert.equal(funds.exposure, 0);
    assert.equal(funds.balance, 943.5);

    const placeMarket = setup();
    await placeMarket.place([lay(101, 1.52, 10), lay(103, 1.91, 10)], PLACE_MARKET);
    assert.equal((await placeMarket.paper.accountFunds()).exposure, 14.3);
  });

  test("handicap lines are never treated as mutually exclusive winners", async () => {
    const { fake, place, paper } = setup();
    const book = fake.book();
    book.runners = [
      { ...structuredClone(fake.runner(101)), handicap: -0.5 },
      { ...structuredClone(fake.runner(101)), handicap: 0.5 },
    ];
    fake.catalogues.get(WIN_MARKET)!.runners = [
      { selectionId: 101, runnerName: "Home -0.5", handicap: -0.5, sortPriority: 1 },
      { selectionId: 101, runnerName: "Home +0.5", handicap: 0.5, sortPriority: 2 },
    ];
    const bets = await place([
      { selectionId: 101, handicap: -0.5, side: "LAY", price: 3.05, size: 10, persistenceType: "LAPSE" },
      { selectionId: 101, handicap: 0.5, side: "LAY", price: 3.05, size: 10, persistenceType: "LAPSE" },
    ]);
    assert.deepEqual(bets.map((b) => [b.selectionId, b.sizeMatched]), [["101_-0.50", 10], ["101_0.50", 10]]);
    assert.equal((await paper.accountFunds()).exposure, 41); // both lines can win: 20.5 + 20.5
  });

  test("marketExposure falls back to independent selections when the winner count is unknown", () => {
    const lays = [
      { key: "1", side: "LAY" as const, price: 3, remaining: 0, fills: [{ price: 3, size: 10 }] },
      { key: "2", side: "LAY" as const, price: 4, remaining: 0, fills: [{ price: 4, size: 10 }] },
    ];
    assert.equal(marketExposure(lays, undefined), 50); // 20 + 30: both could win
    assert.equal(marketExposure(lays, 1, ["1", "2"]), 20); // one winner: 2 wins -> -30 + 10
    const backs = [
      { key: "1", side: "BACK" as const, price: 3, remaining: 0, fills: [{ price: 3, size: 10 }] },
      { key: "2", side: "BACK" as const, price: 4, remaining: 0, fills: [{ price: 4, size: 10 }] },
    ];
    assert.equal(marketExposure(backs, 1, ["1", "2"]), 0); // field covered
    assert.equal(marketExposure(backs, 1, ["1", "2", "3"]), 20); // runner 3 can win
    assert.equal(marketExposure(backs, 1), 20); // runners unknown: assume an uncovered winner
    assert.equal(marketExposure([], 1), 0);
  });
});

describe("paper: non-runners", () => {
  test("voids bets on the removed runner, lapses earlier unmatched bets and reduces earlier fills", async () => {
    const { fake, place, paper, clock, order, state } = setup();
    const t0 = clock.t;
    const [win, nr, rest103, rest101] = await place([back(101, 3.0, 10), back(102, 5.9, 25), back(103, 4.5, 10), lay(101, 2.9, 10)]);
    assert.equal(win.sizeMatched, 10);
    assert.equal(nr.sizeMatched, 25);
    clock.t = t0 + 60_000;
    fake.setRunner(102, { status: "REMOVED", removalDate: new Date(t0 + 30_000).toISOString(), adjustmentFactor: 30 });
    const [after] = await place([back(103, 4.6, 10)]); // placed after the removal: unaffected
    ok(after);

    const voided = order(nr.betId!);
    assert.equal(voided.settlement!.outcome, "VOID");
    assert.equal(voided.sizeVoided, 25);
    assert.equal(order(rest103.betId!).sizeLapsed, 10);
    assert.equal(order(rest101.betId!).sizeLapsed, 10);
    const fill = order(win.betId!).fills[0];
    close(fill.price, 2.1);
    assert.equal(fill.originalPrice, 3.0);

    const views = await paper.currentOrders();
    assert.deepEqual(views.map((v) => v.betId).sort(), [win.betId, after.betId].sort());
    close(views.find((v) => v.betId === win.betId)!.averagePriceMatched, 2.1);
    await paper.currentOrders();
    close(order(win.betId!).fills[0].price, 2.1, 1e-9); // not compounded on later books
    assert.equal((await paper.accountFunds()).exposure, 10); // the 25 on the non-runner is no longer at risk
    assert.equal(order(after.betId!).sizeLapsed, 0);

    fake.settle([101], WIN_MARKET, { removed: [102] });
    const { bets, commission } = await paper.settledBets(new Date(0));
    assert.deepEqual(bets.map((b) => b.betId), [win.betId]);
    close(bets[0].profit, 11);
    close(bets[0].priceMatched, 2.1);
    close(commission!, 0.55);
    assert.equal((await paper.accountFunds()).balance, 1010.45);
    assert.equal(state.paper.settlements.length, 1);
  });

  test("orders placed while the book already shows a removal are unaffected by it (no removalDate, or clock skew)", async () => {
    for (const removalDate of [undefined, "skewed"]) {
      const { fake, place, paper, clock, order } = setup();
      const [early] = await place([back(101, 3.0, 10, "PERSIST")]);
      clock.t += 10_000;
      // Betfair's clock may run ahead of ours, or the book may carry no removal time at all.
      fake.setRunner(102, { status: "REMOVED", adjustmentFactor: 30, removalDate: removalDate && new Date(clock.t + 60_000).toISOString() });
      await paper.currentOrders();
      clock.t += 10_000;
      const [matched, resting] = await place([back(103, 4.4, 10, "PERSIST"), back(103, 5.0, 10, "PERSIST")]);
      assert.equal(matched.sizeMatched, 10);
      clock.t += 10_000;
      await paper.currentOrders();
      await paper.currentOrders();
      close(order(matched.betId!).fills[0].price, 4.4);
      assert.equal(order(matched.betId!).fills[0].originalPrice, undefined, `removalDate ${removalDate}`);
      assert.equal(order(resting.betId!).sizeLapsed, 0, "an order placed after the removal is not cancelled by it");
      assert.equal((await paper.currentOrders()).find((v) => v.betId === resting.betId)?.status, "EXECUTABLE");
      if (!removalDate) close(order(early.betId!).fills[0].price, 2.1); // the earlier bet is still reduced
    }
  });
});

describe("paper: settlement", () => {
  test("settles from runner statuses with commission on net market winnings, once", async () => {
    const { fake, place, paper, state, markets } = setup();
    const [b, l] = await place([back(101, 3.0, 10), lay(102, 6.2, 10)]);
    fake.settle([101]);
    const { bets, commission } = await paper.settledBets(new Date(0));
    assert.deepEqual(
      bets.map((x) => [x.betId, x.side, x.outcome, x.profit, x.sizeSettled, x.strategy]),
      [
        [b.betId, "BACK", "WON", 20, 10, "Test Strategy"],
        [l.betId, "LAY", "WON", 10, 10, "Test Strategy"], // a lay wins when the selection loses
      ],
    );
    close(bets[0].priceMatched, 3.0);
    close(bets[1].priceMatched, 6.2);
    assert.equal(bets[0].market, "2m Hcap");
    assert.equal(bets[0].selection, "Fast Horse");
    assert.equal(bets[0].eventType, "Horse Racing");
    close(commission!, 1.5);
    const funds = await paper.accountFunds();
    assert.equal(funds.balance, 1028.5);
    assert.equal(funds.settledProfitLoss, 28.5);
    assert.equal(funds.exposure, 0);
    assert.equal(funds.currency, "GBP");
    assert.equal(funds.mode, "paper");
    await markets.getBook(WIN_MARKET);
    await paper.currentOrders();
    assert.equal(state.paper.settlements.length, 1);
    assert.deepEqual(paper.pendingMarketIds(), []);
    assert.deepEqual((await paper.settledBets(new Date(Date.now() + 3600_000))).bets, []);
  });

  test("losing markets pay no commission; PLACED in a non-each-way market is not a win", async () => {
    const { fake, place, paper } = setup();
    await place([back(102, 5.9, 10), lay(103, 4.6, 10), back(101, 3.0, 10)]);
    fake.settle([103]);
    fake.setRunner(101, { status: "PLACED" });
    const { bets, commission } = await paper.settledBets(new Date(0));
    assert.deepEqual(bets.map((b) => [b.outcome, b.profit]), [["LOST", -10], ["LOST", -36], ["LOST", -10]]);
    assert.equal(commission, 0);
    assert.equal((await paper.accountFunds()).balance, 944);
  });

  test("settlement waits while a closed market still has an ACTIVE runner", async () => {
    const { fake, place, paper, order, state } = setup();
    const [b, rest] = await place([back(101, 3.0, 10), lay(101, 2.9, 10)]);
    fake.book().status = "CLOSED";
    fake.setRunner(102, { status: "LOSER" });
    fake.setRunner(103, { status: "LOSER" }); // 101 is still ACTIVE (photo finish)
    const views = await paper.currentOrders();
    assert.deepEqual(views.map((v) => v.betId), [b.betId]);
    assert.equal(order(rest.betId!).sizeLapsed, 10);
    assert.equal(state.paper.settlements.length, 0);
    fake.setRunner(101, { status: "WINNER" });
    assert.deepEqual(await paper.currentOrders(), []);
    assert.equal(order(b.betId!).settlement!.profit, 20);
    assert.equal(state.paper.settlements.length, 1);
  });

  test("a market Betfair stops returning is voided 24 h after its start, releasing exposure", async () => {
    const { fake, place, paper, clock, order, state } = setup();
    const [bet] = await place([back(101, 3.0, 10)]);
    fake.books.delete(WIN_MARKET);
    fake.catalogues.delete(WIN_MARKET);
    const start = Date.parse(fake.startTime);
    clock.t = start + 23 * 3600_000;
    assert.equal((await paper.accountFunds()).exposure, 10);
    assert.equal(order(bet.betId!).settlement, undefined);
    clock.t = start + 25 * 3600_000;
    const funds = await paper.accountFunds();
    assert.equal(funds.exposure, 0);
    assert.equal(funds.balance, 1000);
    const o = order(bet.betId!);
    assert.equal(o.settlement!.outcome, "VOID");
    assert.equal(o.sizeVoided, 10);
    assert.match(String(o.meta!.note), /no longer returns/);
    assert.match(state.paper.settlements[0].note!, /no longer returns/);
    assert.deepEqual(paper.pendingMarketIds(), []);
    assert.deepEqual((await paper.settledBets(new Date(0))).bets, []);
  });

  test("pendingMarketIds lists markets with live orders", async () => {
    const { place, paper } = setup();
    assert.deepEqual(paper.pendingMarketIds(), []);
    const [w] = await place([back(101, 3.5, 10)]);
    await place([back(101, 1.5, 10)], PLACE_MARKET);
    assert.deepEqual(paper.pendingMarketIds().sort(), [WIN_MARKET, PLACE_MARKET].sort());
    await paper.cancelOrders(WIN_MARKET, [w.betId!]);
    assert.deepEqual(paper.pendingMarketIds(), [PLACE_MARKET]);
  });
});

describe("paper: cancelling", () => {
  test("[] cancels nothing, ALL cancels every unmatched order, explicit ids report per id", async () => {
    const { fake, place, paper } = setup();
    const before = fake.calls.length;
    assert.deepEqual(await paper.cancelOrders(WIN_MARKET, []), []);
    assert.equal(fake.calls.length, before);

    const [a, b, c] = await place([back(101, 3.5, 10), back(101, 3.6, 10), back(101, 3.0, 10)]);
    const [other] = await place([back(101, 1.6, 10)], PLACE_MARKET);
    assert.deepEqual(await paper.cancelOrders(WIN_MARKET, [a.betId!, c.betId!, "nope", other.betId!]), [
      { betId: a.betId, sizeCancelled: 10, status: "SUCCESS" },
      { betId: c.betId, sizeCancelled: 0, status: "BET_TAKEN_OR_LAPSED" },
      { betId: "nope", sizeCancelled: 0, status: "INVALID_BET_ID" },
      { betId: other.betId, sizeCancelled: 0, status: "INVALID_BET_ID" },
    ]);
    assert.equal((await paper.cancelOrders(WIN_MARKET, [a.betId!]))[0].status, "BET_TAKEN_OR_LAPSED");
    assert.deepEqual(await paper.cancelOrders(WIN_MARKET, "ALL"), [{ betId: b.betId, sizeCancelled: 10, status: "SUCCESS" }]);
    assert.deepEqual(await paper.cancelOrders(WIN_MARKET, "ALL"), []);
    const views = await paper.currentOrders([WIN_MARKET]);
    assert.deepEqual(views.map((v) => v.betId), [c.betId]);
  });

  test("applies the latest book before cancelling (no free option on a traded-through order)", async () => {
    const { fake, place, paper, view } = setup();
    const [bet] = await place([back(102, 7.0, 10, "PERSIST")]);
    fake.setOffers(102, [[7.2, 50], [7.0, 20]], [[7.4, 50]]);
    fake.trade(102, 7.4, 30);
    const calls = bookCalls(fake);
    assert.deepEqual(await paper.cancelOrders(WIN_MARKET, [bet.betId!]), [{ betId: bet.betId, sizeCancelled: 0, status: "BET_TAKEN_OR_LAPSED" }]);
    assert.equal(bookCalls(fake), calls + 1);
    const v = await view(bet.betId!);
    assert.equal(v!.sizeMatched, 10);
    assert.equal(v!.averagePriceMatched, 7.0);
  });

  test("a failed book fetch does not block the cancel", async () => {
    const { fake, place, paper } = setup();
    const [bet] = await place([back(101, 3.5, 10)]);
    fake.listMarketBook = async () => {
      throw new Error("network down");
    };
    assert.deepEqual(await paper.cancelOrders(WIN_MARKET, "ALL"), [{ betId: bet.betId, sizeCancelled: 10, status: "SUCCESS" }]);
  });
});

describe("paper: persistence", () => {
  test("the ledger, liquidity consumption and bet counter survive a restart through DATA_DIR", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-test-"));
    try {
      const fake = new FakeBetfair();
      const first = State.forDataDir(dir);
      const one = setup({ fake, state: first });
      const [partial, resting] = await one.place([back(101, 3.0, 500), back(101, 3.15, 10, "PERSIST")]);
      assert.equal(partial.sizeMatched, 100);
      first.flush();
      first.release();
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
      assert.equal(saved.paper.orders.length, 2);
      assert.ok(saved.paper.markets[WIN_MARKET].selections["101"].levels["B:3.00"]);

      const second = State.forDataDir(dir);
      try {
        const two = setup({ fake, state: second });
        assert.equal(second.paper.betCounter, 2);
        const views = await two.paper.currentOrders();
        assert.equal(views.find((v) => v.betId === partial.betId)!.sizeMatched, 100, "consumption survives the restart");
        assert.equal(views.find((v) => v.betId === resting.betId)!.persistenceType, "PERSIST");
        assert.equal(two.order(resting.betId!).meta!.queue, 40);
        const [next] = await two.place([back(101, 3.0, 10)]);
        assert.equal(next.sizeMatched, 0, "the restarted engine still sees the 3.0 level as taken");
        assert.notEqual(next.betId, partial.betId);
        assert.notEqual(next.betId, resting.betId);
        assert.equal(second.paper.betCounter, 3);
        fake.trade(101, 3.2, 10); // through every resting back; the lowest-priced (oldest) is first
        assert.equal((await two.view(partial.betId!))!.sizeMatched, 110, "traded-volume baseline survives the restart");
        assert.equal((await two.view(resting.betId!))!.sizeMatched, 0);
        fake.settle([101]);
        const { bets } = await two.paper.settledBets(new Date(0));
        assert.deepEqual(bets.map((b) => [b.betId, b.profit]), [[partial.betId, 220]]);
        assert.equal((await two.paper.accountFunds()).exposure, 0);
      } finally {
        second.flush();
        second.release();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("paper: traded-volume evidence", () => {
  test("volume that also shrinks the displayed level is not counted twice against the queue", async () => {
    const { fake, place, view, order } = setup();
    const [bet] = await place([back(101, 3.1, 20, "PERSIST")]); // rests behind 60 offered at 3.1
    assert.equal(order(bet.betId!).meta!.queue, 60);
    fake.trade(101, 3.1, 40); // layers take 40 of the 60 ahead: 20 are still shown, all of them ahead of us
    fake.setOffers(101, [[3.0, 100]], [[3.05, 80], [3.1, 20], [3.15, 40]]);
    assert.equal((await view(bet.betId!))!.sizeMatched, 0);
    assert.equal(order(bet.betId!).meta!.queue, 20);
    fake.trade(101, 3.1, 30); // the last 20 ahead, then 10 of ours
    fake.setOffers(101, [[3.0, 100]], [[3.05, 80], [3.15, 40]]);
    assert.equal((await view(bet.betId!))!.sizeMatched, 10);
    assert.equal(order(bet.betId!).meta!.queue, 0);
  });

  test("volume first seen in a suspended book counts, and its empty ladder is not an empty queue", async () => {
    const { fake, place, view, order } = setup();
    const [bet] = await place([back(101, 3.1, 20, "PERSIST")]); // behind 60 at 3.1
    const reopen = (lay: Array<[number, number]>) => {
      fake.book().status = "OPEN";
      fake.setOffers(101, [[3.0, 100]], lay);
    };
    const suspend = () => {
      fake.book().status = "SUSPENDED"; // suspended books often show no offers
      fake.setOffers(101, [], []);
    };
    fake.trade(101, 3.1, 40);
    suspend();
    assert.equal((await view(bet.betId!))!.sizeMatched, 0);
    assert.equal(order(bet.betId!).meta!.queue, 20, "the 40 traded before the suspension cleared part of the queue");
    reopen([[3.05, 80], [3.1, 20], [3.15, 40]]);
    assert.equal((await view(bet.betId!))!.sizeMatched, 0);
    fake.trade(101, 3.1, 30);
    suspend();
    assert.equal((await view(bet.betId!))!.sizeMatched, 10);
    reopen([[3.05, 80], [3.15, 40]]);
    assert.equal((await view(bet.betId!))!.sizeMatched, 10, "the same volume does not fill twice");
  });

  test("in-play volume first seen in a suspended or closed book fills a resting order before it settles", async () => {
    for (const suspendedPoll of [true, false]) {
      const { fake, place, paper, order } = setup();
      fake.book().inplay = true;
      fake.setOffers(101, [[3.0, 100]], [[3.05, 80]]);
      const [bet] = await place([lay(101, 2.0, 50, "PERSIST")]);
      assert.equal(bet.sizeMatched, 0);
      fake.trade(101, 1.5, 500); // the horse surges through the lay before the market suspends at the line
      fake.trade(101, 1.01, 2000);
      if (suspendedPoll) {
        fake.book().status = "SUSPENDED";
        fake.setOffers(101, [], []);
        await paper.currentOrders();
      }
      fake.settle([101]);
      await paper.currentOrders();
      const o = order(bet.betId!);
      assert.deepEqual(o.fills.map((f) => [f.price, f.size]), [[2.0, 50]], `suspended poll: ${suspendedPoll}`);
      assert.equal(o.sizeLapsed, 0);
      assert.equal(o.settlement!.outcome, "LOST");
      assert.equal(o.settlement!.profit, -50);
    }
  });

  test("LAPSE orders get volume seen in a pre-off book, but not volume first seen in-play (it cannot be dated)", async () => {
    const { fake, place, view, order } = setup();
    const [dated, undated] = await place([back(101, 3.5, 10), back(103, 5.0, 10)]);
    fake.trade(101, 3.6, 100); // drifts through the back just before the off
    fake.book().status = "SUSPENDED"; // the suspension at the off, still pre-off
    assert.equal((await view(dated.betId!))?.sizeMatched, 10);
    assert.deepEqual(order(dated.betId!).fills.map((f) => [f.price, f.size]), [[3.5, 10]]);
    fake.book().status = "OPEN";
    fake.trade(103, 5.1, 100); // before or after the off: the first in-play book cannot tell
    fake.book().inplay = true;
    assert.equal(await view(undated.betId!), undefined);
    assert.equal(order(undated.betId!).sizeLapsed, 10);
    assert.deepEqual(order(undated.betId!).fills, []);
  });
});

describe("paper: out-of-order books", () => {
  test("a book fetched before an order was placed but processed after it never fills the order", async () => {
    const { fake, markets, place, order } = setup();
    fake.setOffers(101, [[3.2, 50], [3.0, 100]], [[3.25, 80]]);
    const original = fake.listMarketBook.bind(fake);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fake.listMarketBook = async (args) => {
      fake.listMarketBook = original;
      const books = await original(args); // the snapshot is taken when the request is made
      await gate;
      return books;
    };
    const slowPoll = markets.getBooks([WIN_MARKET], { depth: 1 }); // e.g. a recorder poll whose response is late
    fake.setOffers(101, [[3.0, 100]], [[3.05, 80]]); // the 3.2 offers are gone
    const [bet] = await place([back(101, 3.2, 20, "PERSIST")]);
    assert.equal(bet.sizeMatched, 0);
    release();
    await slowPoll;
    assert.deepEqual(order(bet.betId!).fills, []);
  });

  test("a book older than an order's placement book is ignored, even after a restart", async () => {
    const fake = new FakeBetfair();
    const state = new State();
    const first = setup({ fake, state });
    fake.book().version = 7;
    const [bet] = await first.place([back(101, 3.2, 20, "PERSIST")]);
    assert.equal(first.order(bet.betId!).bookVersion, 7);
    // A new process has no book history; a lagging server answers with the market as it was before the order.
    const second = setup({ fake, state });
    fake.book().version = 6;
    fake.setOffers(101, [[3.2, 50], [3.0, 100]], [[3.25, 80]]);
    assert.equal((await second.view(bet.betId!))!.sizeMatched, 0);
    fake.book().version = 7;
    assert.equal((await second.view(bet.betId!))!.sizeMatched, 20);
  });
});

describe("paper: dead heats and commission", () => {
  test("a dead heat divides the stake: the winners' share is settled as a win, the rest as a loss", async () => {
    const backs = setup();
    const [b] = await backs.place([back(101, 3.0, 10)]);
    backs.fake.settle([101, 103]); // two winners of a one-winner market
    const settledBack = await backs.paper.settledBets(new Date(0));
    close(settledBack.bets[0].profit, 5); // 10 x 2 x 1/2 - 10 x 1/2
    assert.equal(settledBack.bets[0].outcome, "WON");
    close(settledBack.commission!, 0.25);
    assert.match(String(backs.order(b.betId!).meta!.note), /Dead heat/);

    const lays = setup();
    await lays.place([lay(103, 4.6, 10)]);
    lays.fake.settle([101, 103]);
    close((await lays.paper.settledBets(new Date(0))).bets[0].profit, -13); // -(10 x 3.6 x 1/2) + 10 x 1/2

    const places = setup();
    await places.place([back(102, 2.38, 10)], PLACE_MARKET);
    places.fake.settle([101, 102, 103], PLACE_MARKET); // three WINNERs for two places: each keeps 2/3
    close((await places.paper.settledBets(new Date(0))).bets[0].profit, (13.8 * 2) / 3 - 10 / 3);
  });

  test("a winner is paid in full whatever its non-runner adjustment factor", async () => {
    const { fake, place, paper } = setup();
    await place([back(101, 3.0, 10)]);
    fake.setRunner(101, { adjustmentFactor: 33.3 }); // Betfair publishes every horse's reduction factor
    fake.settle([101]);
    assert.equal((await paper.settledBets(new Date(0))).bets[0].profit, 20);
  });

  test("commission is charged at the market's base rate, else at the configured rate", async () => {
    const high = setup();
    high.fake.catalogues.get(WIN_MARKET)!.description!.marketBaseRate = 10;
    const [bet] = await high.place([back(101, 3.0, 10)]);
    assert.equal(high.order(bet.betId!).marketBaseRate, 10);
    high.fake.settle([101]);
    close((await high.paper.settledBets(new Date(0))).commission!, 2);
    assert.equal(high.state.paper.settlements[0].commissionRate, 0.1);
    assert.equal((await high.paper.accountFunds()).balance, 1018);

    const unknown = setup({ options: { commissionRate: 0.02 } });
    delete unknown.fake.catalogues.get(WIN_MARKET)!.description!.marketBaseRate;
    await unknown.place([back(101, 3.0, 10)]);
    unknown.fake.settle([101]);
    close((await unknown.paper.settledBets(new Date(0))).commission!, 0.4);
  });
});
