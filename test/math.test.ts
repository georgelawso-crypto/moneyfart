import assert from "node:assert/strict";
import { test } from "node:test";
import { LADDER, LADDERS, isValidPrice, offsetTicks, roundForSide, roundToTick, ticksBetween } from "../src/betfair/ticks.js";
import { betSizeProblem, currencyRules } from "../src/betfair/currency.js";
import { betOutcomeProfit, dutchStakes, hedgeOrder } from "../src/exchange/math.js";
import { formatSelectionId, parseSelectionId } from "../src/format.js";

test("price ladder has every Betfair tick", () => {
  assert.equal(LADDER.length, 350);
  assert.equal(LADDER[0], 1.01);
  assert.equal(LADDER.at(-1), 1000);
  assert.equal(LADDERS.FINEST.length, 99900);
  for (const price of [1.01, 1.99, 2, 2.02, 3.05, 4.1, 6.2, 10.5, 21, 32, 55, 110]) assert.ok(isValidPrice(price), `${price}`);
  for (const price of [2.01, 3.02, 4.15, 6.1, 10.2, 21.5, 31, 52, 105, 1.994]) assert.ok(!isValidPrice(price), `${price}`);
  assert.ok(isValidPrice(2.03, "FINEST"));
});

test("rounding respects the side of the bet on the raw price", () => {
  assert.equal(roundToTick(2.03, "up"), 2.04);
  assert.equal(roundToTick(2.03, "down"), 2.02);
  assert.equal(roundForSide(5.55, "BACK"), 5.6);
  assert.equal(roundForSide(5.55, "LAY"), 5.5);
  // Regressions: pre-rounding to cents used to move these the wrong way.
  assert.equal(roundForSide(1.994, "BACK"), 2.0);
  assert.equal(roundForSide(1.996, "LAY"), 1.99);
  assert.equal(roundForSide(2.004, "BACK"), 2.02);
  assert.equal(roundForSide(1.923, "BACK"), 1.93);
  assert.equal(roundForSide(1200, "BACK"), undefined);
  assert.equal(roundForSide(1.0, "LAY"), undefined);
  assert.equal(roundToTick(0.5), 1.01);
  assert.equal(roundToTick(5000), 1000);
  assert.equal(roundForSide(2.03, "BACK", "FINEST"), 2.03);
});

test("tick offsets cross band boundaries", () => {
  assert.equal(offsetTicks(2, 1), 2.02);
  assert.equal(offsetTicks(2, -1), 1.99);
  assert.equal(offsetTicks(3, -2), 2.96);
  assert.equal(offsetTicks(1000, 5), 1000);
  assert.equal(ticksBetween(2, 2.1), 5);
});

test("selection ids are bare unless the handicap is non-zero", () => {
  assert.equal(formatSelectionId(12345, 0), "12345");
  assert.equal(formatSelectionId(12345, -1.5), "12345_-1.50");
  assert.deepEqual(parseSelectionId("12345_0.00"), { selectionId: 12345, handicap: 0 });
  assert.deepEqual(parseSelectionId("12345_-1.50"), { selectionId: 12345, handicap: -1.5 });
  assert.deepEqual(parseSelectionId("12345"), { selectionId: 12345, handicap: 0 });
  assert.deepEqual(parseSelectionId(12345), { selectionId: 12345, handicap: 0 });
  assert.throws(() => parseSelectionId("horse"));
});

test("hedge stake equalises profit", () => {
  // Backed 10 @ 4.0, price now 3.0: lay 13.33 @ 3.0 locks in 3.33 either way.
  const position = { ifWin: betOutcomeProfit("BACK", 4, 10, true), ifLose: betOutcomeProfit("BACK", 4, 10, false) };
  const hedge = hedgeOrder(position, 2.98, 3.0)!;
  assert.equal(hedge.side, "LAY");
  assert.equal(hedge.size, 13.33);
  const win = position.ifWin + betOutcomeProfit("LAY", hedge.price, hedge.size, true);
  const lose = position.ifLose + betOutcomeProfit("LAY", hedge.price, hedge.size, false);
  assert.ok(Math.abs(win - lose) < 0.02);

  // Laid 10 @ 3.0, price now 4.0: back to close for an equal loss.
  const layPosition = { ifWin: betOutcomeProfit("LAY", 3, 10, true), ifLose: betOutcomeProfit("LAY", 3, 10, false) };
  const backHedge = hedgeOrder(layPosition, 4.0, 4.1)!;
  assert.equal(backHedge.side, "BACK");
  assert.equal(backHedge.size, 7.5);
  assert.equal(hedgeOrder({ ifWin: 1, ifLose: 1 }, 2, 2.02), undefined);
  // An almost-flat position is flat, not a 0.00 hedge.
  assert.equal(hedgeOrder({ ifWin: 0.1256, ifLose: 0.14 }, 3.0, 3.05), undefined);
});

test("dutching to profit and to total stake", () => {
  const prices = [3, 4, 6];
  const stakes = dutchStakes(prices, "RequiredProfit", 10);
  const total = stakes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < prices.length; i++) assert.ok(Math.abs(stakes[i] * prices[i] - total - 10) < 0.1);

  const split = dutchStakes(prices, "TotalStake", 30);
  assert.ok(Math.abs(split.reduce((a, b) => a + b, 0) - 30) < 0.05);
  assert.throws(() => dutchStakes([1.5, 2, 3], "RequiredProfit", 10), /book/);
});

test("Betfair minimum bet rules", () => {
  const gbp = currencyRules("gbp");
  assert.equal(betSizeProblem(1, 3, gbp), undefined);
  assert.equal(betSizeProblem(0.5, 30, gbp), undefined, "payout 15 >= 10");
  assert.match(betSizeProblem(0.5, 3, gbp)!, /INVALID_BET_SIZE/);
  assert.match(betSizeProblem(0.001, 3, gbp)!, /rounds to zero/);
  assert.match(betSizeProblem(0.6, 3, currencyRules("EUR"))!, /minimum 1 EUR/);
  assert.equal(currencyRules("GBP", { minBetSize: 2 }).minBetSize, 2);
});
