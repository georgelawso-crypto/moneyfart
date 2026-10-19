import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { currencyRules, type CurrencyRules } from "../src/betfair/currency.js";
import type { Side } from "../src/betfair/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { addBet, betOutcomeProfit, greenUpProfit, liability, offsetStakeOrder, positionOf, worstCase } from "../src/exchange/math.js";
import type { CancelResult, Exchange, FundsView, OrderRequest, OrderView, PlacedBet, SettledBets, StrategyTag } from "../src/exchange/types.js";
import { formatSelectionId } from "../src/format.js";
import { MarketService } from "../src/markets.js";
import { Recorder } from "../src/recorder.js";
import { State } from "../src/state.js";
import { BotRunner } from "../src/strategies/bots.js";
import { StrategyEngine } from "../src/strategies/engine.js";
import { TEMPLATES, findTemplate, formatTimeSpan, normaliseParameters, parseParameters } from "../src/strategies/templates.js";
import { closeOrder, isFlat } from "../src/strategies/trading.js";
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
  /** Fraction of each new order matched at once. */
  fill: number | ((order: OrderRequest) => number) = 1;
  /** Error codes returned (FAILURE) for the next orders. */
  failNext: string[] = [];
  unknownNext = 0;
  /** Forced cancel status per bet (undefined = normal behaviour). */
  cancelStatus?: (betId: string) => string | undefined;
  balance = 1000;
  rules: CurrencyRules = currencyRules("GBP");
  private counter = 0;

  async currencyRules() {
    return this.rules;
  }

  async placeOrders(marketId: string, orders: OrderRequest[], tag: StrategyTag): Promise<PlacedBet[]> {
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

  /** Match more of a resting order at its price. */
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
    return { mode: "paper", currency: "GBP", availableToBetBalance: this.balance, exposure: 0 };
  }

  async settledBets(): Promise<SettledBets> {
    return { bets: [] };
  }

  pendingMarketIds(): string[] {
    return [];
  }

  /** Orders sent after the first `skip` placeOrders calls, flattened. */
  sent(skip = 0): OrderRequest[] {
    return this.placed.slice(skip).flatMap((p) => p.orders);
  }
}

// ---------------------------------------------------------------- fixture

const W = WIN_MARKET;
const sel = (selectionId: number) => ({ selectionId, handicap: 0 });

function setup(options: { limits?: Partial<Config["trading"]>; onSleep?: () => void } = {}) {
  const fake = new FakeBetfair();
  const state = new State();
  const markets = new MarketService(fake, state, new Recorder(), 20);
  const exchange = new FakeExchange();
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const limits = { ...loadConfig({}).trading, ...options.limits };
  const bots = new BotRunner({ markets, exchange, state, limits, now });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.t += ms;
    options.onSleep?.();
  };
  const engine = new StrategyEngine({ markets, exchange, state, limits, bots, now, sleep });
  return { fake, state, markets, exchange, bots, engine, clock, sleeps, limits, start: Date.parse(fake.startTime) };
}

/** A matched (or resting, with fill 0) bet placed directly, outside any strategy. */
async function manual(exchange: FakeExchange, side: Side, price: number, size: number, selectionId = 101, fill = 1) {
  const previous = exchange.fill;
  exchange.fill = fill;
  const [bet] = await exchange.placeOrders(W, [{ selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" }], { name: "manual", ref: "manual" });
  exchange.fill = previous;
  return bet;
}

function explain(result: ExecutionResult) {
  return JSON.stringify({ status: result.status, outcome: result.outcome, message: result.message, messages: result.messages }, null, 1);
}

async function positionOn(exchange: FakeExchange, selectionId = 101) {
  const orders = (await exchange.currentOrders([W])).filter((o) => o.selectionId === String(selectionId));
  let ifWin = 0;
  let ifLose = 0;
  for (const o of orders) {
    if (!o.sizeMatched) continue;
    ifWin += betOutcomeProfit(o.side, o.averagePriceMatched!, o.sizeMatched, true);
    ifLose += betOutcomeProfit(o.side, o.averagePriceMatched!, o.sizeMatched, false);
  }
  return { ifWin, ifLose };
}

// ---------------------------------------------------------------- maths

describe("position maths", () => {
  test("positions, green-up profit, stake offsets and flatness to the cent", () => {
    const back = positionOf([{ side: "BACK", sizeMatched: 10, averagePriceMatched: 3 }]);
    assert.deepEqual(back, { ifWin: 20, ifLose: -10 });
    assert.equal(worstCase(back), -10);
    assert.equal(liability("LAY", 3, 10), 20);
    assert.equal(liability("BACK", 3, 10), 10);
    assert.ok(Math.abs(greenUpProfit(back, 2.6) - (-10 + 30 / 2.6)) < 1e-12);
    const greened = addBet(back, "LAY", 2.6, 30 / 2.6);
    assert.ok(Math.abs(greened.ifWin - greened.ifLose) < 1e-9 && Math.abs(greened.ifWin - greenUpProfit(back, 2.6)) < 1e-9);
    assert.deepEqual(offsetStakeOrder(back, 2.58, 2.6), { side: "LAY", price: 2.6, size: 10 });
    assert.equal(offsetStakeOrder(addBet(back, "LAY", 2.6, 10), 2.58, 2.6), undefined);
    assert.deepEqual(offsetStakeOrder({ ifWin: -20.5, ifLose: 10 }, 3.3, 3.35), { side: "BACK", price: 3.3, size: 10 });
    assert.throws(() => offsetStakeOrder(back, 3, undefined), /No lay price/);
    // A cent-rounded hedge at 3.2 leaves |ifWin - ifLose| = 0.016: nothing smaller can be placed.
    const hedged = addBet(back, "LAY", 3.2, 9.38);
    assert.equal(isFlat(hedged, true), false);
    assert.equal(isFlat(hedged, true, 3.2), true);
    assert.equal(closeOrder(hedged, true, 3.15, 3.2), undefined);
    assert.deepEqual(closeOrder(back, true, 3, 3.05), { side: "LAY", price: 3.05, size: 9.84 });
    assert.throws(() => closeOrder(back, true, 3, undefined), /No lay price/);
  });
});

// ---------------------------------------------------------------- parameters

describe("parameter normalisation", () => {
  const trade = findTemplate("Place Bet and Close Selection Bet Position")!;
  const placeBet = findTemplate("place bet")!;

  test("dotted, nested and plain names give the same parameters on the open/close template", () => {
    const dotted = parseParameters(trade, { "OpenBetPosition.BetType": "Lay", "OpenBetPosition.Stake": 5, "CloseBetPosition.Profit": 12 });
    const nested = parseParameters(trade, { OpenBetPosition: { BetType: "Lay", Stake: 5 }, CloseBetPosition: { Profit: 12 } });
    const plain = parseParameters(trade, { bettype: "lay", STAKE: "5", Profit: 12 });
    assert.deepEqual(dotted, { "OpenBetPosition.BetType": "Lay", "OpenBetPosition.Stake": 5, "CloseBetPosition.Profit": 12 });
    assert.deepEqual(nested, dotted);
    assert.deepEqual(plain, dotted);
    // Every close name maps to the CloseBetPosition group.
    assert.deepEqual(
      parseParameters(trade, {
        ProfitLossType: "money",
        Loss: 3,
        HedgingEnabled: false,
        ClosePositionTimeSpan: "-0:00:05",
        BetMatchingTimeout: 2,
        ClosePositionImmediately: true,
        CheckingLastPriceTraded: "yes",
      }),
      {
        "CloseBetPosition.ProfitLossType": "Money",
        "CloseBetPosition.Loss": 3,
        "CloseBetPosition.HedgingEnabled": false,
        "CloseBetPosition.ClosePositionTimeSpan": "-00:00:05",
        "CloseBetPosition.BetMatchingTimeout": "00:00:02",
        "CloseBetPosition.ClosePositionImmediately": true,
        "CloseBetPosition.CheckingLastPriceTraded": true,
      },
    );
    // Selection parameters live at the top level but accept the OpenBetPosition prefix.
    assert.deepEqual(parseParameters(trade, { "OpenBetPosition.ExecuteOnSelection": 2, "openbetposition.StrategyReference": "X" }), {
      ExecuteOnSelection: 2,
      StrategyReference: "X",
    });
  });

  test("templates without groups strip the OpenBetPosition prefix (Close Selection also CloseBetPosition)", () => {
    assert.deepEqual(parseParameters(placeBet, { "OpenBetPosition.Stake": 2 }), { Stake: 2 });
    assert.deepEqual(parseParameters(placeBet, { OpenBetPosition: { Stake: 2, BetType: "lay" } }), { Stake: 2, BetType: "Lay" });
    assert.deepEqual(parseParameters(findTemplate("Close Selection Bet Position")!, { "CloseBetPosition.Profit": 3 }), { Profit: 3 });
    // Tick Offset's Profit is in ticks: a CloseBetPosition.Profit (unit depends on ProfitLossType) is not accepted.
    assert.throws(() => parseParameters(findTemplate("Tick Offset")!, { "CloseBetPosition.Profit": 3 }), /Unknown parameter.*CloseBetPosition\.Profit/);
    assert.throws(() => parseParameters(placeBet, { "CloseBetPosition.Stake": 3 }), /Unknown parameter/);
  });

  test("aliases of names, values and templates", () => {
    assert.deepEqual(parseParameters(placeBet, { OddsOffsetTicks: 2 }), { PriceImprovement: 2 });
    assert.deepEqual(parseParameters(placeBet, { OddsImprovement: 1 }), { PriceImprovement: 1 });
    assert.deepEqual(parseParameters(placeBet, { PersistenceType: "Persist" }), { AtInPlayKeepBet: true });
    assert.deepEqual(parseParameters(placeBet, { PersistenceType: "lapse" }), { AtInPlayKeepBet: false });
    assert.deepEqual(parseParameters(findTemplate("Tick Offset")!, { ProfitTicks: 3 }), { Profit: 3 });
    const dutch = findTemplate("Dutching")!;
    assert.equal(dutch.name, "Place Dutching Bets");
    assert.deepEqual(parseParameters(dutch, { Amount: 10, DutchingType: "Profit" }), { TargetValue: 10, DutchingType: "RequiredProfit" });
    assert.deepEqual(parseParameters(dutch, { DutchingType: "stake" }), { DutchingType: "TotalStake" });
    assert.equal(findTemplate("FILL OR KILL")!.name, "Place Bet - Fill or Kill");
  });

  test("booleans are strict", () => {
    for (const [raw, value] of [
      [true, true],
      [false, false],
      [1, true],
      [0, false],
      ["1", true],
      ["0", false],
      ["TRUE", true],
      ["false", false],
      ["yes", true],
      ["No", false],
    ] as const) {
      assert.deepEqual(parseParameters(placeBet, { AllowPlacingBetInPlay: raw }), { AllowPlacingBetInPlay: value }, String(raw));
    }
    for (const raw of ["ture", "maybe", 2, null, "", [true]]) {
      assert.throws(() => parseParameters(placeBet, { AllowPlacingBetInPlay: raw }), /AllowPlacingBetInPlay must be true or false/, String(raw));
    }
  });

  test("numbers must be finite and non-negative; ticks are whole", () => {
    assert.deepEqual(parseParameters(placeBet, { Stake: "12.5" }), { Stake: 12.5 });
    for (const raw of [-1, "-2", "abc", "", Number.NaN, Number.POSITIVE_INFINITY, true, null, "0x10"]) {
      assert.throws(() => parseParameters(placeBet, { Stake: raw }), /Stake must be a non-negative number/, String(raw));
    }
    assert.throws(() => parseParameters(placeBet, { PriceImprovement: 1.5 }), /whole number/);
  });

  test("TimeSpans accept .NET strings and seconds, negative too", () => {
    assert.deepEqual(parseParameters(placeBet, { PlaceBetTimeSpan: "-0:05:00" }), { PlaceBetTimeSpan: "-00:05:00" });
    assert.deepEqual(parseParameters(placeBet, { PlaceBetTimeSpan: -300 }), { PlaceBetTimeSpan: "-00:05:00" });
    assert.deepEqual(parseParameters(placeBet, { PlaceBetTimeSpan: "5" }), { PlaceBetTimeSpan: "00:00:05" });
    assert.deepEqual(parseParameters(placeBet, { PlaceBetTimeSpan: "1.02:03:04.5" }), { PlaceBetTimeSpan: "1.02:03:04.500" });
    assert.deepEqual(parseParameters(placeBet, { PlaceBetTimeSpan: null }), { PlaceBetTimeSpan: null });
    assert.throws(() => parseParameters(placeBet, { PlaceBetTimeSpan: "five minutes" }), /TimeSpan/);
    assert.equal(formatTimeSpan(-5000), "-00:00:05");
    assert.equal(formatTimeSpan(120_000), "00:02:00");
  });

  test("unknown keys are rejected with the valid names; conflicting duplicates too", () => {
    assert.throws(
      () => parseParameters(placeBet, { Stake: 2, "CloseBetPosition.Price": 3, Foo: 1 }),
      (error: Error) => /CloseBetPosition\.Price, Foo/.test(error.message) && /Valid parameters: BetType, Stake, StakeType/.test(error.message),
    );
    assert.throws(() => parseParameters(placeBet, { Stake: 2, "OpenBetPosition.Stake": 3 }), /given twice/);
    assert.deepEqual(parseParameters(placeBet, { Stake: 2, "OpenBetPosition.Stake": 2 }), { Stake: 2 });
    assert.throws(() => parseParameters(placeBet, "Stake=2" as never), /JSON object/);
  });

  test("cross-parameter checks", () => {
    assert.throws(() => normaliseParameters(placeBet, { BetType: "Back" }), /Stake is required/);
    assert.throws(() => normaliseParameters(placeBet, { Stake: 0 }), /greater than 0/);
    assert.throws(() => normaliseParameters(placeBet, { Stake: 2, MinimumOdds: 5, MaximumOdds: 3 }), /MinimumOdds 5 is above/);
    assert.doesNotThrow(() => normaliseParameters(placeBet, { Stake: 2, MinimumOdds: 5, MaximumOdds: 3, PlaceBetInAllowedOddsRange: false }));
    assert.throws(() => normaliseParameters(placeBet, { Stake: 200, StakeType: "BankrollPercentage" }), /cannot exceed 100/);
    assert.throws(() => normaliseParameters(placeBet, { Stake: 2, StrategyReference: "a reference that is too long" }), /15 characters/);
    assert.throws(() => normaliseParameters(findTemplate("Place Dutching Bets")!, { TargetValue: 10, BetType: "Lay" }), /Back only/);
    assert.throws(() => normaliseParameters(findTemplate("Place Dutching Bets")!, { TargetValue: 10, OnSelections: "1;2" }), /OnSelections/);
    assert.throws(() => normaliseParameters(findTemplate("Trailing Stop Loss")!, { Loss: 0 }), /at least 1/);
    assert.throws(() => normaliseParameters(findTemplate("Tick Offset")!, { Stake: 2, Profit: 0 }), /at least 1/);
    assert.throws(() => normaliseParameters(findTemplate("Place Bet - Fill or Kill")!, { Stake: 2, BetMatchingTimeout: -1 }), /cannot be negative/);
  });

  test("every template is listed with BFExplorer names", () => {
    assert.deepEqual(
      TEMPLATES.map((t) => t.name),
      [
        "Place Bet",
        "Place Bet - Fill or Kill",
        "Place Bet and Close Selection Bet Position",
        "Close Selection Bet Position",
        "Close Market Bet Position",
        "Tick Offset",
        "Trailing Stop Loss",
        "Place Dutching Bets",
        "Cancel Bets",
        "Sequence Execution",
      ],
    );
    const names = trade.parameters.map((p) => p.name);
    for (const name of ["OpenBetPosition.BetType", "OpenBetPosition.PlaceBetTimeSpan", "CloseBetPosition.Profit", "CloseBetPosition.ClosePositionTimeSpan", "SortSelectionsBy"]) {
      assert.ok(names.includes(name), name);
    }
  });
});

// ---------------------------------------------------------------- execution

describe("strategy execution", () => {
  test("Bet 10 Euro backs at the best price with a strategy tag; status comes first", async () => {
    const { engine, exchange, state } = setup();
    const result = await engine.execute("bet 10 euro", W, [sel(101)]);
    assert.equal(Object.keys(result)[0], "status");
    assert.equal(result.status, true, explain(result));
    assert.equal(result.outcome, "Executed");
    assert.equal(result.message, undefined);
    assert.equal(result.strategyName, "Bet 10 Euro");
    assert.deepEqual(exchange.sent(), [{ selectionId: 101, handicap: 0, side: "BACK", price: 3, size: 10, persistenceType: "LAPSE", reducesRisk: undefined }]);
    assert.deepEqual(exchange.placed[0].tag, { name: "Bet 10 Euro", ref: state.strategyRefFor("Bet 10 Euro") });
    assert.equal(result.bets[0].selectionName, "Fast Horse");
    assert.equal(result.bets[0].role, "entry");
    assert.equal(result.parameters.Stake, 10);
  });

  test("Lay 10 Euro lays a backer's stake at the best lay price", async () => {
    const { engine, exchange } = setup();
    await engine.execute("Lay 10 Euro", W, [sel(101)]);
    assert.deepEqual(exchange.sent().map((o) => [o.side, o.price, o.size]), [["LAY", 3.05, 10]]);
  });

  test("stake types: Liability, Payout, BankrollPercentage", async () => {
    const { engine, exchange } = setup();
    const cases: Array<[Record<string, unknown>, [Side, number, number]]> = [
      [{ BetType: "Lay", StakeType: "Liability" }, ["LAY", 3.05, 4.87]],
      [{ StakeType: "Liability" }, ["BACK", 3, 10]],
      [{ StakeType: "Payout" }, ["BACK", 3, 3.33]],
      [{ BetType: "Lay", StakeType: "Payout" }, ["LAY", 3.05, 3.27]],
      [{ StakeType: "BankrollPercentage", Stake: 2 }, ["BACK", 3, 20]],
      [{ BetType: "Lay", StakeType: "BankrollPercentage", Stake: 2 }, ["LAY", 3.05, 9.75]],
    ];
    for (const [overrides, expected] of cases) {
      const before = exchange.placed.length;
      const result = await engine.execute("Bet 10 Euro", W, [sel(101)], overrides);
      assert.equal(result.status, true, explain(result));
      const [order] = exchange.sent(before);
      assert.deepEqual([order.side, order.price, order.size], expected, JSON.stringify(overrides));
    }
  });

  test("OfferMyBet, PriceImprovement and Odds pick the price; Odds round in the bettor's favour", async () => {
    const { engine, exchange } = setup();
    const cases: Array<[Record<string, unknown>, [Side, number]]> = [
      [{ OfferMyBet: true }, ["BACK", 3.05]],
      [{ OfferMyBet: true, BetType: "Lay" }, ["LAY", 3]],
      [{ PriceImprovement: 2 }, ["BACK", 3.1]],
      [{ OddsOffsetTicks: 2, BetType: "Lay" }, ["LAY", 2.98]],
      [{ Odds: 3.52 }, ["BACK", 3.55]],
      [{ Odds: 3.52, BetType: "Lay" }, ["LAY", 3.5]],
    ];
    for (const [overrides, expected] of cases) {
      const before = exchange.placed.length;
      const result = await engine.execute("Bet 10 Euro", W, [sel(101)], overrides);
      assert.equal(result.status, true, explain(result));
      const [order] = exchange.sent(before);
      assert.deepEqual([order.side, order.price], expected, JSON.stringify(overrides));
    }
    const refused = await engine.execute("Bet 10 Euro", W, [sel(101)], { Odds: 1500, PlaceBetInAllowedOddsRange: false });
    assert.equal(refused.status, false);
    assert.match(refused.message!, /cannot be placed as a BACK limit/);
  });

  test("odds range: outside is Skipped (status true, reason given); the check can be disabled", async () => {
    const { engine, exchange } = setup();
    const skipped = await engine.execute("Bet 10 Euro", W, [sel(101)], { MaximumOdds: 2.5 });
    assert.equal(skipped.status, true);
    assert.equal(skipped.outcome, "Skipped");
    assert.match(skipped.message!, /outside the allowed odds range 1\.01-2\.5/);
    assert.equal(exchange.placed.length, 0);
    const placed = await engine.execute("Bet 10 Euro", W, [sel(101)], { MaximumOdds: 2.5, PlaceBetInAllowedOddsRange: false });
    assert.equal(placed.outcome, "Executed", explain(placed));
  });

  test("spread checks use ticks between best back and best lay", async () => {
    const { engine, exchange } = setup();
    const tooTight = await engine.execute("Bet 10 Euro", W, [sel(101)], { MinimumOddsDifference: 2 });
    assert.equal(tooTight.outcome, "Skipped");
    assert.match(tooTight.message!, /spread 1 ticks/);
    const tooWide = await engine.execute("Bet 10 Euro", W, [sel(102)], { MaximumOddsDifference: 1 });
    assert.equal(tooWide.outcome, "Skipped");
    assert.match(tooWide.message!, /spread 2 ticks/);
    assert.equal(exchange.placed.length, 0);
    const ok = await engine.execute("Bet 10 Euro", W, [sel(102)], { MaximumOddsDifference: 2, MinimumOddsDifference: 1 });
    assert.equal(ok.outcome, "Executed");
  });

  test("ExecuteOnSelection picks the Nth selection after SortSelectionsBy", async () => {
    const { engine, exchange } = setup();
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ ExecuteOnSelection: 2, SortSelectionsBy: "LastPriceTraded" }, 103],
      [{ ExecuteOnSelection: 3, SortSelectionsBy: "LastPriceTraded" }, 102],
      [{ ExecuteOnSelection: 1, SortSelectionsBy: "TotalMatched" }, 101],
      [{ ExecuteOnSelection: 3, SortSelectionsBy: "TotalMatched" }, 102],
      [{ ExecuteOnSelection: 2 }, 102],
    ];
    for (const [overrides, expected] of cases) {
      const before = exchange.placed.length;
      const result = await engine.execute("Bet 10 Euro", W, [sel(101)], overrides);
      assert.equal(result.status, true, explain(result));
      assert.equal(exchange.sent(before)[0].selectionId, expected, JSON.stringify(overrides));
    }
    const missing = await engine.execute("Bet 10 Euro", W, [sel(101)], { ExecuteOnSelection: 4 });
    assert.equal(missing.status, false);
    assert.match(missing.message!, /only 3 active/);
  });

  test("FINEST markets use the FINEST ladder for every tick calculation", async () => {
    const { fake, engine, exchange } = setup();
    fake.catalogues.get(W)!.description!.priceLadderDescription = { type: "FINEST" };
    fake.setOffers(101, [[3.01, 100]], [[3.03, 100]]);
    await engine.execute("Bet 10 Euro", W, [sel(101)], { Odds: 3.012 });
    await engine.execute("Bet 10 Euro", W, [sel(101)], { PriceImprovement: 1 });
    const spread = await engine.execute("Bet 10 Euro", W, [sel(101)], { MinimumOddsDifference: 3 });
    assert.deepEqual(exchange.sent().map((o) => o.price), [3.02, 3.02]);
    assert.match(spread.message!, /spread 2 ticks/);
  });

  test("in-play: AllowPlacingBetInPlay false skips; AtInPlayKeepBet persists", async () => {
    const { fake, engine, exchange } = setup();
    fake.book().inplay = true;
    const skipped = await engine.execute("Bet 10 Euro", W, [sel(101)], { AllowPlacingBetInPlay: "no" });
    assert.equal(skipped.outcome, "Skipped");
    assert.match(skipped.message!, /in-play/);
    await engine.execute("Bet 10 Euro", W, [sel(101)], { AtInPlayKeepBet: "yes" });
    await engine.execute("Bet 10 Euro", W, [sel(101)], { PersistenceType: "Persist" });
    assert.deepEqual(exchange.sent().map((o) => o.persistenceType), ["PERSIST", "PERSIST"]);
  });

  test("StrategyReference overrides the customerStrategyRef", async () => {
    const { engine, exchange } = setup();
    await engine.execute("Bet 10 Euro", W, [sel(101)], { StrategyReference: "MyRef" });
    assert.deepEqual(exchange.placed[0].tag, { name: "Bet 10 Euro", ref: "MyRef" });
  });

  test("unknown or dotted-but-invalid override keys reject before any Betfair call", async () => {
    const { fake, engine, exchange } = setup();
    for (const [name, overrides] of [
      ["Bet 10 Euro", { "CloseBetPosition.Price": 3 }],
      ["Trade x profit", { "OpenBetPosition.BetType": "Lay", "CloseBetPosition.Price": 3 }],
      ["Lay 10 Euro", { ProfitTicks: 3 }],
      ["Bet 10 Euro", { AllowPlacingBetInPlay: "ture" }],
    ] as const) {
      const result = await engine.execute(name, W, [sel(101)], overrides);
      assert.equal(result.status, false, name);
      assert.equal(result.outcome, "Failed");
      assert.match(result.message!, /Nothing was executed/);
    }
    const result = await engine.execute("Bet 10 Euro", W, [sel(101)], { "CloseBetPosition.Price": 3 });
    assert.match(result.message!, /Unknown parameter for template "Place Bet": CloseBetPosition\.Price\. Valid parameters: BetType, Stake/);
    assert.equal(fake.calls.length, 0, "no catalogue, book or order call");
    assert.equal(exchange.placed.length, 0);
  });

  test("Trade x profit with BFExplorer's dotted overrides opens the requested side and starts a bot", async () => {
    const { engine, exchange, bots } = setup();
    const result = await engine.execute("Trade x profit", W, [sel(101)], { "OpenBetPosition.BetType": "Lay", "CloseBetPosition.Profit": 9 });
    assert.equal(result.status, true, explain(result));
    assert.equal(result.outcome, "Started");
    assert.ok(result.botId);
    assert.deepEqual(result.botIds, [result.botId]);
    assert.deepEqual(exchange.sent().map((o) => [o.side, o.price, o.size]), [["LAY", 3.05, 4.87]], "Liability 10 at 3.05");
    assert.equal(result.parameters["OpenBetPosition.BetType"], "Lay");
    assert.equal(result.parameters["CloseBetPosition.Profit"], 9);
    assert.equal(result.parameters["CloseBetPosition.ProfitLossType"], "Percentage");
    const [bot] = bots.list();
    assert.equal(bot.id, result.botId);
    assert.equal(bot.status, "running");
    assert.deepEqual(bot.betIds, [result.bets[0].betId]);
  });

  test("Trade x profit is not opened once its close time has passed", async () => {
    const { engine, exchange, clock, start } = setup();
    clock.t = start - 4000;
    const result = await engine.execute("Trade x profit", W, [sel(101)]);
    assert.equal(result.outcome, "Skipped");
    assert.equal(result.status, true);
    assert.match(result.message!, /already passed/);
    assert.equal(exchange.placed.length, 0);
  });

  test("risk limits: MAX_STAKE and MAX_LIABILITY on risk-adding orders", async () => {
    const { engine, exchange } = setup({ limits: { maxStake: 25, maxLiability: 30 } });
    const tooBig = await engine.execute("Bet 10 Euro", W, [sel(101)], { Stake: 30 });
    assert.equal(tooBig.status, false);
    assert.equal(tooBig.outcome, "Failed");
    assert.match(tooBig.message!, /exceeds MAX_STAKE 25/);
    assert.equal(tooBig.rejected![0].reason, "Stake 30 exceeds MAX_STAKE 25.");
    const liability = await engine.execute("Lay 10 Euro", W, [sel(102)]);
    assert.match(liability.message!, /Liability 52 exceeds MAX_LIABILITY 30/);
    assert.equal(exchange.placed.length, 0);
  });

  test("status aggregation: one order rejected and one placed is PartiallyExecuted, not Failed", async () => {
    const { engine } = setup({ limits: { maxLiability: 30 } });
    const result = await engine.execute("Lay 10 Euro", W, [sel(101), sel(102)]);
    assert.equal(result.outcome, "PartiallyExecuted", explain(result));
    assert.equal(result.status, true);
    assert.equal(result.bets.length, 1);
    assert.equal(result.bets[0].status, "SUCCESS");
    assert.equal(result.rejected!.length, 1);
    assert.equal(result.rejected![0].selectionName, "Slow Horse");
    assert.match(result.message!, /1 bet\(s\) placed.*do not simply retry.*MAX_LIABILITY/);
  });

  test("status aggregation: exchange failures and unknown outcomes", async () => {
    const { engine, exchange } = setup();
    exchange.failNext = ["INSUFFICIENT_FUNDS"];
    const partial = await engine.execute("Bet 10 Euro", W, [sel(101), sel(103)]);
    assert.equal(partial.outcome, "PartiallyExecuted");
    assert.match(partial.message!, /INSUFFICIENT_FUNDS/);
    exchange.failNext = ["INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS"];
    const failed = await engine.execute("Bet 10 Euro", W, [sel(101), sel(103)]);
    assert.equal(failed.outcome, "Failed");
    assert.equal(failed.status, false);
    exchange.unknownNext = 1;
    const unknown = await engine.execute("Bet 10 Euro", W, [sel(101)]);
    assert.equal(unknown.outcome, "PartiallyExecuted", "an unknown outcome is never reported as Failed");
    assert.match(unknown.message!, /unknown outcome: check get_current_orders/);
  });

  test("duplicate selections are executed once", async () => {
    const { engine, exchange } = setup();
    const result = await engine.execute("Bet 10 Euro", W, [sel(101), sel(101), { selectionId: 103, handicap: 0 }, sel(103)]);
    assert.equal(exchange.sent().length, 2);
    assert.ok(result.messages.some((m) => /Duplicate selections ignored: 101, 103/.test(m)), explain(result));
  });

  test("refuses non-ODDS and non-open markets, unknown settings, markets and selections", async () => {
    for (const bettingType of ["ASIAN_HANDICAP_DOUBLE_LINE", "LINE", "RANGE"]) {
      const { fake, engine, exchange } = setup();
      fake.catalogues.get(W)!.description!.bettingType = bettingType;
      const result = await engine.execute("Bet 10 Euro", W, [sel(101)]);
      assert.equal(result.status, false);
      assert.match(result.message!, new RegExp(`${bettingType} market.*ODDS`));
      assert.equal(exchange.placed.length, 0);
    }
    const { fake, engine, exchange } = setup();
    fake.book().status = "SUSPENDED";
    assert.match((await engine.execute("Bet 10 Euro", W, [sel(101)])).message!, /Suspended/);
    fake.book().status = "OPEN";
    const unknown = await engine.execute("Bet 99 Euro", W, [sel(101)]);
    assert.equal(unknown.status, false);
    assert.match(unknown.message!, /not found\. Available: Bet 10 Euro, Lay 10 Euro, Back 2 Euro/);
    assert.match((await engine.execute("Bet 10 Euro", "1.x", [sel(101)])).message!, /Invalid marketId/);
    assert.match((await engine.execute("Bet 10 Euro", W, [sel(999)])).message!, /not in market/);
    assert.match((await engine.execute("Bet 10 Euro", W, [])).message!, /No selection given/);
    assert.equal(exchange.placed.length, 0);
  });
});

describe("fill or kill", () => {
  test("cancels the unmatched remainder after BetMatchingTimeout", async () => {
    const { engine, exchange, sleeps } = setup();
    exchange.fill = 0.4;
    const result = await engine.execute("Bet 10 Euro Fill or Kill", W, [sel(101)]);
    assert.deepEqual(sleeps, [1000, 1000, 1000, 1000, 1000]);
    assert.deepEqual(exchange.cancelCalls, [{ marketId: W, betIds: ["F1"] }]);
    assert.equal(result.cancelled[0].sizeCancelled, 6);
    assert.equal(result.bets[0].sizeMatched, 4);
    assert.equal(result.outcome, "Executed", explain(result));
    assert.ok(result.messages.some((m) => /4 of 10 matched within 5 s; the unmatched 6 was cancelled/.test(m)));
  });

  test("stops waiting when the bet matches, and caps the timeout at 30 s", async () => {
    let exchange!: FakeExchange;
    const fixture = setup({ onSleep: () => exchange.orders.length && exchange.match("F1") });
    exchange = fixture.exchange;
    exchange.fill = 0;
    const matched = await fixture.engine.execute("Bet 10 Euro Fill or Kill", W, [sel(101)]);
    assert.deepEqual(fixture.sleeps, [1000]);
    assert.equal(exchange.cancelCalls.length, 0);
    assert.equal(matched.bets[0].sizeMatched, 10);

    const capped = setup();
    capped.exchange.fill = 0;
    const result = await capped.engine.execute("Bet 10 Euro Fill or Kill", W, [sel(101)], { BetMatchingTimeout: "00:01:00" });
    assert.equal(capped.sleeps.reduce((a, b) => a + b, 0), 30_000);
    assert.ok(result.messages.some((m) => /capped at 30 seconds/.test(m)));
    assert.equal(capped.exchange.cancelCalls.length, 1);

    const full = setup();
    await full.engine.execute("Bet 10 Euro Fill or Kill", W, [sel(101)]);
    assert.deepEqual(full.sleeps, []);
    assert.equal(full.exchange.cancelCalls.length, 0);
  });
});

describe("tick offset", () => {
  test("offsets the matched entry Profit ticks better, sized for an equal profit", async () => {
    const { engine, exchange } = setup();
    engine.save("Scalp", "Tick Offset", { BetType: "Back", Stake: 10, ProfitTicks: 2 });
    const result = await engine.execute("Scalp", W, [sel(101)]);
    assert.equal(result.outcome, "Executed", explain(result));
    const [entry, offset] = exchange.sent();
    assert.deepEqual([entry.side, entry.price, entry.size], ["BACK", 3, 10]);
    assert.deepEqual([offset.side, offset.price, offset.size, offset.reducesRisk], ["LAY", 2.96, 10.14, true]);
    assert.deepEqual(result.bets.map((b) => b.role), ["entry", "offset"]);
    const p = await positionOn(exchange);
    assert.ok(Math.abs(p.ifWin - p.ifLose) < 0.02, JSON.stringify(p));

    const lay = await engine.execute("Scalp", W, [sel(101)], { BetType: "Lay" });
    const [, layOffset] = lay.bets;
    assert.deepEqual([layOffset.side, layOffset.price, layOffset.size], ["BACK", 3.15, 9.68]);
  });

  test("partial, unmatched and below-minimum entries", async () => {
    const { engine, exchange } = setup();
    engine.save("Scalp", "Tick Offset", { Stake: 10, Profit: 2 });
    exchange.fill = (o) => (o.reducesRisk ? 1 : 0.5);
    const partial = await engine.execute("Scalp", W, [sel(101)]);
    assert.equal(partial.bets[1].size, 5.07);
    assert.ok(partial.messages.some((m) => /only 5 of 10 matched/.test(m)));

    exchange.fill = 0;
    const unmatched = await engine.execute("Scalp", W, [sel(101)]);
    assert.equal(unmatched.bets.length, 1);
    assert.ok(unmatched.messages.some((m) => /not matched yet/.test(m)));

    exchange.fill = (o) => (o.reducesRisk ? 1 : 0.03);
    const small = await engine.execute("Scalp", W, [sel(101)]);
    assert.equal(small.bets.length, 1, "the 0.3 offset is below Betfair's minimum and is not sent");
    assert.equal(small.rejected![0].role, "offset");
    assert.match(small.rejected![0].reason, /INVALID_BET_SIZE/);
    assert.equal(small.outcome, "PartiallyExecuted");
  });
});

describe("dutching", () => {
  test("RequiredProfit and TotalStake stakes; Dutch for 10 Euro", async () => {
    const { engine, exchange } = setup();
    const profit = await engine.execute("Dutch for 10 Euro", W, [sel(101), sel(103)]);
    assert.equal(profit.outcome, "Executed", explain(profit));
    const legs = exchange.sent();
    assert.deepEqual(legs.map((o) => [o.selectionId, o.side, o.price, o.size]), [
      [101, "BACK", 3, 7.58],
      [103, "BACK", 4.4, 5.17],
    ]);
    const total = legs.reduce((t, o) => t + o.size, 0);
    for (const leg of legs) assert.ok(Math.abs(leg.size * leg.price - total - 10) < 0.1);
    assert.deepEqual(profit.bets.map((b) => b.role), ["dutch", "dutch"]);

    const before = exchange.placed.length;
    await engine.execute("Dutch 10 Euro stake", W, [sel(101), sel(103)]);
    assert.deepEqual(exchange.sent(before).map((o) => o.size), [5.94, 4.05]);
  });

  test("atomic: one leg over MAX_STAKE places nothing", async () => {
    const { engine, exchange } = setup();
    const result = await engine.execute("Dutch to profit 10 Euro", W, [sel(101), sel(103)], { TargetValue: 40 });
    assert.equal(result.status, false);
    assert.match(result.message!, /Dutch not placed.*Fast Horse: 30\.34 @ 3: Stake 30\.34 exceeds MAX_STAKE 25/);
    assert.equal(result.rejected![0].selectionName, "Fast Horse");
    assert.equal(exchange.placed.length, 0);
  });

  test("atomic: price limit, minimum bet, total liability, book over 100%", async () => {
    const { fake, engine, exchange } = setup({ limits: { maxLiability: 8 } });
    const maxOdds = await engine.execute("Dutch for 10 Euro", W, [sel(101), sel(103)], { MaximumOdds: 4 });
    assert.match(maxOdds.message!, /Mid Horse: price 4\.4 is above MaximumOdds 4/);
    const small = await engine.execute("Dutch 10 Euro stake", W, [sel(101), sel(102), sel(103)], { TargetValue: 3 });
    assert.match(small.message!, /Slow Horse: 0\.69 @ 5\.9: .*INVALID_BET_SIZE/);
    const total = await engine.execute("Dutch 10 Euro stake", W, [sel(101), sel(103)]);
    assert.match(total.message!, /total stake 9\.99 .* exceeds MAX_LIABILITY 8/);
    fake.setOffers(102, [[1.5, 100]], [[1.52, 100]]);
    const book = await engine.execute("Dutch for 10 Euro", W, [sel(101), sel(102)]);
    assert.match(book.message!, /100\.0% book/);
    for (const r of [maxOdds, small, total, book]) assert.equal(r.status, false);
    assert.equal(exchange.placed.length, 0);
  });

  test("Lay is refused; OnSelections picks sorted positions; duplicates are removed", async () => {
    const { engine, exchange } = setup();
    const lay = await engine.execute("Dutch for 10 Euro", W, [sel(101), sel(103)], { BetType: "Lay" });
    assert.equal(lay.status, false);
    assert.match(lay.message!, /Back only/);
    const on = await engine.execute("Dutch for 10 Euro", W, [sel(103)], { OnSelections: "1,3", SortSelectionsBy: "LastPriceTraded" });
    assert.deepEqual(exchange.sent().map((o) => o.selectionId), [101, 102], explain(on));
    const before = exchange.placed.length;
    const dup = await engine.execute("Dutch 10 Euro stake", W, [sel(102), sel(102), sel(103)]);
    const legs = exchange.sent(before);
    assert.deepEqual(legs.map((o) => o.selectionId), [102, 103]);
    assert.ok(Math.abs(legs[0].size * legs[0].price - legs[1].size * legs[1].price) < 0.1, "equal returns");
    assert.ok(dup.messages.some((m) => /Duplicate selection ignored: 102/.test(m)));
  });
});

describe("closing positions", () => {
  test("Close Selection greens up the whole position; hedges are exempt from limits but sized exactly", async () => {
    const { engine, exchange } = setup({ limits: { maxStake: 5, maxLiability: 20 } });
    await manual(exchange, "BACK", 4, 10);
    const result = await engine.execute("Close Selection Bet Position", W, [sel(101)]);
    assert.equal(result.outcome, "Executed", explain(result));
    const [hedge] = exchange.sent(1);
    assert.deepEqual([hedge.side, hedge.price, hedge.size, hedge.reducesRisk], ["LAY", 3.05, 13.11, true]);
    assert.equal(result.bets[0].role, "hedge");
    const p = await positionOn(exchange);
    assert.ok(Math.abs(p.ifWin - p.ifLose) < 0.02);
  });

  test("cancels unmatched bets first, re-reads the orders and hedges what is matched", async () => {
    const { engine, exchange } = setup();
    await manual(exchange, "BACK", 3, 10);
    await manual(exchange, "BACK", 3.5, 5, 101, 0); // resting
    const result = await engine.execute("Close Selection Bet Position", W, [sel(101)]);
    assert.deepEqual(exchange.cancelCalls, [{ marketId: W, betIds: ["F2"] }]);
    assert.equal(result.cancelled[0].status, "SUCCESS");
    assert.deepEqual(exchange.sent(2).map((o) => [o.side, o.price, o.size]), [["LAY", 3.05, 9.84]]);
    assert.ok(exchange.currentOrdersCalls >= 2, "orders are read again after the cancel");
  });

  test("a bet matched during the cancel (BET_TAKEN_OR_LAPSED) is included in the hedge", async () => {
    const { engine, exchange } = setup();
    await manual(exchange, "BACK", 3, 10);
    await manual(exchange, "BACK", 3, 5, 101, 0);
    exchange.cancelStatus = (betId) => {
      exchange.match(betId);
      return "BET_TAKEN_OR_LAPSED";
    };
    const result = await engine.execute("Close Selection Bet Position", W, [sel(101)]);
    assert.equal(result.status, true, explain(result));
    assert.deepEqual(exchange.sent(2).map((o) => [o.side, o.size]), [["LAY", 14.75]], "45 / 3.05");
  });

  test("a failed cancel blocks the hedge", async () => {
    const { engine, exchange } = setup();
    await manual(exchange, "BACK", 3, 10);
    await manual(exchange, "BACK", 3.5, 5, 101, 0);
    exchange.cancelStatus = () => "ERROR_IN_MATCHER";
    const result = await engine.execute("Close Selection Bet Position", W, [sel(101)]);
    assert.equal(result.status, false);
    assert.equal(result.outcome, "Failed");
    assert.match(result.message!, /cancelling unmatched bet F2 failed \(ERROR_IN_MATCHER\).*was not closed/);
    assert.equal(exchange.placed.length, 2, "no hedge");
  });

  test("resting bets on the hedge side block the hedge when CancelUnmatchedBets is false", async () => {
    const { engine, exchange } = setup();
    await manual(exchange, "BACK", 3, 10);
    await manual(exchange, "LAY", 2.96, 10.14, 101, 0);
    const result = await engine.execute("Close Selection Bet Position", W, [sel(101)], { CancelUnmatchedBets: 0 });
    assert.equal(result.status, false);
    assert.match(result.message!, /unmatched LAY bet\(s\) F2 \(10\.14 unmatched\) would over-hedge/);
    assert.equal(exchange.cancelCalls.length, 0);
    assert.equal(exchange.placed.length, 2);
  });

  test("flat and almost-flat positions are Skipped as already flat", async () => {
    const { engine, exchange } = setup();
    const none = await engine.execute("Close Selection Bet Position", W, [sel(101)]);
    assert.equal(none.outcome, "Skipped");
    assert.match(none.message!, /no matched bets/);
    await manual(exchange, "BACK", 3, 10);
    await manual(exchange, "LAY", 2.96, 10.14); // if win 0.1256, if lose 0.14: the hedge rounds to 0.00
    const flat = await engine.execute("Close Selection Bet Position", W, [sel(101)]);
    assert.equal(flat.status, true);
    assert.equal(flat.outcome, "Skipped");
    assert.match(flat.message!, /already flat/);
    assert.equal(exchange.placed.length, 2);
  });

  test("a position that cannot be priced is reported, never as 'no open position'", async () => {
    const { fake, engine, exchange } = setup();
    await manual(exchange, "BACK", 5.9, 10, 102);
    fake.setOffers(102, [[5.9, 100]], []);
    const result = await engine.execute("Close Market Bet Position", W, [sel(101)]);
    assert.equal(result.status, false);
    assert.equal(result.outcome, "Failed");
    assert.match(result.message!, /Slow Horse: the open position could not be priced \(No lay price/);
    assert.ok(!result.messages.some((m) => /No open matched position/.test(m)));
  });

  test("cancelling unmatched bets without closing the position is Failed, not PartiallyExecuted", async () => {
    const { fake, engine, exchange } = setup();
    await manual(exchange, "BACK", 5.9, 10, 102);
    await manual(exchange, "BACK", 6.2, 5, 102, 0); // resting
    fake.setOffers(102, [[5.9, 100]], []);
    const result = await engine.execute("Close Selection Bet Position", W, [sel(102)]);
    assert.equal(result.cancelled[0].status, "SUCCESS");
    assert.equal(result.status, false, explain(result));
    assert.equal(result.outcome, "Failed");
    assert.match(result.message!, /could not be priced.*was not closed/);
    // Only cancelling (nothing left to hedge) is still a success.
    const only = setup();
    await manual(only.exchange, "BACK", 6.2, 5, 102, 0);
    const cancelled = await only.engine.execute("Close Selection Bet Position", W, [sel(102)]);
    assert.equal(cancelled.status, true, explain(cancelled));
    assert.equal(cancelled.outcome, "Executed");
  });

  test("Close Market counts positions needing a hedge, hedged and failed", async () => {
    const { fake, engine, exchange } = setup();
    await manual(exchange, "BACK", 3, 10, 101);
    await manual(exchange, "BACK", 5.9, 10, 102);
    fake.setOffers(102, [[5.9, 100]], []);
    const result = await engine.execute("Close Market Bet Position", W, [sel(101)]);
    assert.equal(result.outcome, "PartiallyExecuted", explain(result));
    assert.ok(result.messages.includes("2 position(s) needed a hedge: 1 hedged, 1 failed."));
    const empty = setup();
    const nothing = await empty.engine.execute("Close Market Bet Position", W, [sel(101)]);
    assert.equal(nothing.outcome, "Skipped");
    assert.match(nothing.message!, /No open matched position/);
  });

  test("a hedge below Betfair's minimum is reported, not sent", async () => {
    const { engine, exchange } = setup();
    await manual(exchange, "BACK", 3, 1);
    await manual(exchange, "LAY", 3, 0.95);
    const result = await engine.execute("Close Selection Bet Position", W, [sel(101)]);
    assert.equal(result.status, true);
    assert.equal(result.outcome, "Skipped");
    assert.match(result.message!, /LAY 0\.05 @ 3\.05 was not sent: .*INVALID_BET_SIZE.*stays open/);
    assert.equal(exchange.placed.length, 2);
  });

  test("HedgingEnabled false offsets the stake, but never increases the worst case", async () => {
    const { fake, engine, exchange } = setup();
    await manual(exchange, "BACK", 3, 10);
    fake.setOffers(101, [[2.58, 100]], [[2.6, 100]]);
    await engine.execute("Close Selection Bet Position", W, [sel(101)], { HedgingEnabled: false });
    assert.deepEqual(exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 2.6, 10]]);
    const p = await positionOn(exchange);
    assert.ok(Math.abs(p.ifLose) < 0.01 && p.ifWin > 3.9);

    const drift = setup();
    await manual(drift.exchange, "BACK", 3, 10);
    drift.fake.setOffers(101, [[4.9, 100]], [[5, 100]]);
    const result = await drift.engine.execute("Close Selection Bet Position", W, [sel(101)], { HedgingEnabled: false });
    assert.deepEqual(drift.exchange.sent(1).map((o) => [o.side, o.price, o.size]), [["LAY", 5, 6]], "greened up for -4 instead of -20 if it wins");
    assert.ok(result.messages.some((m) => /would increase the worst-case loss/.test(m)));
  });

  test("Close Selection with ClosePositionImmediately false starts a bot, or skips when flat", async () => {
    const { engine, exchange, bots } = setup();
    const flat = await engine.execute("Close Selection Bet Position", W, [sel(101)], { ClosePositionImmediately: false });
    assert.equal(flat.outcome, "Skipped");
    await manual(exchange, "BACK", 3, 10);
    const started = await engine.execute("Close Selection Bet Position", W, [sel(101)], { ClosePositionImmediately: false, ProfitLossType: "Money", Profit: 1 });
    assert.equal(started.outcome, "Started", explain(started));
    assert.equal(bots.list()[0].template, "Close Selection Bet Position");
  });
});

describe("cancel bets", () => {
  test("selection and market scope", async () => {
    const { engine, exchange } = setup();
    const nothing = await engine.execute("Cancel Selection Bets", W, [sel(101)]);
    assert.equal(nothing.outcome, "Skipped");
    await manual(exchange, "BACK", 3.5, 5, 101, 0);
    await manual(exchange, "BACK", 7, 5, 102, 0);
    const selection = await engine.execute("Cancel Selection Bets", W, [sel(101)]);
    assert.deepEqual(selection.cancelled.map((c) => [c.betId, c.status]), [["F1", "SUCCESS"]]);
    assert.equal(selection.outcome, "Executed");
    const market = await engine.execute("Cancel Market Bets", W, [sel(101)]);
    assert.deepEqual(market.cancelled.map((c) => c.betId), ["F2"]);
    exchange.cancelStatus = () => "ERROR_IN_MATCHER";
    await manual(exchange, "BACK", 3.5, 5, 101, 0);
    const failed = await engine.execute("Cancel Market Bets", W, [sel(101)]);
    assert.equal(failed.status, false);
    assert.match(failed.message!, /ERROR_IN_MATCHER/);
  });
});

describe("settings", () => {
  test("built-in names and aliases used by the prompt library", async () => {
    const { engine, exchange } = setup();
    const names = engine.list().map((s) => s.name);
    for (const name of [
      "Bet 10 Euro",
      "Lay 10 Euro",
      "Back 2 Euro",
      "Lay 2 Euro",
      "Trade x profit",
      "Trade 20% profit",
      "Trade 5 ticks",
      "Trade 3 ticks",
      "Trade 2 Ticks Profit or 10 Ticks Loss",
      "Trading Strategy",
      "Back Trade",
      "Lay Trade",
      "Trailing Stop Loss 3 Ticks",
      "Back trailing stop loss trading",
      "Close Selection Bet Position",
      "Close Market Bet Position",
      "Cancel Selection Bets",
      "Cancel Market Bets",
      "Dutch to profit 10 Euro",
      "Dutch for 10 Euro",
      "Dutch 10 Euro stake",
      "Bet 10 Euro Fill or Kill",
    ]) {
      assert.ok(names.includes(name), name);
    }
    assert.equal(engine.get("bet 2 euro").name, "Back 2 Euro");
    assert.equal(engine.get("TRADE 20%").name, "Trade 20% profit");
    assert.deepEqual(engine.get("trade x PROFIT").parameters, {
      "OpenBetPosition.BetType": "Back",
      "OpenBetPosition.Stake": 10,
      "OpenBetPosition.StakeType": "Liability",
      "OpenBetPosition.AtInPlayKeepBet": true,
      "OpenBetPosition.AllowPlacingBetInPlay": true,
      "CloseBetPosition.ProfitLossType": "Percentage",
      "CloseBetPosition.Profit": 10,
      "CloseBetPosition.Loss": 1000,
      "CloseBetPosition.HedgingEnabled": true,
      "CloseBetPosition.ClosePositionTimeSpan": "-00:00:05",
    });
    assert.deepEqual(engine.get("Dutch for 10 Euro").parameters, { DutchingType: "RequiredProfit", TargetValue: 10 });
    assert.equal(engine.get("Back Trade").parameters["CloseBetPosition.ClosePositionTimeSpan"], "-00:02:00");
    assert.equal(engine.get("Trailing Stop Loss 3 Ticks").template, "Trailing Stop Loss");
    assert.ok(engine.list().every((s) => s.builtIn));
    for (const name of ["Back 2 Euro", "Bet 2 Euro"]) {
      const before = exchange.placed.length;
      const result = await engine.execute(name, W, [sel(101)]);
      assert.equal(result.strategyName, "Back 2 Euro");
      assert.deepEqual(exchange.sent(before).map((o) => [o.side, o.size]), [["BACK", 2]]);
    }
    assert.throws(() => engine.get("Bet 3 Euro"), /not found\. Available:/);
    assert.equal(engine.template("dutching").name, "Place Dutching Bets");
    assert.throws(() => engine.template("Scalping"), /Unknown strategy template "Scalping"\. Available: Place Bet/);
  });

  test("create is create-only with per-item results", () => {
    const { engine, state } = setup();
    const results = engine.create([
      { name: "Back Bet 5", template: "Place Bet", parameters: { BetType: "Back", Stake: 5 } },
      { name: "Back Bet 5", template: "Place Bet", parameters: { BetType: "Back", Stake: 50 } },
      { name: "Bet 10 Euro", template: "Place Bet", parameters: { Stake: 1 } },
      { name: "Bad", template: "Place Bet", parameters: { Stake: 1, Colour: "red" } },
      { name: "No template", template: "Scalping" },
      { name: "From JSON", template: "place bet and close selection bet position", parameters: '{"OpenBetPosition.Stake":3,"CloseBetPosition.Profit":4}' as never },
      { name: "", template: "Place Bet" },
    ]);
    assert.deepEqual(
      results.map((r) => [r.name, r.status]),
      [
        ["Back Bet 5", true],
        ["Back Bet 5", false],
        ["Bet 10 Euro", false],
        ["Bad", false],
        ["No template", false],
        ["From JSON", true],
        ["", false],
      ],
    );
    assert.match(results[1].message!, /already exists/);
    assert.match(results[3].message!, /Unknown parameter for template "Place Bet": Colour/);
    assert.equal(engine.get("back bet 5").parameters.Stake, 5, "not replaced");
    assert.deepEqual(engine.get("From JSON").parameters, { "OpenBetPosition.Stake": 3, "CloseBetPosition.Profit": 4 });
    assert.equal(engine.get("From JSON").template, "Place Bet and Close Selection Bet Position");
    assert.equal(state.customStrategies.size, 2);
  });

  test("save refuses built-in and existing names unless overwrite; remove restores built-ins", () => {
    const { engine } = setup();
    assert.throws(() => engine.save("Bet 10 Euro", "Place Bet", { Stake: 5 }), /built-in.*overwrite/);
    assert.throws(() => engine.save("bet 2 euro", "Place Bet", { Stake: 5 }), /built-in/);
    const custom = engine.save("Bet 10 Euro", "Place Bet", { Stake: 5 }, { overwrite: true, description: "Smaller" });
    assert.equal(custom.builtIn, undefined);
    assert.equal(engine.get("Bet 10 Euro").parameters.Stake, 5);
    assert.equal(engine.list().filter((s) => s.name === "Bet 10 Euro").length, 1);
    assert.equal(engine.list().find((s) => s.name === "Bet 10 Euro")!.description, "Smaller");
    engine.save("Mine", "Place Bet", { Stake: 1 });
    assert.throws(() => engine.save("mine", "Place Bet", { Stake: 2 }), /already exists/);
    engine.save("mine", "Place Bet", { Stake: 2 }, { overwrite: true });
    assert.equal(engine.get("Mine").parameters.Stake, 2);
    assert.throws(() => engine.save("Odd", "Place Bet", { Stake: 1, "CloseBetPosition.Profit": 2 }), /Unknown parameter/);
    assert.throws(() => engine.save("No stake", "Place Bet", { BetType: "Lay" }), /Stake is required/);
    assert.equal(engine.remove("Bet 10 Euro"), true);
    assert.equal(engine.get("Bet 10 Euro").parameters.Stake, 10);
    assert.equal(engine.get("Bet 10 Euro").builtIn, true);
    assert.throws(() => engine.remove("Bet 10 Euro"), /built-in setting and cannot be deleted/);
    assert.equal(engine.remove("Nothing like this"), false);
  });

  test("settings survive a restart", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strategies-"));
    const first = State.forDataDir(dir);
    const fake = new FakeBetfair();
    const deps = (state: State) => {
      const markets = new MarketService(fake, state, new Recorder(), 20);
      const exchange = new FakeExchange();
      const limits = loadConfig({}).trading;
      return { markets, exchange, state, limits, bots: new BotRunner({ markets, exchange, state, limits }) };
    };
    new StrategyEngine(deps(first)).save("Mine", "Place Bet", { Stake: "3", PersistenceType: "Persist" });
    first.flush();
    first.release();
    const second = State.forDataDir(dir);
    assert.deepEqual(new StrategyEngine(deps(second)).get("mine").parameters, { Stake: 3, AtInPlayKeepBet: true });
    second.release();
  });
});

describe("sequence execution", () => {
  test("Back trailing stop loss trading backs, then starts a trailing stop", async () => {
    const { engine, exchange, bots } = setup();
    const result = await engine.execute("Back trailing stop loss trading", W, [sel(101)]);
    assert.equal(result.status, true, explain(result));
    assert.equal(result.outcome, "Started");
    assert.equal(result.template, "Sequence Execution");
    assert.deepEqual(exchange.sent().map((o) => [o.side, o.size]), [["BACK", 10]]);
    assert.equal(result.bets.length, 1);
    const [bot] = bots.list();
    assert.equal(bot.template, "Trailing Stop Loss");
    assert.deepEqual(result.botIds, [bot.id]);
    assert.deepEqual(
      result.messages.filter((m) => /^[^:]+: (Executed|Started)\.$/.test(m)),
      ["Bet 10 Euro: Executed.", "Trailing Stop Loss 3 Ticks: Started."],
    );
  });

  test("stops at the first failing step: status false with that step's message", async () => {
    const { engine, exchange } = setup();
    engine.save("Big Back", "Place Bet", { Stake: 30 });
    engine.save("Three steps", "Sequence Execution", { StrategyNames: "Bet 10 Euro; Big Back; Lay 10 Euro" });
    const result = await engine.execute("Three steps", W, [sel(101)]);
    assert.equal(result.status, false);
    assert.equal(result.outcome, "PartiallyExecuted");
    assert.match(result.message!, /^Step "Big Back" failed: .*MAX_STAKE/);
    assert.ok(result.messages.includes("Not executed: Lay 10 Euro."));
    assert.deepEqual(exchange.sent().map((o) => o.size), [10]);
  });

  test("validates every step before running any; refuses recursion", async () => {
    const { engine, exchange } = setup();
    engine.save("Broken", "Sequence Execution", { StrategyNames: "Bet 10 Euro;No Such Setting" });
    const broken = await engine.execute("Broken", W, [sel(101)]);
    assert.equal(broken.status, false);
    assert.match(broken.message!, /Step "No Such Setting": Strategy setting "No Such Setting" not found/);
    engine.save("Loop", "Sequence Execution", { StrategyNames: "Bet 10 Euro;Loop" });
    const loop = await engine.execute("Loop", W, [sel(101)]);
    assert.match(loop.message!, /recursively/);
    engine.save("Outer", "Sequence Execution", { StrategyNames: "Inner" });
    engine.save("Inner", "Sequence Execution", { StrategyNames: "Outer" });
    assert.match((await engine.execute("Outer", W, [sel(101)])).message!, /recursively/);
    assert.equal(exchange.placed.length, 0);
  });
});
