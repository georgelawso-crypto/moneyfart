import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Grid } from '../src/game.ts';
import { planStake, stakeAmount } from '../src/strategy.ts';

function grid(odds: number, probability: number): Grid {
  return {
    symbol: 'SIM',
    now: 1_000,
    price: 100,
    bandSize: 0.05,
    sigmaPerSecond: 0.01,
    windows: [{ start: 1_030, end: 1_060, closesAt: 1_019, bettable: true }],
    bands: [{ index: 2000, low: 100, high: 100.05, containsPrice: true }],
    cells: [[{
      id: 'SIM-1030-2000',
      windowStart: 1_030,
      windowEnd: 1_060,
      band: 2000,
      low: 100,
      high: 100.05,
      probability,
      odds,
    }]],
  };
}

test('no bet when our vol matches a fairly priced box', () => {
  const g = grid(4, 0.2);
  assert.equal(planStake(g, undefined), null);
  assert.equal(planStake(g, 0), null);
  assert.equal(planStake(g, 1), null);
});

test('a much tighter vol than the book makes the centre rich enough to bet', () => {
  const g = grid(6, 0.1);
  const plan = planStake(g, 0.0001);
  assert.ok(plan);
  assert.ok(plan!.edge >= 0.03);
  assert.ok(plan!.fraction > 0 && plan!.fraction <= 0.05);
});

test('stake is zero below the minimum chip instead of rounding up', () => {
  assert.equal(stakeAmount(1000, 0.001, 10), 0);
  assert.equal(stakeAmount(1000, 0.02, 10), 20);
  assert.equal(stakeAmount(5, 0.5, 10), 0);
});
