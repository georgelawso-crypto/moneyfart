// Order planning and placement shared by the strategy engine and the bots.

import { betSizeProblem, type CurrencyRules } from "../betfair/currency.js";
import { isValidPrice, offsetTicks, roundForSide, ticksBetween, type LadderType } from "../betfair/ticks.js";
import type { MarketBook, MarketCatalogue, PersistenceType, Runner, RunnerCatalog, Side } from "../betfair/types.js";
import type { Config } from "../config.js";
import { addBet, floor2, hedgeOrder, liability, offsetStakeOrder, worstCase, type Position } from "../exchange/math.js";
import type { CancelResult, Exchange, OrderRequest, PlacedBet, StrategyTag } from "../exchange/types.js";
import { formatSelectionId, round, sameSelection, type SelectionRef } from "../format.js";
import type { Params } from "./templates.js";

export interface PlannedOrder extends OrderRequest {
  role: string;
  selectionName?: string;
}

export interface Placement {
  order: PlannedOrder;
  /** Set when the order was sent. */
  bet?: PlacedBet;
  /** Set when the order was not sent. */
  reason?: string;
}

export const opposite = (side: Side): Side => (side === "BACK" ? "LAY" : "BACK");

export function ladderOf(catalogue: MarketCatalogue): LadderType {
  return catalogue.description?.priceLadderDescription?.type === "FINEST" ? "FINEST" : "CLASSIC";
}

export function runnerOf(book: MarketBook, ref: SelectionRef): Runner | undefined {
  return book.runners.find((r) => sameSelection({ selectionId: r.selectionId, handicap: r.handicap }, ref));
}

export function bestPrices(runner?: Runner): { back?: number; lay?: number } {
  return { back: runner?.ex?.availableToBack?.[0]?.price, lay: runner?.ex?.availableToLay?.[0]?.price };
}

/** A cancel that leaves nothing resting: cancelled now, or already matched/lapsed. */
export function cancelSucceeded(result: CancelResult): boolean {
  return result.status === "SUCCESS" || result.status === "BET_TAKEN_OR_LAPSED";
}

/**
 * Active selections in BFExplorer's ExecuteOnSelection order: LastPriceTraded ascending,
 * TotalMatched descending, or Betfair's sort priority (DoNotSort).
 */
export function sortedSelections(catalogue: MarketCatalogue, book: MarketBook, sortBy: unknown): RunnerCatalog[] {
  const runners = new Map(book.runners.map((r) => [formatSelectionId(r.selectionId, r.handicap), r]));
  const runner = (rc: RunnerCatalog) => runners.get(formatSelectionId(rc.selectionId, rc.handicap));
  const ltp = (rc: RunnerCatalog) => runner(rc)?.lastPriceTraded ?? Number.POSITIVE_INFINITY;
  const matched = (rc: RunnerCatalog) => runner(rc)?.totalMatched ?? -1;
  return (catalogue.runners ?? [])
    .filter((rc) => runner(rc)?.status === "ACTIVE")
    .sort((a, b) => {
      const byPriority = a.sortPriority - b.sortPriority;
      if (sortBy === "LastPriceTraded") return ltp(a) - ltp(b) || byPriority;
      if (sortBy === "TotalMatched") return matched(b) - matched(a) || byPriority;
      return byPriority;
    });
}

/** Bet size for a StakeType at the bet price (floored to cents, never rounded up). */
export function stakeSize(stakeType: unknown, amount: number, side: Side, price: number, balance?: number): number {
  switch (stakeType) {
    case "Liability":
      return floor2(side === "BACK" ? amount : amount / (price - 1));
    case "Payout":
      return floor2(amount / price);
    case "BankrollPercentage": {
      const budget = ((balance ?? 0) * amount) / 100;
      return floor2(side === "BACK" ? budget : budget / (price - 1));
    }
    default:
      return floor2(amount);
  }
}

export interface EntryContext {
  runner?: Runner;
  name: string;
  inPlay: boolean;
  ladder: LadderType;
  /** Available balance, needed for StakeType BankrollPercentage only. */
  balance?: number;
}

export type EntryPlan = { side: Side; price: number; size: number; persistenceType: PersistenceType } | { skip: string } | { problem: string };

/** Price and size of a Place Bet entry (Place Bet parameter names, without group prefix). */
export function planEntry(p: Params, ctx: EntryContext): EntryPlan {
  const { runner, name, ladder } = ctx;
  if (!runner || runner.status !== "ACTIVE") return { problem: `${name}: selection is not active (${runner?.status ?? "missing"}); no bet placed.` };
  if (ctx.inPlay && p.AllowPlacingBetInPlay === false) return { skip: `${name}: market is in-play and AllowPlacingBetInPlay is false; no bet placed.` };
  const side: Side = p.BetType === "Lay" ? "LAY" : "BACK";
  const best = bestPrices(runner);

  const minDiff = Number(p.MinimumOddsDifference ?? 0);
  const maxDiff = Number(p.MaximumOddsDifference ?? 0);
  if (minDiff > 0 || maxDiff > 0) {
    if (!best.back || !best.lay) return { skip: `${name}: the back/lay spread cannot be measured (one side has no price); no bet placed.` };
    const spread = ticksBetween(best.back, best.lay, ladder);
    if (minDiff > 0 && spread < minDiff) return { skip: `${name}: spread ${spread} ticks (${best.back}/${best.lay}) is below MinimumOddsDifference ${minDiff}; no bet placed.` };
    if (maxDiff > 0 && spread > maxDiff) return { skip: `${name}: spread ${spread} ticks (${best.back}/${best.lay}) is above MaximumOddsDifference ${maxDiff}; no bet placed.` };
  }

  let price: number | undefined;
  const odds = Number(p.Odds ?? 0);
  if (odds > 0) {
    price = roundForSide(odds, side, ladder);
    if (price === undefined) return { problem: `${name}: Odds ${odds} cannot be placed as a ${side} limit on the Betfair ladder; no bet placed.` };
  } else {
    price = p.OfferMyBet === true ? (side === "BACK" ? best.lay : best.back) : side === "BACK" ? best.back : best.lay;
    if (!price) {
      const book = p.OfferMyBet === true ? (side === "BACK" ? "lay" : "back") : side === "BACK" ? "back" : "lay";
      return { skip: `${name}: no ${book} price available; no bet placed.` };
    }
  }
  const improvement = Math.trunc(Number(p.PriceImprovement ?? 0));
  if (improvement) price = offsetTicks(price, side === "BACK" ? improvement : -improvement, ladder);

  if (p.PlaceBetInAllowedOddsRange !== false) {
    const min = Number(p.MinimumOdds ?? 1.01);
    const max = Number(p.MaximumOdds ?? 1000);
    if (price < min - 1e-9 || price > max + 1e-9) {
      return { skip: `${name}: price ${price} is outside the allowed odds range ${min}-${max}; no bet placed.` };
    }
  }

  const size = stakeSize(p.StakeType, Number(p.Stake), side, price, ctx.balance);
  return { side, price, size, persistenceType: p.AtInPlayKeepBet === true ? "PERSIST" : "LAPSE" };
}

/**
 * Flat to the cent: equal profit (green) or, without hedging, no net stake left. Stakes move in
 * cents, so with the hedge price a difference within one cent of stake at that price (what a
 * cent-rounded hedge leaves behind) also counts as green; re-hedging it would only flip the residual.
 */
export function isFlat(position: Position, hedging: boolean, hedgePrice?: number): boolean {
  const diff = Math.abs(position.ifWin - position.ifLose);
  if (diff < 0.01 || (hedgePrice !== undefined && diff <= hedgePrice * 0.01 + 1e-9)) return true;
  return !hedging && Math.abs(position.ifLose) < 0.01;
}

/** isFlat with the hedge price taken from the runner's best prices. */
export function isFlatAt(position: Position, hedging: boolean, runner?: Runner): boolean {
  const best = bestPrices(runner);
  return isFlat(position, hedging, position.ifWin > position.ifLose ? best.lay : best.back);
}

/**
 * The order that closes a position at the best prices: an equal-profit hedge, or (no hedging)
 * an offset of the net stake. The stake offset is never allowed to make the worst case worse
 * (a back that drifted far): it falls back to the hedge then. Undefined when already flat.
 * Throws when the side the close needs has no price.
 */
export function closeOrder(position: Position, hedging: boolean, back?: number, lay?: number): { side: Side; price: number; size: number; note?: string } | undefined {
  if (isFlat(position, hedging, position.ifWin > position.ifLose ? lay : back)) return undefined;
  if (hedging) return hedgeOrder(position, back, lay);
  const offset = offsetStakeOrder(position, back, lay);
  if (!offset) return undefined;
  if (worstCase(addBet(position, offset.side, offset.price, offset.size)) < worstCase(position) - 0.005) {
    const hedge = hedgeOrder(position, back, lay);
    return hedge && { ...hedge, note: `offsetting the stake at ${offset.price} would increase the worst-case loss, so the position is greened up instead` };
  }
  return offset;
}

export function describePosition(position: Position): string {
  return `if win ${round(position.ifWin)}, if lose ${round(position.ifLose)}`;
}

/**
 * Sends orders after checking each one: a valid ladder price, MAX_STAKE / MAX_LIABILITY for
 * risk-adding orders, and Betfair's minimum bet rules for every order (reducing ones included).
 */
export class OrderDesk {
  constructor(
    private readonly exchange: Exchange,
    private readonly limits: Config["trading"],
  ) {}

  /** MAX_STAKE applies to back stakes; MAX_LIABILITY to back stakes and lay liabilities. */
  limitProblem(order: Pick<OrderRequest, "side" | "price" | "size">): string | undefined {
    if (order.side === "BACK" && order.size > this.limits.maxStake + 1e-9) return `Stake ${round(order.size)} exceeds MAX_STAKE ${this.limits.maxStake}.`;
    const risk = liability(order.side, order.price, order.size);
    if (risk > this.limits.maxLiability + 1e-9) return `Liability ${round(risk)} exceeds MAX_LIABILITY ${this.limits.maxLiability}.`;
    return undefined;
  }

  problem(order: PlannedOrder, rules: CurrencyRules, ladder: LadderType): string | undefined {
    if (!isValidPrice(order.price, ladder)) return `Price ${order.price} is not a valid ${ladder} ladder price.`;
    return (order.reducesRisk ? undefined : this.limitProblem(order)) ?? betSizeProblem(order.size, order.price, rules);
  }

  async place(marketId: string, orders: PlannedOrder[], tag: StrategyTag, rules: CurrencyRules, ladder: LadderType): Promise<Placement[]> {
    const placements: Placement[] = orders.map((order) => ({ order, reason: this.problem(order, rules, ladder) }));
    const allowed = placements.filter((p) => !p.reason);
    if (!allowed.length) return placements;
    const requests: OrderRequest[] = allowed.map(({ order }) => ({
      selectionId: order.selectionId,
      handicap: order.handicap,
      side: order.side,
      price: order.price,
      size: order.size,
      persistenceType: order.persistenceType,
      reducesRisk: order.reducesRisk,
    }));
    let bets: PlacedBet[];
    try {
      bets = await this.exchange.placeOrders(marketId, requests, tag);
    } catch (error) {
      // The request may or may not have reached Betfair: never report these as plain failures.
      const message = (error as Error).message;
      bets = requests.map((r) => ({
        selectionId: formatSelectionId(r.selectionId, r.handicap),
        side: r.side,
        price: r.price,
        size: r.size,
        status: "UNKNOWN",
        errorCode: `REQUEST_FAILED: ${message}; check get_current_orders before retrying`,
      }));
    }
    allowed.forEach((placement, i) => {
      placement.bet = bets[i] ?? {
        selectionId: formatSelectionId(placement.order.selectionId, placement.order.handicap),
        side: placement.order.side,
        price: placement.order.price,
        size: placement.order.size,
        status: "UNKNOWN",
        errorCode: "NO_REPORT: check get_current_orders before retrying",
      };
    });
    return placements;
  }
}
