// Regression test from a second independent review (high): the guard reads the kill switch once, when a request arrives
// (guard.ts guardedPlace: killAtCheck), then reads the market and waits for the account section
// (account funds, today's settled bets; queued behind other requests). A switch engaged in that
// time is not checked again before the order is sent: the bet goes to the exchange after the
// switch is on, and its matched part stands (cancelLanded only takes back what rests).
// The same holds for addRiskBlocked (READ_ONLY_PROCESS), read once in assess().
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

const sentInstructions = (fake: FakeBetfair) => fake.calls.filter((call) => call.method === "placeOrders").flatMap((call) => call.args.instructions);

describe("review 2: a kill switch engaged while a request is being checked", () => {
  test("live: a back still in its account check when the switch engages is sent afterwards and matched", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    // Betfair answers getAccountFunds slowly (the guard's account check).
    const original = fake.getAccountFunds.bind(fake);
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => (entered = resolve));
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    fake.getAccountFunds = async () => {
      entered();
      await answered;
      return original();
    };

    const placing = c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG);
    await checking; // nothing has been sent yet
    assert.equal(sentInstructions(fake).length, 0);
    const report = await c.engageKillSwitch("the human pressed stop");
    fake.getAccountFunds = original;
    answer();
    const [bet] = await placing;

    const sent = sentInstructions(fake);
    assert.equal(
      sent.length,
      0,
      `the kill switch was engaged at ${report.killSwitch.engagedAt}, before anything was sent, yet BACK 10 @ 3.0 reached Betfair afterwards (${bet.status}, matched ${bet.sizeMatched})`,
    );
  });

  test("paper: requests queued behind a slow account check are all placed after the switch", async () => {
    const fake = new FakeBetfair();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" }), fake);
    const inner = c.guard.inner;
    const funds = inner.accountFunds.bind(inner);
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => (entered = resolve));
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    let first = true;
    inner.accountFunds = async () => {
      if (first) {
        first = false;
        entered();
        await answered;
      }
      return funds();
    };

    const a = c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG);
    const b = c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 10)], TAG);
    await checking;
    await new Promise((resolve) => setTimeout(resolve, 20)); // b has read its market and waits for the account section
    await c.engageKillSwitch("stop");
    answer();
    const placed = [...(await a), ...(await b)].filter((bet) => bet.status === "SUCCESS");
    assert.equal(placed.length, 0, `placed after the kill switch was engaged: ${placed.map((bet) => `BACK ${bet.size} @ ${bet.price} matched ${bet.sizeMatched}`).join(", ")}`);
  });
});
