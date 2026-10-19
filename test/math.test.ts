import assert from "node:assert/strict";
import { test } from "node:test";
import { LADDER, isValidPrice, offsetTicks, roundForSide, roundToTick, ticksBetween } from "../src/betfair/ticks.js";
import { betOutcomeProfit, matchAgainstLadder } from "../src/exchange.js";
import { formatSelectionId, parseSelectionId } from "../src/markets.js";
import { dutchStakes, hedgeOrder, normaliseParameters } from "../src/strategies.js";

test("price ladder has every Betfair tick", () => {
  assert.equal(LADDER.length, 350);
  assert.equal(LADDER[0], 1.01);
  assert.equal(LADDER.at(-1), 1000);
  for (const price of [1.01, 1.99, 2, 2.02, 3.05, 4.1, 6.2, 10.5, 21, 32, 55, 110]) assert.ok(isValidPrice(price), `${price}`);
  for (const price of [2.01, 3.02, 4.15, 6.1, 10.2, 21.5, 31, 52, 105]) assert.ok(!isValidPrice(price), `${price}`);
});

test("rounding respects the side of the bet", () => {
  assert.equal(roundToTick(2.03, "up"), 2.04);
  assert.equal(roundToTick(2.03, "down"), 2.02);
  assert.equal(roundForSide(5.55, "BACK"), 5.6);
  assert.equal(roundForSide(5.55, "LAY"), 5.5);
  assert.equal(roundToTick(0.5), 1.01);
  assert.equal(roundToTick(5000), 1000);
});

test("tick offsets cross band boundaries", () => {
  assert.equal(offsetTicks(2, 1), 2.02);
  assert.equal(offsetTicks(2, -1), 1.99);
  assert.equal(offsetTicks(3, -2), 2.96);
  assert.equal(offsetTicks(1000, 5), 1000);
  assert.equal(ticksBetween(2, 2.1), 5);
});

test("selection ids use BFExplorer format", () => {
  assert.equal(formatSelectionId(12345, 0), "12345_0.00");
  assert.deepEqual(parseSelectionId("12345_0.00"), { selectionId: 12345, handicap: 0 });
  assert.deepEqual(parseSelectionId("12345_-1.50"), { selectionId: 12345, handicap: -1.5 });
  assert.deepEqual(parseSelectionId("12345"), { selectionId: 12345, handicap: 0 });
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
});

test("dutching to profit and to stake", () => {
  const prices = [3, 4, 6];
  const stakes = dutchStakes(prices, "Profit", 10);
  const total = stakes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < prices.length; i++) assert.ok(Math.abs(stakes[i] * prices[i] - total - 10) < 0.1);

  const split = dutchStakes(prices, "Stake", 30);
  assert.ok(Math.abs(split.reduce((a, b) => a + b, 0) - 30) < 0.05);
  assert.throws(() => dutchStakes([1.5, 2, 3], "Profit", 10), /book/);
});

test("paper fills take the best levels first and stop at the limit price", () => {
  const ladder = [
    { price: 3.0, size: 5 },
    { price: 2.98, size: 5 },
    { price: 2.96, size: 100 },
  ];
  assert.deepEqual(matchAgainstLadder("BACK", 2.98, 20, ladder), { sizeMatched: 10, averagePriceMatched: 2.99 });
  assert.deepEqual(matchAgainstLadder("LAY", 3.1, 5, [{ price: 3.05, size: 10 }]), { sizeMatched: 5, averagePriceMatched: 3.05 });
  assert.deepEqual(matchAgainstLadder("LAY", 3.0, 5, [{ price: 3.05, size: 10 }]), { sizeMatched: 0, averagePriceMatched: 0 });
});

test("strategy parameters are validated case-insensitively", () => {
  const { values, unknown } = normaliseParameters("Place Bet", { bettype: "lay", STAKE: "5", Foo: 1 });
  assert.equal(values.BetType, "Lay");
  assert.equal(values.Stake, 5);
  assert.equal(values.Odds, 0);
  assert.deepEqual(unknown, ["Foo"]);
  assert.throws(() => normaliseParameters("Place Bet", { BetType: "Sideways" }));
  assert.throws(() => normaliseParameters("Place Bet", { Stake: -1 }));
});
