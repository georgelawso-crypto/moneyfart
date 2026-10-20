// Property test of the closing rule (closingVerdict), the rule that lets a request skip every limit
// and the kill switch. Whenever it says "closing", a brute-force oracle checks the promise it makes:
// whatever state the market's other uncertain bets end in (unmatched remainders, possibly-placed
// bets: none, all or part of them matched), and however much of the request matches, the market's
// worst-case loss is no higher than in the same state without the request.
//
// The oracle enumerates every real outcome (each set of k winners among the active runners) and
// evaluates fill states at every vertex plus random interior points, independently of the code's
// own scenario enumeration.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Side } from "../src/betfair/types.js";
import { addedBound, closingVerdict, type Leg, type MarketShape } from "../src/exchange/exposure.js";
import { betOutcomeProfit } from "../src/exchange/math.js";

/** Small deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (x: number) => Math.round(x * 100) / 100;

interface Market {
  runners: string[];
  winners: number;
  removed: string[];
  /** Other bets: matched fills plus uncertain remainders. */
  known: Leg[];
}

function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [first, ...rest] = items;
  return [...combinations(rest, k - 1).map((c) => [first, ...c]), ...combinations(rest, k)];
}

/** Worst-case loss over every real outcome, with uncertain parts matched by the given fractions. */
function oracleWorst(market: Market, legs: Leg[], fractions: number[]): number {
  const active = market.runners.filter((r) => !market.removed.includes(r));
  let worst = Number.NEGATIVE_INFINITY;
  for (const winners of combinations(active, Math.min(market.winners, active.length))) {
    let profit = 0;
    legs.forEach((leg, i) => {
      if (market.removed.includes(leg.key)) return; // void
      const wins = winners.includes(leg.key);
      for (const f of leg.fills) profit += betOutcomeProfit(leg.side, f.price, f.size, wins);
      if (leg.remaining > 0) profit += fractions[i] * betOutcomeProfit(leg.side, leg.price, leg.remaining, wins);
    });
    worst = Math.max(worst, -profit);
  }
  return worst;
}

/** Fill states to try: every vertex (up to 2^10), plus random interior points. */
function fillStates(count: number, random: () => number, extra = 24): number[][] {
  const states: number[][] = [];
  const vertices = Math.min(1 << count, 1024);
  for (let mask = 0; mask < vertices; mask++) states.push(Array.from({ length: count }, (_, i) => ((mask >> i) & 1 ? 1 : 0)));
  for (let n = 0; n < extra; n++) states.push(Array.from({ length: count }, () => (random() < 0.3 ? Math.round(random()) : random())));
  return states;
}

function randomLeg(random: () => number, key: string, matched: boolean): Leg {
  const side: Side = random() < 0.5 ? "BACK" : "LAY";
  const price = cents(1.1 + random() * (random() < 0.7 ? 6 : 30));
  const size = cents(1 + random() * 40);
  return matched
    ? { key, side, price, remaining: random() < 0.25 ? cents(random() * 20) : 0, fills: [{ price, size }] }
    : { key, side, price, remaining: size, fills: [] };
}

/** A request on one selection: often a close sized from the matched position, sometimes random. */
function randomRequest(random: () => number, market: Market): Leg[] {
  const key = market.runners[Math.floor(random() * market.runners.length)];
  let ifWin = 0;
  let ifLose = 0;
  for (const l of market.known) {
    if (l.key !== key) continue;
    for (const f of l.fills) {
      ifWin += betOutcomeProfit(l.side, f.price, f.size, true);
      ifLose += betOutcomeProfit(l.side, f.price, f.size, false);
    }
  }
  const diff = ifWin - ifLose;
  const side: Side = Math.abs(diff) < 0.01 || random() < 0.2 ? (random() < 0.5 ? "BACK" : "LAY") : diff > 0 ? "LAY" : "BACK";
  const legs: Leg[] = [];
  const count = random() < 0.75 ? 1 : 2;
  for (let i = 0; i < count; i++) {
    const price = cents(1.1 + random() * 8);
    // Around a full hedge, scaled: below, at and past flat.
    const hedge = Math.abs(diff) / price;
    const size = cents(Math.max(0.01, (hedge > 0 && random() < 0.8 ? hedge * (0.2 + random() * 1.2) : 1 + random() * 30) / count));
    legs.push({ key, side, price, remaining: size, fills: [] });
  }
  return legs;
}

function randomMarket(random: () => number): Market {
  const n = 2 + Math.floor(random() * 5); // 2..6 runners
  const runners = Array.from({ length: n }, (_, i) => String(101 + i));
  const winners = 1 + Math.floor(random() * Math.min(3, n - 1));
  const removed = random() < 0.15 ? [runners[n - 1]] : [];
  const known: Leg[] = [];
  const legCount = 1 + Math.floor(random() * 6);
  for (let i = 0; i < legCount; i++) {
    const key = runners[Math.floor(random() * n)];
    known.push(randomLeg(random, key, random() < 0.7));
  }
  return { runners, winners, removed, known };
}

describe("closing rule property", () => {
  test("whenever a request counts as closing, no fill state of anything raises the market's worst case", () => {
    const random = rng(20261021);
    let closing = 0;
    let checked = 0;
    for (let iteration = 0; iteration < 4000; iteration++) {
      const market = randomMarket(random);
      const request = randomRequest(random, market);
      const shape: MarketShape = {
        winners: market.winners,
        active: market.runners.filter((r) => !market.removed.includes(r)),
        removed: market.removed,
      };
      const verdict = closingVerdict(market.known, shape, request);
      if (!verdict.closing) continue;
      closing++;
      const uncertain = market.known.map((l) => (l.remaining > 0 ? 1 : 0));
      const all = [...market.known, ...request];
      for (const knownState of fillStates(market.known.length, random)) {
        const base = knownState.map((f, i) => f * uncertain[i]);
        const before = oracleWorst(market, market.known, base);
        for (const requestState of fillStates(request.length, random, 6)) {
          const after = oracleWorst(market, all, [...base, ...requestState]);
          checked++;
          assert.ok(
            after <= before + 1e-6,
            `iteration ${iteration}: a "closing" request raised the worst case from ${before.toFixed(4)} to ${after.toFixed(4)}\n` +
              `market ${JSON.stringify({ runners: market.runners, winners: market.winners, removed: market.removed })}\n` +
              `known ${JSON.stringify(market.known)}\nrequest ${JSON.stringify(request)}\nfills ${JSON.stringify(base)} + ${JSON.stringify(requestState)}`,
          );
        }
      }
    }
    // The generator must actually exercise the rule's "closing" branch.
    assert.ok(closing >= 300, `only ${closing} closing requests were generated`);
    assert.ok(checked > 10_000);
  });

  test("the rule still counts plain hedges of a simple position as closing", () => {
    const shape: MarketShape = { winners: 1, active: ["101", "102", "103"] };
    const back: Leg = { key: "101", side: "BACK", price: 3, remaining: 0, fills: [{ price: 3, size: 10 }] };
    // Green-up, part close, and a close resting below a part close already resting.
    assert.equal(closingVerdict([back], shape, [{ key: "101", side: "LAY", price: 3.05, remaining: 9.84, fills: [] }]).closing, true);
    assert.equal(closingVerdict([back], shape, [{ key: "101", side: "LAY", price: 3.05, remaining: 4, fills: [] }]).closing, true);
    const resting: Leg = { key: "101", side: "LAY", price: 3.05, remaining: 5, fills: [] };
    assert.equal(closingVerdict([back, resting], shape, [{ key: "101", side: "LAY", price: 3.05, remaining: 4.84, fills: [] }]).closing, true);
    // Past flat with the resting part close: not closing.
    assert.equal(closingVerdict([back, resting], shape, [{ key: "101", side: "LAY", price: 3.05, remaining: 9.84, fills: [] }]).closing, false);
    // A place market (2 winners) hedge.
    const place: MarketShape = { winners: 2, active: ["101", "102", "103"] };
    const placeBack: Leg = { key: "101", side: "BACK", price: 1.5, remaining: 0, fills: [{ price: 1.5, size: 10 }] };
    assert.equal(closingVerdict([placeBack], place, [{ key: "101", side: "LAY", price: 1.52, remaining: 9.87, fills: [] }]).closing, true);
  });
});

/** A future state of one uncertain bet: part matched (at its limit, or better if improvable), part still resting, the rest cancelled. */
interface LegState {
  matched: number;
  resting: number;
  price: number;
}

/** Worst-case loss of a state: matched parts exact, still-resting parts counted where they lose (as Betfair's exposure does). */
function stateWorst(market: Market, legs: Leg[], states: LegState[]): number {
  const active = market.runners.filter((r) => !market.removed.includes(r));
  let worst = 0;
  for (const winners of combinations(active, Math.min(market.winners, active.length))) {
    let profit = 0;
    legs.forEach((leg, i) => {
      if (market.removed.includes(leg.key)) return;
      const wins = winners.includes(leg.key);
      for (const f of leg.fills) profit += betOutcomeProfit(leg.side, f.price, f.size, wins);
      const st = states[i];
      if (st.matched > 0) profit += betOutcomeProfit(leg.side, st.price, st.matched, wins);
      if (st.resting > 0) profit += Math.min(0, betOutcomeProfit(leg.side, leg.price, st.resting, wins));
    });
    worst = Math.max(worst, -profit);
  }
  return worst;
}

function randomState(random: () => number, leg: Leg): LegState {
  if (!(leg.remaining > 0)) return { matched: 0, resting: 0, price: leg.price };
  const pick = random();
  const matchedPart = pick < 0.3 ? 0 : pick < 0.6 ? 1 : random();
  const restingPart = (1 - matchedPart) * (random() < 0.5 ? 0 : random() < 0.5 ? 1 : random());
  let price = leg.price;
  if (leg.improvable && random() < 0.6) price = leg.side === "BACK" ? cents(leg.price + random() * (random() < 0.2 ? 900 : 10)) : cents(1.01 + random() * (leg.price - 1.01));
  return { matched: leg.remaining * matchedPart, resting: leg.remaining * restingPart, price: Math.min(1000, Math.max(1.01, price)) };
}

describe("added-risk bound property", () => {
  test("a request never adds more than addedBound to its market's worst case, whatever the market's other bets do", () => {
    const random = rng(4242);
    let bounded = 0;
    for (let iteration = 0; iteration < 3000; iteration++) {
      const market = randomMarket(random);
      // Some uncertain bets are possibly-placed (their placement may have matched at a better price).
      for (const leg of market.known) if (!leg.fills.length && random() < 0.4) leg.improvable = true;
      const request = randomRequest(random, market);
      const shape: MarketShape = { winners: market.winners, active: market.runners.filter((r) => !market.removed.includes(r)), removed: market.removed };
      const bound = addedBound(market.known, shape, request);
      if (bound === undefined) continue;
      bounded++;
      for (let trial = 0; trial < 40; trial++) {
        const states = market.known.map((leg) => randomState(random, leg));
        const before = stateWorst(market, market.known, states);
        // The request: matched at its limit (or better), partly, or resting.
        const requestStates = request.map((leg) => {
          const f = random() < 0.4 ? 1 : random() < 0.3 ? 0 : random();
          const better = random() < 0.3 ? (leg.side === "BACK" ? cents(leg.price + random() * 5) : cents(1.01 + random() * (leg.price - 1.01))) : leg.price;
          return { matched: leg.remaining * f, resting: leg.remaining * (1 - f) * (random() < 0.5 ? 1 : 0), price: Math.min(1000, Math.max(1.01, better)) };
        });
        const after = stateWorst(market, [...market.known, ...request], [...states, ...requestStates]);
        assert.ok(
          after - before <= bound + 1e-6,
          `iteration ${iteration}: the request added ${(after - before).toFixed(4)} > bound ${bound.toFixed(4)}\n` +
            `market ${JSON.stringify({ runners: market.runners, winners: market.winners, removed: market.removed })}\n` +
            `known ${JSON.stringify(market.known)}\nrequest ${JSON.stringify(request)}\nstates ${JSON.stringify(states)} + ${JSON.stringify(requestStates)}`,
        );
      }
    }
    assert.ok(bounded >= 2000, `only ${bounded} bounds were computed`);
  });
});
