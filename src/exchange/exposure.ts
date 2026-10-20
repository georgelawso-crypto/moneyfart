// Worst-case loss of one market's bets, for the risk guard.
//
// A leg is one order: its matched fills are certain; its unmatched remainder (and an SP bet not
// yet matched) may or may not end up matched. How the uncertain part counts is a parameter:
//   "ignore": only what is matched (the certain part)
//   "hurt":   uncertain parts count only where they lose money (Betfair's exposure rule: an upper
//             bound on the loss whichever of them end up matched)
//   "full":   as if everything matched (the end state of a set of bets)
//
// Outcomes: single- and multi-winner markets enumerate which selections with a position win
// (exact while at most MAX_ENUMERATED selections have one); otherwise, and in handicap or line
// markets, every selection counts on its own (the sum of their worst cases, an upper bound).

import type { Side } from "../betfair/types.js";
import { addBet, betOutcomeProfit, worstCase, type Position } from "./math.js";

export interface Leg {
  /** Formatted selection id. */
  key: string;
  side: Side;
  /** Limit price of the unmatched remainder. */
  price: number;
  fills: Array<{ price: number; size: number }>;
  remaining: number;
  /** An SP bet not matched yet: a back loses this stake if the selection loses, a lay this liability if it wins. */
  spLiability?: number;
  /**
   * The placement's outcome is unknown, so it may have matched at once at a better price than its
   * limit: a back can win up to price 1000 (a lay's liability can only be lower, its winnings the same).
   */
  improvable?: boolean;
}

export interface MarketShape {
  /** Winners per outcome; undefined when outcomes are not "k of the runners win" (handicap, line, unknown). */
  winners?: number;
  /** Selections that can still win (Betfair's ACTIVE runners); undefined when unknown. */
  active?: string[];
  /** Non-runners: their bets are void. */
  removed?: string[];
}

export type Remainder = "ignore" | "hurt" | "full";

/** Selections with a position beyond which outcomes are no longer enumerated (2^12 scenarios). */
const MAX_ENUMERATED = 12;

/** Profit of a leg if its selection wins / loses, its uncertain part counted as `remainder` says. */
export function legProfit(leg: Leg, wins: boolean, remainder: Remainder): number {
  let profit = 0;
  for (const f of leg.fills) profit += betOutcomeProfit(leg.side, f.price, f.size, wins);
  if (remainder !== "ignore") {
    if (leg.remaining > 0 && leg.price >= 1.01) {
      const rest = betOutcomeProfit(leg.side, leg.price, leg.remaining, wins);
      profit += remainder === "full" ? rest : Math.min(0, rest);
    }
    // An SP bet's price is unknown until the off: only its loss is certain to be bounded.
    if (leg.spLiability && leg.spLiability > 0 && (leg.side === "BACK" ? !wins : wins)) profit -= leg.spLiability;
  }
  return profit;
}

/** Losses of one winner set: uncertain parts counted where they lose (hurt) and where they win (help). */
export interface Scenario {
  winners: Set<string>;
  /** Highest possible loss in this outcome, whichever uncertain bets match. */
  hurt: number;
  /** Lowest possible loss in this outcome, whichever uncertain bets match. */
  help: number;
}

/**
 * Every outcome of the market (winner sets among the selections with bets, plus `extra`), with the
 * highest and lowest loss each can bring. Undefined when the outcomes can't be enumerated, or when
 * an unmatched SP bet is involved (its winnings, and so the lowest loss, are unknown before the off).
 */
export function scenarioLosses(legs: Leg[], shape: MarketShape, extra: string[] = []): Scenario[] | undefined {
  const removed = new Set(shape.removed ?? []);
  const live = legs.filter((l) => !removed.has(l.key));
  if (live.some((l) => (l.spLiability ?? 0) > 0)) return undefined;
  const keys = [...new Set([...live.map((l) => l.key), ...extra.filter((k) => !removed.has(k))])];
  const sets = winnerSets(keys, shape);
  if (!sets) return undefined;
  return sets.map((winners) => {
    let hurt = 0;
    let help = 0;
    for (const leg of live) {
      const wins = winners.has(leg.key);
      let matched = 0;
      for (const f of leg.fills) matched += betOutcomeProfit(leg.side, f.price, f.size, wins);
      const rest = leg.remaining > 0 && leg.price >= 1.01 ? betOutcomeProfit(leg.side, leg.price, leg.remaining, wins) : 0;
      const best = leg.improvable && leg.side === "BACK" && wins && leg.remaining > 0 ? leg.remaining * 999 : rest;
      hurt -= matched + Math.min(0, rest);
      help -= matched + Math.max(0, best);
    }
    return { winners, hurt, help };
  });
}

/** True when the outcomes of a market with bets on these selections are enumerated exactly. */
export function enumerable(keys: string[], shape: MarketShape): boolean {
  const removed = new Set(shape.removed ?? []);
  return winnerSets([...new Set(keys.filter((k) => !removed.has(k)))], shape) !== undefined;
}

/** Winner sets to evaluate, or undefined to fall back to counting selections independently. */
function winnerSets(keys: string[], shape: MarketShape): Array<Set<string>> | undefined {
  const k = shape.winners;
  if (!k || k < 1 || !Number.isInteger(k) || keys.length > MAX_ENUMERATED) return undefined;
  const active = shape.active?.length ? new Set(shape.active) : undefined;
  // Runners without a position that can take the remaining places (unknown field: as many as needed).
  const others = active ? [...active].filter((a) => !keys.includes(a)).length : Number.POSITIVE_INFINITY;
  const sets: Array<Set<string>> = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    let winning = 0;
    for (let bits = mask; bits; bits &= bits - 1) winning++;
    if (winning > k || k - winning > others) continue;
    sets.push(new Set(keys.filter((_, i) => mask & (1 << i))));
  }
  return sets.length ? sets : undefined;
}

/** Worst-case loss (0 when every outcome is a profit) of a market's legs. */
export function worstLoss(legs: Leg[], shape: MarketShape, remainder: Remainder): number {
  const removed = new Set(shape.removed ?? []);
  const live = legs.filter((l) => !removed.has(l.key));
  const keys = [...new Set(live.map((l) => l.key))];
  if (!keys.length) return 0;
  const sets = winnerSets(keys, shape);
  if (sets) {
    let worst = Number.POSITIVE_INFINITY;
    for (const winners of sets) {
      let profit = 0;
      for (const leg of live) profit += legProfit(leg, winners.has(leg.key), remainder);
      worst = Math.min(worst, profit);
    }
    return Math.max(0, -worst);
  }
  let total = 0;
  for (const key of keys) {
    let ifWin = 0;
    let ifLose = 0;
    for (const leg of live) {
      if (leg.key !== key) continue;
      ifWin += legProfit(leg, true, remainder);
      ifLose += legProfit(leg, false, remainder);
    }
    total += Math.max(0, -Math.min(ifWin, ifLose));
  }
  return total;
}

/** The certain part of legs: matched fills only. */
export function matchedPart(legs: Leg[]): Leg[] {
  return legs.filter((l) => l.fills.length).map((l) => ({ ...l, remaining: 0, spLiability: undefined }));
}

/** A leg as if its remainder matched at its limit price. */
export function asMatched(leg: Leg): Leg {
  const rest = leg.remaining > 0 && leg.price >= 1.01 ? [{ price: leg.price, size: leg.remaining }] : [];
  return { ...leg, fills: [...leg.fills, ...rest], remaining: 0, spLiability: undefined };
}

/** Most a leg can lose on its own: a back's stake, a lay's liability, an SP bet's liability. */
export function legLiability(leg: Leg): number {
  return Math.max(0, -Math.min(legProfit(leg, true, "hurt"), legProfit(leg, false, "hurt")));
}

// ------------------------------------------------------------------ closing rule

/** Whether a request only closes a position; `why` says why one on the closing side still isn't counted. */
export type Closing = { closing: true } | { closing: false; why?: string };

const CLOSING_EPS = 1e-6;

function matchedPosition(legs: Leg[], key: string): Position {
  let position: Position = { ifWin: 0, ifLose: 0 };
  for (const l of legs) if (l.key === key) for (const f of l.fills) position = addBet(position, l.side, f.price, f.size);
  return position;
}

/**
 * A request (new legs, nothing matched) is closing when:
 *  1. its bets are on one selection, on the side that reduces that selection's matched position;
 *  2. with every bet already resting (or possibly placed) on that side matched too, they don't take
 *     the selection past flat;
 *  3. however much of it matches, and whatever the market's other unmatched or possibly-placed bets
 *     do, the market's worst case can't rise: the highest loss in the outcomes where these bets lose,
 *     plus what they lose there, stays within the lowest possible loss of the worst other outcome.
 * With an unmatched SP bet in the market (price unknown), or outcomes that can't be enumerated while
 * other selections have bets, nothing counts as closing. `known` is every other bet in the market.
 */
export function closingVerdict(known: Leg[], shape: MarketShape, legs: Leg[]): Closing {
  const key = legs[0]?.key;
  const side = legs[0]?.side;
  if (!key || legs.some((l) => l.key !== key || l.side !== side)) return { closing: false };
  const removed = new Set(shape.removed ?? []);
  if (removed.has(key)) return { closing: false };
  const live = known.filter((l) => !removed.has(l.key));

  // 1. A matched position, and the side that reduces it.
  let position = matchedPosition(live, key);
  const diff = position.ifWin - position.ifLose;
  if (Math.abs(diff) < 0.01) return { closing: false };
  const closingSide: Side = diff > 0 ? "LAY" : "BACK";
  if (side !== closingSide) return { closing: false };
  if (live.some((l) => (l.spLiability ?? 0) > 0)) return { closing: false, why: "an unmatched Betfair SP bet in this market has a price nobody knows until the off" };

  // 2. Not past flat, counting the bets already resting on the same side.
  for (const l of live) if (l.key === key && l.side === side && l.remaining > 0) position = addBet(position, l.side, l.price, l.remaining);
  let after = position;
  for (const l of legs) after = addBet(after, l.side, l.price, l.remaining);
  if (worstCase(after) < worstCase(position) - CLOSING_EPS) {
    return { closing: false, why: "with the bets already resting on the same side it would close more than the whole position" };
  }

  // 3. The market's worst case, however much of everything uncertain matches.
  const scenarios = scenarioLosses(live, shape, [key]);
  if (!scenarios) {
    if (live.every((l) => l.key === key)) return { closing: true }; // the market is this selection: 2 decides exactly
    return { closing: false, why: "this market's outcomes can't be worked out exactly while other selections have bets" };
  }
  const loses = legs.reduce((total, l) => total + (l.side === "BACK" ? l.remaining : l.remaining * (l.price - 1)), 0);
  let badHigh = Number.NEGATIVE_INFINITY;
  let goodLow = Number.NEGATIVE_INFINITY;
  for (const s of scenarios) {
    const legsLose = side === "BACK" ? !s.winners.has(key) : s.winners.has(key);
    if (legsLose) badHigh = Math.max(badHigh, s.hurt);
    else goodLow = Math.max(goodLow, s.help);
  }
  if (badHigh === Number.NEGATIVE_INFINITY || badHigh + loses <= goodLow + CLOSING_EPS) return { closing: true };
  return {
    closing: false,
    why: "on its own it could raise the market's worst case (for example lays on two runners that cover each other, or unmatched bets on other runners that this position covers)",
  };
}

// ------------------------------------------------------------------ what a request can add

/** Most outcomes worth comparing pairwise for addedBound (beyond that, callers use the request's own worst loss). */
const MAX_BOUND_SCENARIOS = 256;

/**
 * Most a request can add to its market's worst-case loss, whatever happens meanwhile to the market's
 * other uncertain bets (matched, cancelled or lapsing, in any part) and however much of the request
 * matches. For each outcome s it is what the request can lose there, minus the least the market's
 * worst case is always ahead of s: zero minus s's highest possible loss (a worst case is never
 * negative), and for every other outcome t, (matched loss in t - in s) plus, per uncertain bet, the
 * least (its loss in t - its loss in s) can be. Undefined when the outcomes can't be enumerated (or
 * are too many), or an unmatched SP bet is involved.
 */
export function addedBound(known: Leg[], shape: MarketShape, request: Leg[]): number | undefined {
  const removed = new Set(shape.removed ?? []);
  const live = known.filter((l) => !removed.has(l.key));
  const asked = request.filter((l) => !removed.has(l.key));
  if (live.some((l) => (l.spLiability ?? 0) > 0)) return undefined;
  const keys = [...new Set([...live, ...asked].map((l) => l.key))];
  const sets = winnerSets(keys, shape);
  if (!sets || sets.length > MAX_BOUND_SCENARIOS) return undefined;
  const n = sets.length;
  const matched = new Array<number>(n).fill(0);
  const asks = new Array<number>(n).fill(0);
  /** Per uncertain bet and outcome: its lowest and highest possible loss there (better prices included). */
  const uncertain: Array<{ low: number[]; high: number[] }> = [];
  sets.forEach((winners, s) => {
    for (const leg of live) {
      const wins = winners.has(leg.key);
      for (const f of leg.fills) matched[s] -= betOutcomeProfit(leg.side, f.price, f.size, wins);
    }
    for (const leg of asked) {
      if (leg.remaining > 0) asks[s] += Math.max(0, -betOutcomeProfit(leg.side, leg.price, leg.remaining, winners.has(leg.key)));
    }
  });
  for (const leg of live) {
    if (!(leg.remaining > 0) || !(leg.price >= 1.01)) continue;
    const low: number[] = [];
    const high: number[] = [];
    for (const winners of sets) {
      const wins = winners.has(leg.key);
      const atLimit = -betOutcomeProfit(leg.side, leg.price, leg.remaining, wins);
      // A possibly-placed bet may have matched at once at a better price: a back wins up to price 1000,
      // a lay's liability can be lower (down to nothing); losses and stakes won are otherwise fixed.
      const best = leg.improvable && wins ? (leg.side === "BACK" ? -leg.remaining * 999 : 0) : atLimit;
      low.push(Math.min(atLimit, best));
      high.push(atLimit);
    }
    uncertain.push({ low, high });
  }
  let bound = 0;
  for (let s = 0; s < n; s++) {
    if (asks[s] <= 0) continue;
    // A worst case is never below zero (no loss): outcome s is at least its own loss short of it.
    let highest = matched[s];
    for (const u of uncertain) highest += Math.max(0, u.high[s]);
    let slack = Math.max(0, -highest);
    for (let t = 0; t < n; t++) {
      if (t === s) continue;
      let ahead = matched[t] - matched[s];
      for (const u of uncertain) ahead += Math.min(0, u.low[t] - u.high[s]);
      if (ahead > slack) slack = ahead;
    }
    bound = Math.max(bound, asks[s] - slack);
  }
  return bound;
}
