import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { bandProbability, bandSizeFor, niceStep, normalCdf, oddsFor } from '../src/pricing.ts';

test('normalCdf matches known values', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-8);
  assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normalCdf(-1) - 0.158655) < 1e-6);
  assert.ok(Math.abs(normalCdf(3) + normalCdf(-3) - 1) < 1e-12);
});

test('band probabilities across every band sum to 1', () => {
  let total = 0;
  for (let low = 90; low < 110; low += 0.5) total += bandProbability(100.2, low, low + 0.5, 0.05, 60);
  assert.ok(Math.abs(total - 1) < 1e-6);
});

test('band probability is highest around the price and shrinks with distance', () => {
  const p = (low: number) => bandProbability(100, low, low + 1, 0.1, 60);
  assert.ok(p(99.5) > p(100.5));
  assert.ok(p(100.5) > p(101.5));
  assert.equal(bandProbability(100, 99, 101, 0.1, 0), 1);
  assert.equal(bandProbability(100, 101, 102, 0.1, 0), 0);
});

test('odds keep the house edge and respect the limits', () => {
  assert.equal(oddsFor(0.5, DEFAULT_SETTINGS), 1.9);
  assert.equal(oddsFor(0.38, DEFAULT_SETTINGS), 2.5);
  assert.equal(oddsFor(0.0001, DEFAULT_SETTINGS), 99);
  assert.equal(oddsFor(0, DEFAULT_SETTINGS), 99);
  assert.equal(oddsFor(0.95, DEFAULT_SETTINGS), null);
  for (let p = 0.001; p < 1; p += 0.001) {
    const odds = oddsFor(p, DEFAULT_SETTINGS);
    if (odds !== null) assert.ok(odds * p <= 0.95 + 1e-9, `expected value too high at p=${p}`);
  }
});

test('niceStep rounds to 1, 2, 2.5 or 5 × 10^k', () => {
  assert.equal(niceStep(0.0585), 0.05);
  assert.equal(niceStep(53.6), 50);
  assert.equal(niceStep(0.156), 0.2);
  assert.equal(niceStep(2.4), 2.5);
  assert.equal(niceStep(8), 10);
  assert.equal(bandSizeFor(100, 0.6), 0.05);
});
