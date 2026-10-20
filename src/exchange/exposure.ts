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
import { betOutcomeProfit } from "./math.js";

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
