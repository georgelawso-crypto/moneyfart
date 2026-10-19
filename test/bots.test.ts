import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { currencyRules, type CurrencyRules } from "../src/betfair/currency.js";
import { offsetTicks } from "../src/betfair/ticks.js";
import type { Side } from "../src/betfair/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { betOutcomeProfit } from "../src/exchange/math.js";
import type { CancelResult, Exchange, FundsView, OrderRequest, OrderView, PlacedBet, SettledBets, StrategyTag } from "../src/exchange/types.js";
import { formatSelectionId } from "../src/format.js";
import { MarketService } from "../src/markets.js";
import { Recorder } from "../src/recorder.js";
import { State } from "../src/state.js";
import { BotRunner } from "../src/strategies/bots.js";
import type { BotState } from "../src/strategies/botTypes.js";
import { StrategyEngine } from "../src/strategies/engine.js";
import type { ExecutionResult } from "../src/strategies/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

// ---------------------------------------------------------------- in-test exchange

interface FakeOrder {
  betId: string;
  marketId: string;
  selectionId: number;
  handicap: number;
  side: Side;
  price: number;
  size: number;
  matched: number;
  matchedValue: number;
  cancelled: number;
  persistenceType: string;
  tag: StrategyTag;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** Records orders; fills at the requested price (fully by default); configurable fills, failures and cancels. */
class FakeExchange implements Exchange {
  readonly mode = "paper" as const;
  orders: FakeOrder[] = [];
  placed: Array<{ marketId: string; orders: OrderRequest[]; tag: StrategyTag }> = [];
  cancelCalls: Array<{ marketId: string; betIds: string[] | "ALL" }> = [];
  currentOrdersCalls = 0;
  fill: number | ((order: OrderRequest) => number) = 1;
  failNext: string[] = [];
  unknownNext = 0;
  /** currentOrders throws this many times. */
  failCurrentOrders = 0;
  cancelStatus?: (betId: string) => string | undefined;
  /** Awaited before each placement (to hold a request in flight). */
  beforePlace?: (orders: OrderRequest[]) => Promise<void>;
  rules: CurrencyRules = currencyRules("GBP");
  private counter = 0;

  async currencyRules() {
    return this.rules;
  }

  async placeOrders(marketId: string, orders: OrderRequest[], tag: StrategyTag): Promise<PlacedBet[]> {
    await this.beforePlace?.(orders);
    this.placed.push({ marketId, orders: structuredClone(orders), tag });
    return orders.map((o) => {
      const base = { selectionId: formatSelectionId(o.selectionId, o.handicap), side: o.side, price: o.price, size: o.size };
      if (this.failNext.length) return { ...base, status: "FAILURE" as const, errorCode: this.failNext.shift() };
      if (this.unknownNext > 0) {
        this.unknownNext--;
        return { ...base, status: "UNKNOWN" as const, errorCode: "TIMEOUT_UNCONFIRMED" };
      }
      const fraction = typeof this.fill === "function" ? this.fill(o) : this.fill;
      const matched = cents(o.size * fraction);
      const order: FakeOrder = {
        betId: `F${++this.counter}`,
        marketId,
        selectionId: o.selectionId,
        handicap: o.handicap,
        side: o.side,
        price: o.price,
        size: o.size,
        matched,
        matchedValue: matched * o.price,
        cancelled: 0,
        persistenceType: o.persistenceType,
        tag,
      };
      this.orders.push(order);
      return { ...base, status: "SUCCESS" as const, betId: order.betId, sizeMatched: matched, averagePriceMatched: matched ? o.price : undefined };
    });
  }

  remaining(o: FakeOrder) {
    return cents(o.size - o.matched - o.cancelled);
  }

  match(betId: string, size?: number) {
    const o = this.orders.find((x) => x.betId === betId)!;
    const amount = Math.min(size ?? this.remaining(o), this.remaining(o));
    o.matched = cents(o.matched + amount);
    o.matchedValue += amount * o.price;
  }

  async cancelOrders(marketId: string, betIds: string[] | "ALL"): Promise<CancelResult[]> {
    this.cancelCalls.push({ marketId, betIds: Array.isArray(betIds) ? [...betIds] : betIds });
    const ids = betIds === "ALL" ? this.orders.filter((o) => o.marketId === marketId && this.remaining(o) > 0).map((o) => o.betId) : betIds;
    return ids.map((betId) => {
      const o = this.orders.find((x) => x.betId === betId && x.marketId === marketId);
      if (!o) return { betId, sizeCancelled: 0, status: "INVALID_BET_ID" };
      const forced = this.cancelStatus?.(betId);
      if (forced) return { betId, sizeCancelled: 0, status: forced };
      const left = this.remaining(o);
      if (left <= 0) return { betId, sizeCancelled: 0, status: "BET_TAKEN_OR_LAPSED" };
      o.cancelled = cents(o.cancelled + left);
      return { betId, sizeCancelled: left, status: "SUCCESS" };
    });
  }

  async currentOrders(marketIds?: string[]): Promise<OrderView[]> {
    this.currentOrdersCalls++;
    if (this.failCurrentOrders > 0) {
      this.failCurrentOrders--;
      throw new Error("Betfair is unavailable");
    }
    return this.orders
      .filter((o) => !marketIds || marketIds.includes(o.marketId))
      .map((o) => ({
        betId: o.betId,
        marketId: o.marketId,
        selectionId: formatSelectionId(o.selectionId, o.handicap),
        side: o.side,
        price: o.price,
        size: o.size,
        sizeMatched: o.matched,
        averagePriceMatched: o.matched ? o.matchedValue / o.matched : undefined,
        sizeRemaining: this.remaining(o),
        status: this.remaining(o) > 0 ? ("EXECUTABLE" as const) : ("EXECUTION_COMPLETE" as const),
        persistenceType: o.persistenceType,
        placedDate: new Date().toISOString(),
        strategy: o.tag.name,
      }));
  }

  async accountFunds(): Promise<FundsView> {
    return { mode: "paper", currency: "GBP", availableToBetBalance: 1000, exposure: 0 };
  }

  async settledBets(): Promise<SettledBets> {
    return { bets: [] };
  }

  pendingMarketIds(): string[] {
    return [];
  }

  sent(skip = 0): OrderRequest[] {
    return this.placed.slice(skip).flatMap((p) => p.orders);
  }
}

// ---------------------------------------------------------------- fixture

const W = WIN_MARKET;
const sel = (selectionId: number) => ({ selectionId, handicap: 0 });

function setup(options: { limits?: Partial<Config["trading"]>; state?: State; fake?: FakeBetfair; exchange?: FakeExchange } = {}) {
  const fake = options.fake ?? new FakeBetfair();
  const state = options.state ?? new State();
  const markets = new MarketService(fake, state, new Recorder(), 20);
  const exchange = options.exchange ?? new FakeExchange();
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const limits = { ...loadConfig({}).trading, ...options.limits };
  const bots = new BotRunner({ markets, exchange, state, limits, now });
  const engine = new StrategyEngine({ markets, exchange, state, limits, bots, now, sleep: async (ms) => void (clock.t += ms) });
  return { fake, state, markets, exchange, bots, engine, clock, start: Date.parse(fake.startTime) };
}

type Fixture = ReturnType<typeof setup>;

async function started(f: Fixture, name: string, selectionId = 101, overrides: Record<string, unknown> = {}): Promise<{ result: ExecutionResult; bot: () => BotState }> {
  const result = await f.engine.execute(name, W, [sel(selectionId)], overrides);
  assert.ok(result.botId, JSON.stringify({ outcome: result.outcome, message: result.message, messages: result.messages }));
  return { result, bot: () => f.bots.list().find((b) => b.id === result.botId)! };
}

async function position(exchange: FakeExchange, selectionId = 101, betIds?: string[]) {
  const orders = (await exchange.currentOrders([W])).filter((o) => o.selectionId === String(selectionId) && (!betIds || betIds.includes(o.betId)));
  let ifWin = 0;
  let ifLose = 0;
  for (const o of orders) {
    if (!o.sizeMatched) continue;
    ifWin += betOutcomeProfit(o.side, o.averagePriceMatched!, o.sizeMatched, true);
    ifLose += betOutcomeProfit(o.side, o.averagePriceMatched!, o.sizeMatched, false);
  }
  return { ifWin, ifLose };
}

const logText = (bot: BotState) => bot.log.map((l) => l.message).join("\n");

// ---------------------------------------------------------------- trading lifecycle

describe("Place Bet and Close Selection Bet Position bots", () => {
  test("Trade x profit: entry matched, price moves, the percentage target closes with an equal profit", async () => {
    const f = setup();
    const { result, bot } = await started(f, "Trade x profit");
    assert.deepEqual(f.exchange.sent().map((o) => [o.side, o.price, o.size]), [["BACK", 3, 10]]);
    await f.bots.tick();
    assert.equal(bot().status, "running", "-1.6% of the opening risk: no target yet");
    assert.equal(f.exchange.placed.length, 1);

    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    const [close] = f.exchange.sent(1);
    assert.deepEqual([close.side, close.price, close.size, close.reducesRisk], ["LAY", 2.6, 11.54, true]);
    assert.deepEqual(f.exchange.placed[1].tag, f.exchange.placed[0].tag, "same strategy reference");
    assert.equal(bot().status, "finished");
    assert.match(logText(bot()), /Closing: profit 15\.4% of the opening risk 10 reached the target 10%/);
    assert.match(logText(bot()), /Position closed/);
    const p = await position(f.exchange);
    assert.ok(Math.abs(p.ifWin - p.ifLose) < 0.01 && p.ifWin > 1.5, JSON.stringify(p));
    assert.deepEqual(bot().betIds, [result.bets[0].betId, "F2"]);
    assert.deepEqual(f.bots.marketIds(), []);
  });

  test("percentage loss target (Back Trade: 20% profit / 10% loss)", async () => {
    const f = setup();
    const { bot } = await started(f, "Back Trade");
    f.fake.setOffers(101, [[3.45, 100]], [[3.5, 100]]);
    await f.bots.tick();
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 3.5, 8.57]]);
    assert.match(logText(bot()), /loss 14\.3% of the opening risk 10 reached the limit 10%/);
    assert.equal(bot().status, "finished");
  });

  test("percentage of a lay entry's liability", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit", 101, { "OpenBetPosition.BetType": "Lay" });
    assert.deepEqual(f.exchange.sent().map((o) => [o.side, o.price, o.size]), [["LAY", 3.05, 4.87]]);
    f.fake.setOffers(101, [[3.8, 100]], [[3.85, 100]]);
    await f.bots.tick();
    assert.equal(bot().status, "running", "9.6% of the 9.98 liability");
    f.fake.setOffers(101, [[3.9, 100]], [[3.95, 100]]);
    await f.bots.tick();
    assert.match(logText(bot()), /profit 10\.6% of the opening risk 9\.98 reached the target 10%/);
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["BACK", 3.9, 3.81]]);
  });

  test("money targets and a lay entry", async () => {
    const f = setup();
    const { bot } = await started(f, "Lay Trade", 101, { "CloseBetPosition.ProfitLossType": "Money", "CloseBetPosition.Profit": 1, "CloseBetPosition.Loss": 0 });
    assert.deepEqual(f.exchange.sent().map((o) => [o.side, o.price, o.size]), [["LAY", 3.05, 10]]);
    f.fake.setOffers(101, [[3.3, 100]], [[3.35, 100]]);
    await f.bots.tick();
    // Lay 10 @ 3.05 hedged with a back 10 x 3.05 / 3.3 = 9.24 @ 3.3: about 0.76 each way, below the 1 target.
    assert.equal(bot().status, "running");
    f.fake.setOffers(101, [[3.45, 100]], [[3.5, 100]]);
    await f.bots.tick();
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["BACK", 3.45, 8.84]]);
    const p = await position(f.exchange);
    assert.ok(Math.abs(p.ifWin - p.ifLose) < 0.02 && p.ifWin >= 1, JSON.stringify(p));
  });

  test("closes before the off at ClosePositionTimeSpan regardless of profit (injected clock)", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit");
    f.clock.t = f.start - 6000;
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 1, "not yet: 6 s before the off");
    f.clock.t = f.start - 5000;
    await f.bots.tick();
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 3.05, 9.84]]);
    assert.match(logText(bot()), /close time reached \(-00:00:05 from the start\)/);
    assert.equal(bot().status, "finished");
  });

  test("re-prices an unmatched closing bet after BetMatchingTimeout", async () => {
    const f = setup();
    f.exchange.fill = (o) => (o.reducesRisk ? 0 : 1);
    const { bot } = await started(f, "Trade x profit");
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 2.6, 11.54]]);
    assert.equal(bot().meta!.phase, "closing");

    f.clock.t += 4000;
    f.fake.setOffers(101, [[2.62, 100]], [[2.64, 100]]);
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 2, "younger than 5 s: left to match");
    assert.equal(f.exchange.cancelCalls.length, 0);

    f.clock.t += 1000;
    await f.bots.tick();
    assert.deepEqual(f.exchange.cancelCalls, [{ marketId: W, betIds: ["F2"] }]);
    assert.deepEqual(f.exchange.sent(2).map((o) => [o.side, o.price, o.size]), [["LAY", 2.64, 11.36]], "re-placed at the new best price");

    // Half of the second close matches before it goes stale: the next close covers only the rest.
    f.exchange.match("F3", 5);
    f.exchange.fill = 1;
    f.clock.t += 5000;
    await f.bots.tick();
    assert.deepEqual(f.exchange.cancelCalls.at(-1), { marketId: W, betIds: ["F3"] });
    const [last] = f.exchange.sent(3);
    assert.deepEqual([last.side, last.price, last.size], ["LAY", 2.64, 6.36]);
    assert.equal(bot().status, "finished");
    const p = await position(f.exchange);
    assert.ok(Math.abs(p.ifWin - p.ifLose) < 0.01, JSON.stringify(p));
  });

  test("a residual below Betfair's minimum bet finishes the bot with a note", async () => {
    const f = setup();
    f.exchange.fill = (o) => (o.reducesRisk ? 1 : 0.1);
    const { bot } = await started(f, "Trade 2 Ticks Profit or 10 Ticks Loss");
    assert.deepEqual(f.exchange.sent().map((o) => [o.side, o.price, o.size]), [["BACK", 3, 2]]);
    f.fake.setOffers(101, [[2.92, 100]], [[2.94, 100]]);
    await f.bots.tick();
    assert.deepEqual(f.exchange.cancelCalls, [{ marketId: W, betIds: ["F1"] }], "the unmatched entry remainder is cancelled first");
    assert.equal(f.exchange.placed.length, 1, "the 0.2 hedge is below the minimum and is not sent");
    assert.equal(bot().status, "finished");
    assert.match(logText(bot()), /needs LAY 0\.2 @ 2\.94: .*INVALID_BET_SIZE.*Left open/);
  });

  test("ticks targets: profit and loss for a back entry, profit for a lay entry", async () => {
    const f = setup();
    const three = await started(f, "Trade 3 ticks");
    f.fake.setOffers(101, [[2.94, 100]], [[2.96, 100]]);
    await f.bots.tick();
    assert.equal(three.bot().status, "running", "2 ticks");
    f.fake.setOffers(101, [[2.92, 100]], [[2.94, 100]]);
    await f.bots.tick();
    assert.match(logText(three.bot()), /price 2\.94 is 3 ticks in our favour from 3 \(target 3\)/);
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 2.94, 10.2]]);

    const g = setup();
    const loss = await started(g, "Trade 2 Ticks Profit or 10 Ticks Loss");
    g.fake.setOffers(101, [[3.45, 100]], [[3.5, 100]]);
    await g.bots.tick();
    assert.match(logText(loss.bot()), /price 3\.5 is 10 ticks against us from 3 \(limit 10\)/);
    assert.deepEqual(g.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 3.5, 1.71]]);

    const h = setup();
    const lay = await started(h, "Trade 3 ticks", 101, { "OpenBetPosition.BetType": "Lay" });
    assert.deepEqual(h.exchange.sent().map((o) => [o.side, o.price, o.size]), [["LAY", 3.05, 4.87]]);
    h.fake.setOffers(101, [[3.2, 100]], [[3.25, 100]]);
    await h.bots.tick();
    assert.deepEqual(h.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["BACK", 3.2, 4.64]]);
    assert.equal(lay.bot().status, "finished");
  });

  test("CheckingLastPriceTraded evaluates the targets on the last traded price", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade 3 ticks", 101, { CheckingLastPriceTraded: true });
    f.fake.setOffers(101, [[2.9, 100]], [[2.92, 100]]);
    await f.bots.tick();
    assert.equal(bot().status, "running", "best prices moved but the last traded price is still 3");
    f.fake.trade(101, 2.94, 20);
    await f.bots.tick();
    assert.match(logText(bot()), /price 2\.94 is 3 ticks in our favour/);
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price]), [["LAY", 2.92]], "closed at the best lay price");
  });

  test("HedgingEnabled false closes by offsetting the matched stake", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit", 101, { "CloseBetPosition.HedgingEnabled": false });
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 2.6, 10]]);
    assert.equal(bot().status, "finished");
    const p = await position(f.exchange);
    assert.ok(Math.abs(p.ifLose) < 0.01 && p.ifWin > 3.9);
  });

  test("ClosePositionImmediately closes as soon as the entry is matched", async () => {
    const f = setup();
    f.exchange.fill = (o) => (o.reducesRisk ? 1 : 0);
    const { bot } = await started(f, "Trade x profit", 101, { "CloseBetPosition.ClosePositionImmediately": true });
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 1, "entry not matched yet");
    assert.match(logText(bot()), /Waiting for the entry to match/);
    f.exchange.match("F1");
    await f.bots.tick();
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 3.05, 9.84]]);
    assert.equal(bot().status, "finished");
  });

  test("an entry that never matches lapses at the off (AtInPlayKeepBet false)", async () => {
    const f = setup();
    f.exchange.fill = 0;
    const { bot } = await started(f, "Back Trade");
    await f.bots.tick();
    assert.equal(bot().status, "running");
    f.fake.book().inplay = true;
    await f.bots.tick();
    assert.equal(bot().status, "finished");
    assert.match(logText(bot()), /turned in-play with the entry unmatched/);
    assert.deepEqual(f.exchange.cancelCalls, [{ marketId: W, betIds: ["F1"] }]);
  });

  test("an unmatched entry is cancelled when the close time arrives", async () => {
    const f = setup();
    f.exchange.fill = 0;
    const { bot } = await started(f, "Trade x profit");
    f.clock.t = f.start - 1000;
    await f.bots.tick();
    assert.equal(bot().status, "finished");
    assert.match(logText(bot()), /close time was reached before the entry was matched/);
    assert.equal(f.exchange.orders[0].cancelled, 10);
  });

  test("the position is the bot's own bets only", async () => {
    const f = setup();
    await f.exchange.placeOrders(W, [{ selectionId: 101, handicap: 0, side: "BACK", price: 3, size: 20, persistenceType: "LAPSE" }], { name: "other", ref: "other" });
    await started(f, "Trade x profit");
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    assert.equal(f.exchange.sent(2)[0].size, 11.54, "hedges the bot's 10, not the other 20");
  });

  test("never hedges the bot's part again when other bets already closed the selection", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit");
    const closed = await f.engine.execute("Close Selection Bet Position", W, [sel(101)]);
    assert.equal(closed.outcome, "Executed");
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 2, "no second hedge");
    assert.equal(bot().status, "finished");
    assert.match(logText(bot()), /Other bets already closed the selection's position/);

    const g = setup();
    const partial = await started(g, "Trade x profit");
    await g.exchange.placeOrders(W, [{ selectionId: 101, handicap: 0, side: "LAY", price: 3, size: 5, persistenceType: "LAPSE" }], { name: "manual", ref: "manual" });
    g.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await g.bots.tick();
    assert.deepEqual(g.exchange.sent(2).map((o) => [o.side, o.price, o.size]), [["LAY", 2.6, 5.77]], "only what the selection still needs");
    assert.match(logText(partial.bot()), /hedging 5\.77 instead of 11\.54/);
    const p = await position(g.exchange);
    assert.ok(Math.abs(p.ifWin - p.ifLose) < 0.02, "the selection is green");
  });

  test("a manual close waits for a bot that is closing, so the selection is hedged once", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit");
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.exchange.beforePlace = (orders) => (orders[0].reducesRisk ? gate : Promise.resolve());
    const tick = f.bots.tick(); // stops inside the bot's closing placeOrders
    await new Promise((resolve) => setImmediate(resolve));
    const close = f.engine.execute("Close Selection Bet Position", W, [sel(101)]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await tick;
    const result = await close;
    assert.equal(bot().status, "finished");
    assert.equal(result.outcome, "Skipped", JSON.stringify(result.messages));
    assert.match(result.message!, /already flat/);
    assert.equal(f.exchange.sent(1).length, 1, "one hedge in total");
  });

  test("an unknown closing-bet outcome stops the bot instead of hedging twice", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit");
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    f.exchange.unknownNext = 1;
    await f.bots.tick();
    assert.equal(bot().status, "failed");
    assert.match(logText(bot()), /outcome is unknown.*avoid hedging twice/);
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 2);
  });
});

describe("other bots", () => {
  test("Trailing Stop Loss follows the best price and closes Loss ticks back from it", async () => {
    const f = setup();
    await f.engine.execute("Bet 10 Euro", W, [sel(101)]);
    const { bot } = await started(f, "Trailing Stop Loss 3 Ticks");
    assert.match(logText(bot()), /starting from the price 3\.05/);
    await f.bots.tick();
    f.fake.setOffers(101, [[2.88, 100]], [[2.9, 100]]);
    await f.bots.tick();
    f.fake.setOffers(101, [[2.92, 100]], [[2.94, 100]]);
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 1, "2 ticks back from 2.9");
    f.fake.setOffers(101, [[2.94, 100]], [[2.96, 100]]);
    await f.bots.tick();
    assert.match(logText(bot()), /trailing stop: price 2\.96 is 3 ticks back from the best 2\.9/);
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size, o.reducesRisk]), [["LAY", 2.96, 10.14, true]]);
    assert.equal(bot().status, "finished");
  });

  test("Trailing Stop Loss on a lay position and through Back trailing stop loss trading", async () => {
    const f = setup();
    await f.engine.execute("Lay 10 Euro", W, [sel(101)]);
    const { bot } = await started(f, "Trailing Stop Loss 3 Ticks");
    f.fake.setOffers(101, [[3.3, 100]], [[3.35, 100]]);
    await f.bots.tick();
    f.fake.setOffers(101, [[3.15, 100]], [[3.2, 100]]);
    await f.bots.tick();
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price]), [["BACK", 3.15]]);
    assert.equal(bot().status, "finished");

    const g = setup();
    const sequence = await g.engine.execute("Back trailing stop loss trading", W, [sel(101)]);
    assert.equal(sequence.outcome, "Started");
    g.fake.setOffers(101, [[3.1, 100]], [[3.2, 100]]);
    await g.bots.tick();
    assert.deepEqual(g.exchange.sent(1).map((o) => [o.side, o.price]), [["LAY", 3.2]], "3 ticks back from the starting 3.05");
  });

  test("a trailing stop waits for an unmatched entry, then finishes when the position is closed elsewhere", async () => {
    const f = setup();
    f.exchange.fill = 0;
    await f.engine.execute("Bet 10 Euro", W, [sel(101)]);
    const { bot } = await started(f, "Trailing Stop Loss 3 Ticks");
    await f.bots.tick();
    assert.match(logText(bot()), /Waiting for a matched position/);
    f.exchange.match("F1");
    await f.bots.tick();
    assert.match(logText(bot()), /Trailing from/);
    f.exchange.fill = 1;
    await f.engine.execute("Close Selection Bet Position", W, [sel(101)]);
    await f.bots.tick();
    assert.equal(bot().status, "finished");
    assert.match(logText(bot()), /position is flat/);
  });

  test("Close Selection Bet Position on targets manages the whole selection position", async () => {
    const f = setup();
    await f.engine.execute("Bet 10 Euro", W, [sel(101)]);
    await f.engine.execute("Bet 10 Euro", W, [sel(101)], { Odds: 3.1 });
    const { bot } = await started(f, "Close Selection Bet Position", 101, { ClosePositionImmediately: false, ProfitLossType: "Money", Profit: 2 });
    f.fake.setOffers(101, [[2.7, 100]], [[2.72, 100]]);
    await f.bots.tick();
    // Back 10 @ 3 + back 10 @ 3.1: green-up at 2.72 locks 61 / 2.72 - 20 = 2.43.
    assert.deepEqual(f.exchange.sent(2).map((o) => [o.side, o.price, o.size]), [["LAY", 2.72, 22.43]]);
    assert.equal(bot().status, "finished");
  });

  test("resting bets on the hedge side block a selection bot's hedge (CancelUnmatchedBets false)", async () => {
    const f = setup();
    await f.engine.execute("Bet 10 Euro", W, [sel(101)]);
    f.exchange.fill = 0;
    await f.engine.execute("Lay 10 Euro", W, [sel(101)], { Odds: 2.5 });
    f.exchange.fill = 1;
    const { bot } = await started(f, "Close Selection Bet Position", 101, { ClosePositionImmediately: false, CancelUnmatchedBets: false, ProfitLossType: "Money", Profit: 1 });
    f.fake.setOffers(101, [[2.68, 100]], [[2.7, 100]]);
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 2);
    assert.equal(f.exchange.cancelCalls.length, 0);
    assert.match(logText(bot()), /Unmatched LAY bet\(s\) F2 .*would over-hedge/);
    assert.equal(bot().status, "running");
  });

  test("PlaceBetTimeSpan delays a bet until its time", async () => {
    const f = setup();
    const result = await f.engine.execute("Bet 10 Euro", W, [sel(101)], { PlaceBetTimeSpan: "-0:05:00" });
    assert.equal(result.outcome, "Started");
    assert.equal(result.status, true);
    assert.equal(f.exchange.placed.length, 0);
    const bot = () => f.bots.list()[0];
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 0);
    assert.match(logText(bot()), /Waiting to place the bet at/);
    f.clock.t = f.start - 300_000;
    await f.bots.tick();
    assert.deepEqual(f.exchange.sent().map((o) => [o.side, o.price, o.size]), [["BACK", 3, 10]]);
    assert.equal(bot().status, "finished");

    // Already past the time: placed at once.
    const late = await f.engine.execute("Bet 10 Euro", W, [sel(101)], { PlaceBetTimeSpan: "-0:10:00" });
    assert.equal(late.outcome, "Executed");
  });

  test("a delayed trade opens at its time and is then managed", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit", 101, { "OpenBetPosition.PlaceBetTimeSpan": "-0:10:00" });
    assert.equal(f.exchange.placed.length, 0);
    f.clock.t = f.start - 600_000;
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 1);
    assert.equal(bot().meta!.phase, "open");
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    assert.equal(bot().status, "finished");
    assert.equal(f.exchange.sent(1)[0].size, 11.54);
  });

  test("a delayed trade that would open after its close time is refused", async () => {
    const f = setup();
    const result = await f.engine.execute("Trade x profit", W, [sel(101)], { "OpenBetPosition.PlaceBetTimeSpan": "-0:00:02" });
    assert.equal(result.status, false);
    assert.match(result.message!, /would close before it opens/);
    assert.equal(f.bots.list().length, 0);
  });

  test("a delayed bet is dropped when the market turns in-play and AllowPlacingBetInPlay is false", async () => {
    const f = setup();
    const { bot } = await started(f, "Bet 10 Euro", 101, { PlaceBetTimeSpan: "00:01:00", AllowPlacingBetInPlay: false });
    f.fake.book().inplay = true;
    await f.bots.tick();
    assert.equal(bot().status, "finished");
    assert.equal(f.exchange.placed.length, 0);
  });

  test("Fill or Kill (delayed) cancels the unmatched part after BetMatchingTimeout", async () => {
    const f = setup();
    f.exchange.fill = 0.5;
    const { bot } = await started(f, "Bet 10 Euro Fill or Kill", 101, { PlaceBetTimeSpan: "-0:05:00" });
    f.clock.t = f.start - 300_000;
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 1);
    f.clock.t += 3000;
    await f.bots.tick();
    assert.equal(f.exchange.cancelCalls.length, 0);
    f.clock.t += 2000;
    await f.bots.tick();
    assert.deepEqual(f.exchange.cancelCalls, [{ marketId: W, betIds: ["F1"] }]);
    assert.equal(bot().status, "finished");
    assert.match(logText(bot()), /matched 5; cancelled 5 unmatched/);
  });
});

describe("bot runner", () => {
  test("running bots persist and resume after a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-"));
    const first = State.forDataDir(dir);
    const f = setup({ state: first });
    const { result } = await started(f, "Trade x profit");
    first.flush();
    first.release();

    const second = State.forDataDir(dir);
    const g = setup({ state: second, fake: f.fake, exchange: f.exchange });
    assert.deepEqual(g.bots.marketIds(), [W]);
    const [resumed] = g.bots.list({ status: "running" });
    assert.equal(resumed.id, result.botId);
    assert.equal(resumed.meta!.phase, "open");
    g.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await g.bots.tick();
    assert.equal(g.bots.list()[0].status, "finished");
    assert.equal(f.exchange.sent(1)[0].size, 11.54);
    second.release();
  });

  test("stop with closePosition greens up; stop without it leaves the position", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit");
    f.fake.setOffers(101, [[3.15, 100]], [[3.2, 100]]);
    const stopped = await f.bots.stop(bot().id, { closePosition: true });
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(f.exchange.sent(1).map((o) => [o.side, o.price, o.size, o.reducesRisk]), [["LAY", 3.2, 9.38, true]]);
    assert.match(logText(stopped), /Stopped by request; closing the position[\s\S]*Position closed \(stopped by request\)/);
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 2, "a stopped bot does nothing");

    const g = setup();
    const other = await started(g, "Trade x profit");
    const kept = await g.bots.stop(other.bot().id);
    assert.equal(kept.status, "stopped");
    assert.equal(g.exchange.placed.length, 1);
    await assert.rejects(() => g.bots.stop("bot-nope"), /Bot "bot-nope" not found/);
  });

  test("stop cancels the bot's resting closing bet; stopAll stops every running bot", async () => {
    const f = setup();
    f.exchange.fill = (o) => (o.reducesRisk ? 0 : 1);
    const { bot } = await started(f, "Trade x profit");
    await started(f, "Trade x profit", 103);
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    assert.equal(f.exchange.orders.find((o) => o.betId === "F3")!.matched, 0);
    await f.bots.stop(bot().id);
    assert.deepEqual(f.exchange.cancelCalls, [{ marketId: W, betIds: ["F3"] }]);
    assert.equal(await f.bots.stopAll(), 1);
    assert.equal(f.bots.list({ status: "running" }).length, 0);
    assert.equal(f.bots.list({ status: "stopped" }).length, 2);
  });

  test("a bot failing 5 ticks in a row becomes failed; a good tick resets the count", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit");
    f.exchange.failCurrentOrders = 4;
    for (let i = 0; i < 4; i++) await f.bots.tick();
    assert.equal(bot().status, "running");
    await f.bots.tick();
    assert.equal(bot().meta!.failures, 0);
    f.exchange.failCurrentOrders = 5;
    for (let i = 0; i < 5; i++) await assert.doesNotReject(() => f.bots.tick());
    assert.equal(bot().status, "failed");
    assert.match(logText(bot()), /Error \(5\/5\): Betfair is unavailable[\s\S]*Failed 5 ticks in a row/);
  });

  test("a bot with unreadable persisted state fails without stopping the others", async () => {
    const f = setup();
    const good = await started(f, "Trade x profit");
    f.state.bots.unshift({ ...structuredClone(good.bot()), id: "bot-broken", meta: {} });
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    assert.equal(f.bots.list().find((b) => b.id === "bot-broken")!.status, "failed");
    assert.equal(good.bot().status, "finished");
  });

  test("market closed or runner removed finishes the bot", async () => {
    const f = setup();
    const a = await started(f, "Trade x profit", 101);
    const b = await started(f, "Trade x profit", 102);
    f.fake.setRunner(102, { status: "REMOVED" });
    await f.bots.tick();
    assert.equal(b.bot().status, "finished");
    assert.match(logText(b.bot()), /Removed/);
    assert.equal(a.bot().status, "running");
    f.fake.settle([101]);
    await f.bots.tick();
    assert.equal(a.bot().status, "finished");
    assert.match(logText(a.bot()), /Market closed/);
  });

  test("a suspended market pauses the bot", async () => {
    const f = setup();
    const { bot } = await started(f, "Trade x profit");
    f.fake.book().status = "SUSPENDED";
    f.fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await f.bots.tick();
    await f.bots.tick();
    assert.equal(f.exchange.placed.length, 1);
    assert.equal(bot().log.filter((l) => /Suspended; waiting/.test(l.message)).length, 1, "logged once");
    f.fake.book().status = "OPEN";
    await f.bots.tick();
    assert.equal(bot().status, "finished");
  });

  test("one book and one order request per tick for all bots", async () => {
    const f = setup();
    await started(f, "Trade x profit", 101);
    await started(f, "Trade x profit", 103);
    f.fake.calls = [];
    f.exchange.currentOrdersCalls = 0;
    await f.bots.tick();
    assert.equal(f.fake.calls.filter((c) => c.method === "listMarketBook").length, 1);
    assert.equal(f.exchange.currentOrdersCalls, 1);
    assert.deepEqual(f.fake.calls[0].args.priceProjection.exBestOffersOverrides, { bestPricesDepth: 1 });
  });

  test("keeps the last 50 log lines and lists bots newest first", async () => {
    const f = setup();
    await f.engine.execute("Bet 10 Euro", W, [sel(101)]);
    const first = await started(f, "Trailing Stop Loss 3 Ticks");
    let lay = 3.05;
    for (let i = 0; i < 60; i++) {
      lay = offsetTicks(lay, -1);
      f.fake.setOffers(101, [[offsetTicks(lay, -1), 100]], [[lay, 100]]);
      await f.bots.tick();
    }
    assert.equal(first.bot().log.length, 50);
    assert.match(first.bot().log.at(-1)!.message, /Trailing from the best price/);
    const second = await started(f, "Trade x profit", 103);
    assert.deepEqual(
      f.bots.list().map((b) => b.id),
      [second.result.botId, first.result.botId],
    );
    assert.deepEqual(f.bots.list({ status: "running", marketId: W }).length, 2);
    assert.deepEqual(f.bots.list({ marketId: "1.999" }), []);
  });
});
