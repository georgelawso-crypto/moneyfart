import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BetfairApiError, type BetfairApi } from "../src/betfair/client.js";
import type { CancelExecutionReport, ClearedOrderSummary, CurrentOrderSummary, PlaceExecutionReport } from "../src/betfair/types.js";
import { LiveExchange, UNCONFIRMED } from "../src/exchange/live.js";
import type { OrderRequest, StrategyTag } from "../src/exchange/types.js";
import { State } from "../src/state.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

type PlaceArgs = Parameters<BetfairApi["placeOrders"]>[0];
type CancelArgs = Parameters<BetfairApi["cancelOrders"]>[0];
type ListArgs = Parameters<BetfairApi["listCurrentOrders"]>[0];
type ClearedArgs = Parameters<BetfairApi["listClearedOrders"]>[0];

/** FakeBetfair whose order calls can be scripted per test (timeouts, failures, odd reports). */
class ScriptedBetfair extends FakeBetfair {
  /** Replaces placeOrders; `real` places the orders in the fake without recording a second call. */
  place?: (args: PlaceArgs, real: () => Promise<PlaceExecutionReport>) => Promise<PlaceExecutionReport>;
  cancel?: (args: CancelArgs, real: () => Promise<CancelExecutionReport>) => Promise<CancelExecutionReport>;
  /** Called before listCurrentOrders answers; may throw or return a replacement answer. */
  list?: (args: ListArgs, attempt: number) => { currentOrders: CurrentOrderSummary[]; moreAvailable: boolean } | void;
  cleared_?: (args: ClearedArgs) => { clearedOrders: ClearedOrderSummary[]; moreAvailable: boolean } | void;
  accountDetailsFailures = 0;
  private listAttempts = 0;

  override async placeOrders(args: PlaceArgs) {
    if (!this.place) return super.placeOrders(args);
    this.calls.push({ method: "placeOrders", args });
    return this.place(args, async () => {
      const report = await super.placeOrders(args);
      this.calls.pop();
      return report;
    });
  }

  // FakeBetfair.cancelOrders infers a SUCCESS-only return type, hence the cast.
  override async cancelOrders(args: CancelArgs): ReturnType<FakeBetfair["cancelOrders"]> {
    if (!this.cancel) return super.cancelOrders(args);
    this.calls.push({ method: "cancelOrders", args });
    const report = await this.cancel(args, async () => {
      const real = await super.cancelOrders(args);
      this.calls.pop();
      return real;
    });
    return report as Awaited<ReturnType<FakeBetfair["cancelOrders"]>>;
  }

  override async listCurrentOrders(args: ListArgs) {
    const scripted = this.list?.(args, this.listAttempts++);
    if (scripted) {
      this.calls.push({ method: "listCurrentOrders", args });
      return scripted;
    }
    return super.listCurrentOrders(args);
  }

  override async listClearedOrders(args: ClearedArgs) {
    const scripted = this.cleared_?.(args);
    if (scripted) {
      this.calls.push({ method: "listClearedOrders", args });
      return scripted;
    }
    return super.listClearedOrders(args);
  }

  override async getAccountDetails() {
    if (this.accountDetailsFailures > 0) {
      this.accountDetailsFailures--;
      this.calls.push({ method: "getAccountDetails", args: {} });
      throw new BetfairApiError("Betfair getAccountDetails failed: TIMEOUT", "TIMEOUT");
    }
    return super.getAccountDetails();
  }

  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

function setup(overrides: { minBetSize?: number; minBetPayout?: number } = {}) {
  const fake = new ScriptedBetfair();
  const state = new State();
  const sleeps: number[] = [];
  const live = new LiveExchange(fake, state, overrides, { sleep: async (ms) => void sleeps.push(ms) });
  const strategy: StrategyTag = { name: "Bet 10 Euro", ref: state.strategyRefFor("Bet 10 Euro") };
  return { fake, state, live, sleeps, strategy };
}

const order = (selectionId: number, side: "BACK" | "LAY", price: number, size: number, handicap = 0): OrderRequest => ({
  selectionId,
  handicap,
  side,
  price,
  size,
  persistenceType: "LAPSE",
});

const CUSTOMER_REF = /^[A-Za-z0-9:\-._+*;~]{1,32}$/;

function liveOrder(betId: string, patch: Partial<CurrentOrderSummary> = {}): CurrentOrderSummary {
  return {
    betId,
    marketId: WIN_MARKET,
    selectionId: 101,
    handicap: 0,
    priceSize: { price: 3, size: 4 },
    side: "BACK",
    status: "EXECUTABLE",
    persistenceType: "LAPSE",
    orderType: "LIMIT",
    placedDate: "2026-10-19T12:00:00.000Z",
    sizeMatched: 0,
    sizeRemaining: 4,
    ...patch,
  };
}

function clearedBet(i: number, patch: Partial<ClearedOrderSummary> = {}): ClearedOrderSummary {
  return {
    betId: `C${i}`,
    marketId: WIN_MARKET,
    eventTypeId: "7",
    selectionId: 101,
    handicap: 0,
    side: "BACK",
    betOutcome: "WON",
    priceMatched: 3,
    sizeSettled: 2,
    profit: 4,
    placedDate: "2026-10-18T12:00:00.000Z",
    settledDate: "2026-10-18T13:00:00.000Z",
    itemDescription: { eventTypeDesc: "Horse Racing", eventDesc: "Ascot 18th Oct", marketDesc: "2m Hcap", runnerDesc: "Fast Horse", marketStartTime: "2026-10-18T12:30:00.000Z" },
    ...patch,
  };
}

describe("LiveExchange.placeOrders", () => {
  test("sends a unique customerRef per request, a unique customerOrderRef per instruction and the strategy ref", async () => {
    const { fake, live, state } = setup();
    const strategy = { name: "HorseRacing EV favourite", ref: state.strategyRefFor("HorseRacing EV favourite") };
    const bets = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2), order(102, "LAY", 6.2, 2.5), order(103, "BACK", 4.4, 0.1 + 0.2 + 1.7)], strategy);
    const [call] = fake.callsOf("placeOrders");
    const args = call.args as PlaceArgs;
    assert.match(args.customerRef!, CUSTOMER_REF);
    assert.equal(args.customerStrategyRef, strategy.ref);
    assert.ok(args.customerStrategyRef!.length <= 15);
    assert.equal(args.marketId, WIN_MARKET);
    const refs = args.instructions.map((i) => i.customerOrderRef!);
    assert.equal(new Set(refs).size, 3);
    for (const ref of refs) assert.match(ref, CUSTOMER_REF);
    assert.deepEqual(args.instructions[1], {
      orderType: "LIMIT",
      selectionId: 102,
      handicap: 0,
      side: "LAY",
      limitOrder: { size: 2.5, price: 6.2, persistenceType: "LAPSE" },
      customerOrderRef: refs[1],
    });
    // Float noise is stripped before sending (0.1 + 0.2 + 1.7 = 2.0000000000000004).
    assert.equal(args.instructions[2].limitOrder.size, 2);

    assert.deepEqual(
      bets.map((b) => [b.status, b.betId, b.selectionId, b.customerOrderRef]),
      [
        ["SUCCESS", "L1", "101", refs[0]],
        ["SUCCESS", "L2", "102", refs[1]],
        ["SUCCESS", "L3", "103", refs[2]],
      ],
    );
    assert.equal(bets[1].sizeMatched, 2.5);
    assert.equal(bets[1].averagePriceMatched, 6.2);
    assert.equal(bets[1].orderStatus, "EXECUTION_COMPLETE");

    await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy);
    const second = fake.callsOf("placeOrders")[1].args as PlaceArgs;
    assert.notEqual(second.customerRef, args.customerRef);
    assert.ok(!refs.includes(second.instructions[0].customerOrderRef!));
    // The order is attributed to the full strategy name when read back.
    const orders = await live.currentOrders([WIN_MARKET]);
    assert.ok(orders.every((o) => o.strategy === "HorseRacing EV favourite"));
  });

  test("an over-long or missing strategy ref falls back to the state's unique ref", async () => {
    const { fake, live, state } = setup();
    await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], { name: "Trade 2 Ticks Profit or 10 Ticks Loss", ref: "Trade 2 Ticks Profit or 10 Ticks Loss" });
    const ref = (fake.callsOf("placeOrders")[0].args as PlaceArgs).customerStrategyRef!;
    assert.ok(ref.length <= 15);
    assert.equal(state.strategyNameForRef(ref), "Trade 2 Ticks Profit or 10 Ticks Loss");
  });

  test("formats handicap selections like the rest of the connector", async () => {
    const { live, strategy } = setup();
    const [bet] = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 2.02, 2, -1.5)], strategy);
    assert.equal(bet.selectionId, "101_-1.50");
  });

  test("splits more than 200 instructions into requests of at most 200", async () => {
    const { fake, live, strategy } = setup();
    const orders = Array.from({ length: 450 }, (_, i) => order(101 + (i % 3), "BACK", 3, 2 + (i % 5)));
    const bets = await live.placeOrders(WIN_MARKET, orders, strategy);
    const calls = fake.callsOf("placeOrders").map((c) => c.args as PlaceArgs);
    assert.deepEqual(
      calls.map((c) => c.instructions.length),
      [200, 200, 50],
    );
    assert.equal(new Set(calls.map((c) => c.customerRef)).size, 3);
    const refs = calls.flatMap((c) => c.instructions.map((i) => i.customerOrderRef));
    assert.equal(new Set(refs).size, 450);
    assert.equal(bets.length, 450);
    bets.forEach((b, i) => {
      assert.equal(b.status, "SUCCESS");
      assert.equal(b.betId, `L${i + 1}`);
      assert.equal(b.size, orders[i].size);
      assert.equal(b.customerOrderRef, refs[i]);
    });
  });

  test("rejects bets below Betfair's minimum before sending them", async () => {
    const { fake, live, strategy } = setup();
    const bets = await live.placeOrders(
      WIN_MARKET,
      [
        order(101, "BACK", 3, 0.5), // payout 1.5 < 10 GBP
        order(102, "BACK", 25, 0.5), // payout 12.5 >= 10 GBP: allowed
        order(103, "LAY", 3, 2),
        order(103, "LAY", Number.NaN, 2),
        order(103, "BACK", 3, 0),
      ],
      strategy,
    );
    assert.deepEqual(
      bets.map((b) => [b.status, b.errorCode]),
      [
        ["FAILURE", "INVALID_BET_SIZE"],
        ["SUCCESS", undefined],
        ["SUCCESS", undefined],
        ["FAILURE", "INVALID_ODDS"],
        ["FAILURE", "INVALID_BET_SIZE"],
      ],
    );
    const calls = fake.callsOf("placeOrders");
    assert.equal(calls.length, 1);
    assert.deepEqual(
      (calls[0].args as PlaceArgs).instructions.map((i) => i.selectionId),
      [102, 103],
    );

    // Nothing valid: Betfair is not called at all.
    const none = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 0.5)], strategy);
    assert.equal(none[0].status, "FAILURE");
    assert.equal(fake.callsOf("placeOrders").length, 1);
  });

  test("minimum bet rules follow the account currency and the configured overrides", async () => {
    const { fake, live, strategy } = setup({ minBetSize: 5 });
    fake.currencyCode = "EUR";
    const bets = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 4), order(101, "BACK", 3, 5), order(101, "BACK", 6, 4)], strategy);
    // EUR payout rule: 4 x 6 = 24 >= 20.
    assert.deepEqual(
      bets.map((b) => b.status),
      ["FAILURE", "SUCCESS", "SUCCESS"],
    );
  });

  test("reports the execution-level reason when instructions only say ERROR_IN_ORDER", async () => {
    const { fake, live, strategy } = setup();
    const report = (status: PlaceExecutionReport["status"], errorCode: string | undefined, instructions: Array<[string, string?]>) => (args: PlaceArgs) =>
      Promise.resolve<PlaceExecutionReport>({
        status,
        errorCode,
        marketId: args.marketId,
        instructionReports: args.instructions.map((instruction, i) => ({
          status: instructions[i][0] as "SUCCESS" | "FAILURE",
          errorCode: instructions[i][1],
          instruction,
          betId: instructions[i][0] === "SUCCESS" ? `B${i}` : undefined,
          sizeMatched: 0,
          averagePriceMatched: 0,
        })),
      });
    const two = [order(101, "BACK", 3, 2), order(102, "BACK", 6, 2)];

    fake.place = report("FAILURE", "INSUFFICIENT_FUNDS", [["FAILURE", "ERROR_IN_ORDER"], ["FAILURE", "ERROR_IN_ORDER"]]);
    assert.deepEqual(
      (await live.placeOrders(WIN_MARKET, two, strategy)).map((b) => [b.status, b.errorCode]),
      [
        ["FAILURE", "INSUFFICIENT_FUNDS (ERROR_IN_ORDER)"],
        ["FAILURE", "INSUFFICIENT_FUNDS (ERROR_IN_ORDER)"],
      ],
    );

    fake.place = report("FAILURE", "MARKET_SUSPENDED", [["FAILURE", "ERROR_IN_ORDER"], ["FAILURE", "ERROR_IN_ORDER"]]);
    assert.equal((await live.placeOrders(WIN_MARKET, two, strategy))[0].errorCode, "MARKET_SUSPENDED (ERROR_IN_ORDER)");

    // BET_ACTION_ERROR: the failing instruction carries the real reason; its sibling keeps ERROR_IN_ORDER.
    fake.place = report("FAILURE", "BET_ACTION_ERROR", [["FAILURE", "INVALID_ODDS"], ["FAILURE", "ERROR_IN_ORDER"]]);
    assert.deepEqual(
      (await live.placeOrders(WIN_MARKET, two, strategy)).map((b) => b.errorCode),
      ["INVALID_ODDS", "ERROR_IN_ORDER"],
    );

    fake.place = report("PROCESSED_WITH_ERRORS", "PROCESSED_WITH_ERRORS", [["SUCCESS"], ["FAILURE", "ERROR_IN_ORDER"]]);
    const mixed = await live.placeOrders(WIN_MARKET, two, strategy);
    assert.deepEqual(
      mixed.map((b) => [b.status, b.errorCode, b.betId]),
      [
        ["SUCCESS", undefined, "B0"],
        ["FAILURE", "ERROR_IN_ORDER", undefined],
      ],
    );
    // Betfair reports averagePriceMatched 0 when nothing matched.
    assert.equal(mixed[0].averagePriceMatched, undefined);

    // A failed request without instruction reports.
    fake.place = (args) => Promise.resolve({ status: "FAILURE", errorCode: "INVALID_MARKET_ID", marketId: args.marketId });
    assert.deepEqual(
      (await live.placeOrders(WIN_MARKET, two, strategy)).map((b) => [b.status, b.errorCode]),
      [
        ["FAILURE", "INVALID_MARKET_ID"],
        ["FAILURE", "INVALID_MARKET_ID"],
      ],
    );
    // Definite failures are never "reconciled".
    assert.equal(fake.callsOf("listCurrentOrders").length, 0);
  });

  test("matches instruction reports by customerOrderRef, not position", async () => {
    const { fake, live, strategy } = setup();
    fake.place = async (_args, real) => {
      const r = await real();
      return { ...r, instructionReports: [...r.instructionReports!].reverse() };
    };
    const bets = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2), order(102, "BACK", 6, 3)], strategy);
    assert.deepEqual(
      bets.map((b) => [b.selectionId, b.betId, b.sizeMatched]),
      [
        ["101", "L1", 2],
        ["102", "L2", 3],
      ],
    );
  });

  test("a timed-out request is reconciled: the order is found and reported placed", async () => {
    const { fake, live, strategy, sleeps } = setup();
    fake.place = async (_args, real) => {
      await real(); // Betfair placed the bet, but the answer never arrived.
      throw new BetfairApiError("Betfair placeOrders failed: timed out after 30000 ms", "TIMEOUT");
    };
    const [bet] = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy);
    assert.equal(bet.status, "SUCCESS");
    assert.equal(bet.betId, "L1");
    assert.equal(bet.sizeMatched, 2);
    assert.equal(bet.averagePriceMatched, 3);
    assert.equal(bet.orderStatus, "EXECUTION_COMPLETE");
    const lists = fake.callsOf("listCurrentOrders");
    assert.equal(lists.length, 1);
    const placed = fake.callsOf("placeOrders")[0].args as PlaceArgs;
    assert.deepEqual(lists[0].args.customerOrderRefs, [placed.instructions[0].customerOrderRef]);
    assert.deepEqual(lists[0].args.marketIds, [WIN_MARKET]);
    assert.deepEqual(sleeps, []);
  });

  test("an unconfirmed order is UNKNOWN (never FAILURE) after a second look", async () => {
    const { fake, live, strategy, sleeps } = setup();
    fake.place = async () => {
      throw new BetfairApiError("Betfair placeOrders failed: timed out after 30000 ms", "TIMEOUT");
    };
    const [bet] = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy);
    assert.equal(bet.status, "UNKNOWN");
    assert.equal(bet.errorCode, UNCONFIRMED);
    assert.equal(bet.errorCode, "TIMEOUT_UNCONFIRMED: check get_current_orders before retrying");
    assert.match(bet.customerOrderRef!, CUSTOMER_REF);
    assert.equal(fake.callsOf("listCurrentOrders").length, 2);
    assert.deepEqual(sleeps, [1000]);
  });

  test("an order that only shows up on the second look is reported placed", async () => {
    const { fake, live, strategy, sleeps } = setup();
    fake.place = async (_args, real) => {
      await real();
      throw new BetfairApiError("Betfair placeOrders failed: network error (fetch failed: ECONNRESET)", "NETWORK_ERROR");
    };
    fake.list = (_args, attempt) => (attempt === 0 ? { currentOrders: [], moreAvailable: false } : undefined);
    const [bet] = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy);
    assert.equal(bet.status, "SUCCESS");
    assert.equal(bet.betId, "L1");
    assert.deepEqual(sleeps, [1000]);
  });

  test("a failing reconciliation leaves the order UNKNOWN", async () => {
    const { fake, live, strategy } = setup();
    fake.place = async (_args, real) => {
      await real();
      throw new BetfairApiError("Betfair placeOrders failed: timed out", "TIMEOUT");
    };
    fake.list = () => {
      throw new BetfairApiError("Betfair listCurrentOrders failed: network error", "NETWORK_ERROR");
    };
    const [bet] = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy);
    assert.equal(bet.status, "UNKNOWN");
    assert.equal(bet.errorCode, UNCONFIRMED);
  });

  test("TIMEOUT reports from Betfair are reconciled, only for the instructions concerned", async () => {
    const { fake, live, strategy } = setup();
    // Execution-level TIMEOUT without instruction reports; Betfair did place the bet.
    fake.place = async (args, real) => {
      await real();
      return { status: "TIMEOUT", marketId: args.marketId };
    };
    const [bet] = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy);
    assert.equal(bet.status, "SUCCESS");
    assert.equal(bet.betId, "L1");

    // Instruction-level TIMEOUT for the second of two orders, which was not placed.
    fake.calls.length = 0;
    fake.place = async (args) => ({
      status: "PROCESSED_WITH_ERRORS",
      marketId: args.marketId,
      instructionReports: [
        { status: "SUCCESS", instruction: args.instructions[0], betId: "B1", sizeMatched: 2, averagePriceMatched: 3, orderStatus: "EXECUTION_COMPLETE" },
        { status: "TIMEOUT", instruction: args.instructions[1] },
      ],
    });
    const bets = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2), order(102, "BACK", 6, 2)], strategy);
    assert.deepEqual(
      bets.map((b) => [b.status, b.betId, b.errorCode]),
      [
        ["SUCCESS", "B1", undefined],
        ["UNKNOWN", undefined, UNCONFIRMED],
      ],
    );
    const placed = fake.callsOf("placeOrders")[0].args as PlaceArgs;
    for (const list of fake.callsOf("listCurrentOrders")) assert.deepEqual(list.args.customerOrderRefs, [placed.instructions[1].customerOrderRef]);
  });

  test("transport-level and unexpected errors are treated as unknown outcomes", async () => {
    for (const error of [
      new BetfairApiError("Betfair placeOrders returned HTTP 503: <html>", "HTTP_503"),
      new BetfairApiError("Betfair placeOrders failed: UNEXPECTED_ERROR", "UNEXPECTED_ERROR"),
      new BetfairApiError("Betfair placeOrders failed: TIMEOUT_ERROR", "TIMEOUT_ERROR"),
      new Error("socket hang up"),
    ]) {
      const { fake, live, strategy } = setup();
      fake.place = async () => {
        throw error;
      };
      const [bet] = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy);
      assert.equal(bet.status, "UNKNOWN", (error as Error).message);
      assert.equal(fake.callsOf("listCurrentOrders").length, 2);
    }
  });

  test("DUPLICATE_TRANSACTION means an earlier identical request was processed: the orders are looked up", async () => {
    const { fake, live, strategy } = setup();
    fake.place = async (args, real) => {
      await real();
      return {
        status: "FAILURE",
        errorCode: "DUPLICATE_TRANSACTION",
        marketId: args.marketId,
        instructionReports: args.instructions.map((instruction) => ({ status: "FAILURE" as const, errorCode: "ERROR_IN_ORDER", instruction })),
      };
    };
    const [bet] = await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy);
    assert.equal(bet.status, "SUCCESS");
    assert.equal(bet.betId, "L1");
  });

  test("errors proving nothing was sent are thrown before any request went out, and never hide placed bets", async () => {
    const { fake, live, strategy } = setup();
    fake.place = async () => {
      throw new BetfairApiError("Betfair placeOrders failed: INVALID_INPUT_DATA", "INVALID_INPUT_DATA");
    };
    await assert.rejects(live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy), /INVALID_INPUT_DATA/);
    assert.equal(fake.callsOf("listCurrentOrders").length, 0);

    // The first request placed 200 bets; the second is rejected outright.
    let request = 0;
    fake.place = async (_args, real) => {
      if (request++ === 0) return real();
      throw new BetfairApiError("Betfair placeOrders failed: TOO_MANY_REQUESTS", "TOO_MANY_REQUESTS");
    };
    const bets = await live.placeOrders(
      WIN_MARKET,
      Array.from({ length: 210 }, () => order(101, "BACK", 3, 2)),
      strategy,
    );
    assert.equal(bets.filter((b) => b.status === "SUCCESS").length, 200);
    assert.deepEqual(
      [...new Set(bets.slice(200).map((b) => `${b.status} ${b.errorCode}`))],
      ["FAILURE TOO_MANY_REQUESTS"],
    );
  });

  test("login and configuration errors are thrown (nothing was sent)", async () => {
    const { fake, live, strategy } = setup();
    fake.place = async () => {
      throw new BetfairApiError("Betfair login failed: INVALID_USERNAME_OR_PASSWORD. Login attempts are stopped", "INVALID_USERNAME_OR_PASSWORD");
    };
    await assert.rejects(live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], strategy), /INVALID_USERNAME_OR_PASSWORD/);
    assert.equal(fake.callsOf("listCurrentOrders").length, 0);
  });
});

describe("LiveExchange.cancelOrders", () => {
  test("an empty list cancels nothing and never reaches Betfair", async () => {
    const { fake, live } = setup();
    fake.liveOrders.push(liveOrder("1"), liveOrder("2"));
    assert.deepEqual(await live.cancelOrders(WIN_MARKET, []), []);
    assert.equal(fake.calls.length, 0);
    assert.ok(fake.liveOrders.every((o) => o.sizeRemaining === 4));
  });

  test("ALL lists the market's unmatched bets and cancels them by explicit betId", async () => {
    const { fake, live } = setup();
    fake.liveOrders.push(
      liveOrder("1"),
      liveOrder("2", { selectionId: 102, side: "LAY", sizeRemaining: 1.5 }),
      liveOrder("3", { status: "EXECUTION_COMPLETE", sizeRemaining: 0, sizeMatched: 4 }),
      liveOrder("4", { marketId: PLACE_MARKET }),
    );
    const cancelled = await live.cancelOrders(WIN_MARKET, "ALL");
    assert.deepEqual(cancelled, [
      { betId: "1", sizeCancelled: 4, status: "SUCCESS" },
      { betId: "2", sizeCancelled: 1.5, status: "SUCCESS" },
    ]);
    const [list, cancel] = fake.calls;
    assert.equal(list.method, "listCurrentOrders");
    assert.deepEqual(list.args.marketIds, [WIN_MARKET]);
    assert.equal(list.args.orderProjection, "EXECUTABLE");
    assert.equal(cancel.method, "cancelOrders");
    assert.deepEqual(cancel.args, { marketId: WIN_MARKET, instructions: [{ betId: "1" }, { betId: "2" }] });
    assert.equal(fake.liveOrders[3].sizeRemaining, 4); // other market untouched

    // Nothing unmatched left: no cancel request at all (an empty one would cancel everything).
    fake.calls.length = 0;
    assert.deepEqual(await live.cancelOrders(WIN_MARKET, "ALL"), []);
    assert.deepEqual(
      fake.calls.map((c) => c.method),
      ["listCurrentOrders"],
    );
  });

  test("ALL pages through every unmatched bet and cancels them 60 at a time", async () => {
    const { fake, live } = setup();
    for (let i = 1; i <= 1130; i++) fake.liveOrders.push(liveOrder(String(i)));
    const cancelled = await live.cancelOrders(WIN_MARKET, "ALL");
    assert.equal(cancelled.length, 1130);
    assert.ok(cancelled.every((c) => c.status === "SUCCESS" && c.sizeCancelled === 4));
    assert.deepEqual(
      fake.callsOf("listCurrentOrders").map((c) => c.args.fromRecord),
      [0, 1000],
    );
    const sizes = fake.callsOf("cancelOrders").map((c) => c.args.instructions.length);
    assert.equal(sizes.length, 19);
    assert.ok(sizes.every((n: number) => n > 0 && n <= 60));
  });

  test("explicit ids are de-duplicated, chunked at 60 and get one result each", async () => {
    const { fake, live } = setup();
    for (let i = 1; i <= 130; i++) fake.liveOrders.push(liveOrder(String(i)));
    const ids = [...Array.from({ length: 130 }, (_, i) => String(i + 1)), "5"];
    const cancelled = await live.cancelOrders(WIN_MARKET, ids);
    assert.deepEqual(
      fake.callsOf("cancelOrders").map((c) => c.args.instructions.length),
      [60, 60, 10],
    );
    assert.deepEqual(
      cancelled.map((c) => c.betId),
      ids.slice(0, 130),
    );
    assert.ok(cancelled.every((c) => c.status === "SUCCESS"));
    for (const call of fake.callsOf("cancelOrders")) assert.equal(call.args.marketId, WIN_MARKET);
  });

  test("maps per-bet errors by betId, including the execution-level reason", async () => {
    const { fake, live } = setup();
    fake.cancel = async (args) => ({
      status: "PROCESSED_WITH_ERRORS",
      errorCode: "PROCESSED_WITH_ERRORS",
      marketId: args.marketId!,
      // Reports in a different order from the instructions.
      instructionReports: [
        { status: "FAILURE", errorCode: "BET_TAKEN_OR_LAPSED", instruction: { betId: "2" }, sizeCancelled: 0 },
        { status: "SUCCESS", instruction: { betId: "1" }, sizeCancelled: 2.5 },
      ],
    });
    assert.deepEqual(await live.cancelOrders(WIN_MARKET, ["1", "2", "3"]), [
      { betId: "1", sizeCancelled: 2.5, status: "SUCCESS" },
      { betId: "2", sizeCancelled: 0, status: "BET_TAKEN_OR_LAPSED" },
      { betId: "3", sizeCancelled: 0, status: "PROCESSED_WITH_ERRORS" },
    ]);

    fake.cancel = async (args) => ({
      status: "FAILURE",
      errorCode: "MARKET_SUSPENDED",
      marketId: args.marketId!,
      instructionReports: args.instructions!.map((instruction) => ({ status: "FAILURE" as const, errorCode: "ERROR_IN_ORDER", instruction })),
    });
    assert.deepEqual(
      (await live.cancelOrders(WIN_MARKET, ["1"]))[0],
      { betId: "1", sizeCancelled: 0, status: "MARKET_SUSPENDED (ERROR_IN_ORDER)" },
    );
  });

  test("a failed request throws only when nothing was sent yet; later failures are reported per bet", async () => {
    const { fake, live } = setup();
    fake.cancel = async () => {
      throw new BetfairApiError("Betfair cancelOrders failed: INVALID_SESSION_INFORMATION", "INVALID_SESSION_INFORMATION");
    };
    await assert.rejects(live.cancelOrders(WIN_MARKET, ["1"]), /INVALID_SESSION_INFORMATION/);

    for (let i = 1; i <= 70; i++) fake.liveOrders.push(liveOrder(String(i)));
    let request = 0;
    fake.cancel = async (_args, real) => {
      if (request++ === 0) return real();
      throw new BetfairApiError("Betfair cancelOrders failed: timed out", "TIMEOUT");
    };
    const results = await live.cancelOrders(WIN_MARKET, "ALL");
    assert.equal(results.length, 70);
    assert.ok(results.slice(0, 60).every((r) => r.status === "SUCCESS"));
    assert.ok(results.slice(60).every((r) => r.status === "TIMEOUT" && r.sizeCancelled === 0));

    // An uncertain failure of the very first request is reported per bet, not thrown.
    fake.cancel = async () => {
      throw new BetfairApiError("Betfair cancelOrders failed: network error", "NETWORK_ERROR");
    };
    assert.deepEqual(await live.cancelOrders(WIN_MARKET, ["61"]), [{ betId: "61", sizeCancelled: 0, status: "NETWORK_ERROR" }]);
  });
});

describe("LiveExchange reads", () => {
  test("currentOrders pages through every order and maps strategy refs back to names", async () => {
    const { fake, live, state } = setup();
    const favourite = state.strategyRefFor("HorseRacing EV favourite");
    const outsider = state.strategyRefFor("HorseRacing EV outsider");
    assert.notEqual(favourite, outsider);
    for (let i = 1; i <= 2500; i++) fake.liveOrders.push(liveOrder(String(i), { customerStrategyRef: i % 2 ? favourite : outsider }));
    fake.liveOrders.push(
      liveOrder("M1", {
        selectionId: 102,
        handicap: -1.5,
        side: "LAY",
        priceSize: { price: 3.1, size: 10 },
        status: "EXECUTION_COMPLETE",
        sizeMatched: 9,
        averagePriceMatched: 3.0333333333,
        sizeRemaining: 0,
        sizeVoided: 1,
        matchedDate: "2026-10-19T12:01:00.000Z",
        customerStrategyRef: "Old BFExplorer",
        customerOrderRef: "abc-1",
      }),
      liveOrder("M2", { status: "PENDING", averagePriceMatched: 0 }),
    );
    const orders = await live.currentOrders();
    assert.equal(orders.length, 2502);
    const pages = fake.callsOf("listCurrentOrders");
    assert.deepEqual(
      pages.map((c) => [c.args.fromRecord, c.args.recordCount, c.args.orderProjection, c.args.marketIds]),
      [
        [0, 1000, "ALL", undefined],
        [1000, 1000, "ALL", undefined],
        [2000, 1000, "ALL", undefined],
      ],
    );
    assert.equal(orders[0].strategy, "HorseRacing EV favourite");
    assert.equal(orders[1].strategy, "HorseRacing EV outsider");
    assert.deepEqual(orders[2500], {
      betId: "M1",
      marketId: WIN_MARKET,
      selectionId: "102_-1.50",
      side: "LAY",
      price: 3.1,
      size: 10,
      sizeMatched: 9,
      averagePriceMatched: 3.0333333333,
      sizeRemaining: 0,
      sizeVoided: 1,
      status: "EXECUTION_COMPLETE",
      persistenceType: "LAPSE",
      placedDate: "2026-10-19T12:00:00.000Z",
      matchedDate: "2026-10-19T12:01:00.000Z",
      strategy: "Old BFExplorer",
      customerOrderRef: "abc-1",
    });
    assert.equal(orders[2501].status, "EXECUTABLE");
    assert.equal(orders[2501].averagePriceMatched, undefined);
    assert.equal(orders[2501].strategy, undefined);
  });

  test("currentOrders splits market ids into groups of 250", async () => {
    const { fake, live } = setup();
    const ids = Array.from({ length: 600 }, (_, i) => `1.${300000000 + i}`);
    await live.currentOrders([...ids, ids[0]]);
    assert.deepEqual(
      fake.callsOf("listCurrentOrders").map((c) => c.args.marketIds.length),
      [250, 250, 100],
    );
    fake.calls.length = 0;
    assert.deepEqual(await live.currentOrders([]), []);
    assert.equal(fake.calls.length, 0);
  });

  test("settledBets pages, maps the bets and adds the commission of the same markets", async () => {
    const { fake, live, state } = setup();
    const ref = state.strategyRefFor("HorseRacing EV favourite");
    for (let i = 0; i < 2500; i++) {
      fake.cleared.push(clearedBet(i, { marketId: `1.10${i % 3}`, customerStrategyRef: i === 0 ? ref : undefined, commission: i % 3 === 0 ? 0.01 : 0.02 }));
    }
    // Betfair may ignore the market filter of the MARKET rollup: other markets must not count.
    fake.cleared_ = (args) =>
      args.groupBy === "MARKET" ? { clearedOrders: [{ marketId: "1.999", commission: 50 }, { marketId: "1.100", commission: 8.34 }, { marketId: "1.101", commission: 16.66 }, { marketId: "1.102", commission: 16.66 }], moreAvailable: false } : undefined;
    const from = new Date("2026-10-12T00:00:00.000Z");
    const settled = await live.settledBets(from);
    assert.equal(settled.bets.length, 2500);
    assert.equal(settled.truncated, undefined);
    assert.ok(Math.abs(settled.commission! - 41.66) < 1e-9);
    const calls = fake.callsOf("listClearedOrders");
    const betCalls = calls.filter((c) => !c.args.groupBy);
    assert.deepEqual(
      betCalls.map((c) => [c.args.betStatus, c.args.fromRecord, c.args.recordCount, c.args.includeItemDescription, c.args.settledDateRange.from]),
      [
        ["SETTLED", 0, 1000, true, from.toISOString()],
        ["SETTLED", 1000, 1000, true, from.toISOString()],
        ["SETTLED", 2000, 1000, true, from.toISOString()],
      ],
    );
    const [rollup] = calls.filter((c) => c.args.groupBy === "MARKET");
    assert.equal(rollup.args.betStatus, "SETTLED");
    assert.deepEqual([...rollup.args.marketIds].sort(), ["1.100", "1.101", "1.102"]);
    assert.deepEqual(settled.bets[0], {
      betId: "C0",
      marketId: "1.100",
      selectionId: "101",
      eventType: "Horse Racing",
      event: "Ascot 18th Oct",
      market: "2m Hcap",
      selection: "Fast Horse",
      marketStartTime: "2026-10-18T12:30:00.000Z",
      side: "BACK",
      priceMatched: 3,
      sizeSettled: 2,
      outcome: "WON",
      profit: 4,
      placedDate: "2026-10-18T12:00:00.000Z",
      lastMatchedDate: undefined,
      settledDate: "2026-10-18T13:00:00.000Z",
      strategy: "HorseRacing EV favourite",
    });
    assert.equal(settled.bets[1].strategy, undefined);
  });

  test("settledBets commission sums the fake's MARKET rollup for the bets' markets", async () => {
    const { fake, live } = setup();
    fake.cleared.push(clearedBet(1, { commission: 0.2 }), clearedBet(2, { commission: 0.3 }), clearedBet(3, { marketId: PLACE_MARKET, commission: 0.5, profit: -2, betOutcome: "LOST" }));
    const settled = await live.settledBets(new Date(Date.now() - 86400_000), [WIN_MARKET, PLACE_MARKET]);
    assert.ok(Math.abs(settled.commission! - 1) < 1e-9);
    assert.deepEqual(
      settled.bets.map((b) => [b.betId, b.outcome, b.profit]),
      [
        ["C1", "WON", 4],
        ["C2", "WON", 4],
        ["C3", "LOST", -2],
      ],
    );
  });

  test("settledBets commission is a whole number of pennies (no float noise from summing markets)", async () => {
    const { fake, live } = setup();
    const markets = ["1.1", "1.2", "1.3"];
    // Per-market commissions 0.1 + 0.2 + 0.3: a plain float sum gives 0.6000000000000001.
    [0.1, 0.2, 0.3].forEach((commission, i) => fake.cleared.push(clearedBet(i, { marketId: markets[i], commission })));
    const settled = await live.settledBets(new Date(Date.now() - 86400_000), markets);
    assert.equal(settled.commission, 0.6);
  });

  test("settledBets stops at 10000 bets and says the list is truncated", async () => {
    const { fake, live } = setup();
    for (let i = 0; i < 10500; i++) fake.cleared.push(clearedBet(i, { marketId: i < 10000 ? WIN_MARKET : PLACE_MARKET, commission: 0.01 }));
    const settled = await live.settledBets(new Date(0));
    assert.equal(settled.bets.length, 10000);
    assert.equal(settled.truncated, true);
    assert.equal(fake.callsOf("listClearedOrders").filter((c) => !c.args.groupBy).length, 10);
    const [rollup] = fake.callsOf("listClearedOrders").filter((c) => c.args.groupBy === "MARKET");
    assert.deepEqual(rollup.args.marketIds, [WIN_MARKET]);
    assert.ok(Math.abs(settled.commission! - 100) < 1e-6);

    // Exactly 10000 bets: complete, not truncated.
    const exact = setup();
    for (let i = 0; i < 10000; i++) exact.fake.cleared.push(clearedBet(i));
    const all = await exact.live.settledBets(new Date(0));
    assert.equal(all.bets.length, 10000);
    assert.equal(all.truncated, undefined);
  });

  test("settledBets splits market ids into groups of 250 and keeps the bets when commission fails", async () => {
    const { fake, live } = setup();
    fake.cleared.push(clearedBet(1));
    fake.cleared_ = (args) => {
      if (args.groupBy) throw new BetfairApiError("Betfair listClearedOrders failed: TOO_MANY_REQUESTS", "TOO_MANY_REQUESTS");
    };
    const ids = [WIN_MARKET, ...Array.from({ length: 299 }, (_, i) => `1.${300000000 + i}`)];
    const original = console.error;
    console.error = () => {};
    try {
      const settled = await live.settledBets(new Date(0), ids);
      assert.equal(settled.bets.length, 1);
      assert.equal(settled.commission, undefined);
    } finally {
      console.error = original;
    }
    assert.deepEqual(
      fake.callsOf("listClearedOrders").filter((c) => !c.args.groupBy).map((c) => c.args.marketIds.length),
      [250, 50],
    );
    fake.calls.length = 0;
    assert.deepEqual(await live.settledBets(new Date(0), []), { bets: [], commission: 0 });
    assert.equal(fake.calls.length, 0);
  });

  test("currencyRules come from the account currency, read once", async () => {
    const { fake, live } = setup();
    fake.currencyCode = "EUR";
    assert.deepEqual(await live.currencyRules(), { currency: "EUR", minBetSize: 1, minBetPayout: 20 });
    await live.currencyRules();
    await live.placeOrders(WIN_MARKET, [order(101, "BACK", 3, 2)], { name: "x", ref: "x" });
    assert.equal(fake.callsOf("getAccountDetails").length, 1);

    const overridden = setup({ minBetSize: 2, minBetPayout: 15 });
    overridden.fake.currencyCode = "usd";
    assert.deepEqual(await overridden.live.currencyRules(), { currency: "USD", minBetSize: 2, minBetPayout: 15 });
  });

  test("a failed account-details read is retried on the next call", async () => {
    const { fake, live } = setup();
    fake.accountDetailsFailures = 1;
    await assert.rejects(live.currencyRules(), /TIMEOUT/);
    assert.equal((await live.currencyRules()).currency, "GBP");
    assert.equal(fake.callsOf("getAccountDetails").length, 2);
  });

  test("accountFunds reports the live balance with a positive exposure", async () => {
    const { fake, live } = setup();
    fake.funds = { ...fake.funds, exposure: -20.5, retainedCommission: 1.25 };
    assert.deepEqual(await live.accountFunds(), {
      mode: "live",
      currency: "GBP",
      availableToBetBalance: 500,
      exposure: 20.5,
      retainedCommission: 1.25,
      exposureLimit: -10000,
      discountRate: undefined,
      pointsBalance: undefined,
    });
  });

  test("live mode has no pending markets to poll", () => {
    const { live } = setup();
    assert.deepEqual(live.pendingMarketIds(), []);
    assert.equal(live.mode, "live");
  });
});
