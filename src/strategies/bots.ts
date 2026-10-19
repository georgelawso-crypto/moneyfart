import crypto from "node:crypto";
import { betSizeProblem, type CurrencyRules } from "../betfair/currency.js";
import { ticksBetween, type LadderType } from "../betfair/ticks.js";
import type { MarketBook, Runner, Side } from "../betfair/types.js";
import type { Config } from "../config.js";
import { addBet, greenUpProfit, liability, positionOf, worstCase, type Position } from "../exchange/math.js";
import type { CancelResult, Exchange, OrderView, StrategyTag } from "../exchange/types.js";
import { formatSelectionId, marketStatusName, round, runnerStatusName, type SelectionRef } from "../format.js";
import type { MarketService } from "../markets.js";
import type { State } from "../state.js";
import type { BotState } from "./botTypes.js";
import { CLOSE, FILL_OR_KILL_MAX_MS, OPEN, groupValues, hasCloseTargets, timeSpanMs, type Params } from "./templates.js";
import { OrderDesk, bestPrices, cancelSucceeded, closeOrder, describePosition, isFlatAt, planEntry, runnerOf, type Placement, type PlannedOrder } from "./trading.js";

export interface BotDeps {
  markets: MarketService;
  exchange: Exchange;
  state: State;
  limits: Config["trading"];
  /** Clock in epoch milliseconds (injectable for tests). */
  now?: () => number;
}

/**
 * place / fillOrKill: a bet waiting for PlaceBetTimeSpan; trade: "Place Bet and Close Selection
 * Bet Position"; close: "Close Selection Bet Position" on targets; trailing: "Trailing Stop Loss".
 */
export type BotKind = "place" | "fillOrKill" | "trade" | "close" | "trailing";
export type BotPhase = "waiting" | "fillOrKill" | "open" | "monitoring" | "closing" | "done";

/** An order sent by a bot whose result is not recorded yet (saved before the request is sent). */
export interface PendingOrderRef {
  /** Betfair customerOrderRef of the order. */
  ref: string;
  role: "entry" | "close";
  /** Epoch ms at which the order was sent. */
  at: number;
  /** The market was in-play when the order was sent. */
  inPlay?: boolean;
}

/** Typed content of BotState.meta (persisted with the bot, so JSON values only). */
export interface BotMeta {
  kind: BotKind;
  phase: BotPhase;
  /** own = only the bot's bets make the position (trades); selection = every bet on the selection. */
  scope: "own" | "selection";
  tag: StrategyTag;
  ladder: LadderType;
  selectionName?: string;
  /** Epoch ms at which a delayed entry is placed (PlaceBetTimeSpan). */
  placeAt?: number;
  /** Epoch ms at which the position is closed regardless of profit (ClosePositionTimeSpan). */
  closeAt?: number;
  placedInPlay?: boolean;
  entryBetIds: string[];
  closeBetIds: string[];
  /** Epoch ms of the latest closing bet (re-priced after BetMatchingTimeout). */
  lastCloseAt?: number;
  closeReason?: string;
  fillOrKillUntil?: number;
  /** Trailing stop: best price reached in our favour, for a position on this side. */
  bestPrice?: number;
  trailSide?: Side;
  hadPosition?: boolean;
  failures: number;
  lastNote?: string;
  /**
   * Orders sent but not yet recorded: saved before the request so that after a restart (or a request
   * that threw) the bot finds the bet by customerOrderRef instead of placing it again.
   */
  pendingOrderRefs?: PendingOrderRef[];
}

export interface BotStart {
  strategyName: string;
  template: string;
  marketId: string;
  selection: SelectionRef;
  /** Normalised template parameters. */
  parameters: Params;
  betIds?: string[];
  meta: Omit<BotMeta, "failures" | "entryBetIds" | "closeBetIds"> & Partial<Pick<BotMeta, "entryBetIds" | "closeBetIds">>;
  /** First log line. */
  message?: string;
}

interface MarketView {
  marketId: string;
  book?: MarketBook;
  orders: OrderView[];
  rules: CurrencyRules;
  /** Orders changed since `orders` was read. */
  dirty: boolean;
}

type Step = { done?: "finished" | "failed"; message?: string };

const MAX_LOG = 50;
const MAX_FAILURES = 5;
const KEEP_ENDED_BOTS = 200;
const DEFAULT_MATCHING_TIMEOUT_MS = 5000;
/** A pending order not found among the current orders this long after it was sent was not placed. */
const PENDING_ORDER_MS = 120_000;

const metaOf = (bot: BotState) => bot.meta as unknown as BotMeta;
const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);
const keyOf = (bot: BotState) => formatSelectionId(bot.selectionId, bot.handicap);

function averagePrice(orders: OrderView[]): number | undefined {
  const matched = sum(orders.map((o) => o.sizeMatched));
  if (matched <= 0) return undefined;
  return sum(orders.map((o) => (o.averagePriceMatched ?? 0) * o.sizeMatched)) / matched;
}

/**
 * Runs position-managing strategies (profit/loss targets, trailing stops, close before the off,
 * delayed bets) on every tick. Bots live in state.bots, so running bots resume after a restart.
 */
export class BotRunner {
  private readonly desk: OrderDesk;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(protected readonly deps: BotDeps) {
    this.desk = new OrderDesk(deps.exchange, deps.limits);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Bots, newest first, optionally filtered. */
  list(filter: { marketId?: string; status?: BotState["status"] } = {}): BotState[] {
    return this.deps.state.bots
      .filter((b) => (!filter.marketId || b.marketId === filter.marketId) && (!filter.status || b.status === filter.status))
      .reverse()
      .map((b) => structuredClone(b));
  }

  /** Register a new running bot (called by the strategy engine). */
  start(spec: BotStart): BotState {
    const at = new Date(this.now()).toISOString();
    const ids = new Set(this.deps.state.bots.map((b) => b.id));
    let id: string;
    do id = `bot-${crypto.randomBytes(4).toString("hex")}`;
    while (ids.has(id));
    const meta: BotMeta = { entryBetIds: [], closeBetIds: [], ...spec.meta, failures: 0 };
    const bot: BotState = {
      id,
      strategyName: spec.strategyName,
      template: spec.template,
      marketId: spec.marketId,
      selectionId: spec.selection.selectionId,
      handicap: spec.selection.handicap,
      createdAt: at,
      updatedAt: at,
      status: "running",
      parameters: { ...spec.parameters },
      betIds: [...(spec.betIds ?? [])],
      log: [],
      meta: meta as unknown as Record<string, unknown>,
    };
    this.log(bot, spec.message ?? "Started.");
    this.deps.state.bots.push(bot);
    this.prune();
    this.deps.state.changed();
    return structuredClone(bot);
  }

  /** Stop a bot; optionally close (green up) the position it manages. */
  stop(botId: string, options: { closePosition?: boolean } = {}): Promise<BotState> {
    return this.exclusive(async () => {
      const bot = this.deps.state.bots.find((b) => b.id === String(botId).trim());
      if (!bot) {
        const running = this.deps.state.bots.filter((b) => b.status === "running").map((b) => b.id);
        throw new Error(`Bot "${botId}" not found. Running bots: ${running.join(", ") || "none"}.`);
      }
      const wasRunning = bot.status === "running";
      if (wasRunning) {
        bot.status = "stopped";
        metaOf(bot).phase = "done";
        this.log(bot, options.closePosition ? "Stopped by request; closing the position." : "Stopped by request; the position (if any) stays open.");
      }
      let notClosed: string | undefined;
      try {
        if (options.closePosition) notClosed = await this.closeNow(bot);
        else if (wasRunning) await this.cancelRestingCloses(bot);
      } catch (error) {
        this.log(bot, `Could not ${options.closePosition ? "close the position" : "cancel the bot's closing bets"}: ${(error as Error).message}`);
        if (options.closePosition) notClosed = (error as Error).message;
      }
      this.deps.state.changed();
      if (notClosed) {
        // A stopped bot no longer manages the position, so the caller must know it is still open.
        throw new Error(`Bot ${bot.id} is stopped, but its position was not closed: ${notClosed} Check get_current_orders and close it (e.g. Close Selection Bet Position).`);
      }
      return structuredClone(bot);
    });
  }

  /** Stop every running bot; returns how many were stopped. Positions stay open. */
  stopAll(): Promise<number> {
    return this.exclusive(async () => {
      const running = this.deps.state.bots.filter((b) => b.status === "running");
      for (const bot of running) {
        bot.status = "stopped";
        metaOf(bot).phase = "done";
        this.log(bot, "Stopped (stop all); the position (if any) stays open.");
        try {
          await this.cancelRestingCloses(bot);
        } catch (error) {
          this.log(bot, `Could not cancel the bot's closing bets: ${(error as Error).message}`);
        }
      }
      if (running.length) this.deps.state.changed();
      return running.length;
    });
  }

  /** Markets with running bots (polled every BOT_INTERVAL_SECONDS). */
  marketIds(): string[] {
    return [...new Set(this.deps.state.bots.filter((b) => b.status === "running").map((b) => b.marketId))];
  }

  /** Evaluate every running bot once (fetches the books it needs). Never throws. */
  async tick(): Promise<void> {
    try {
      await this.exclusive(() => this.tickOnce());
    } catch (error) {
      console.error(`[bots] tick failed: ${(error as Error).message}`);
    }
  }

  /**
   * Run `fn` while no tick, stop or other exclusive work is in progress. Immediate closes use it so
   * a bot and a manual close never hedge from the same stale order snapshot. `fn` must not call
   * back into the runner's exclusive methods.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  // ---------------------------------------------------------------- tick

  private async tickOnce() {
    const running = this.deps.state.bots.filter((b) => b.status === "running");
    if (!running.length) return;
    const ids = [...new Set(running.map((b) => b.marketId))];
    const views = new Map<string, MarketView>();
    let fetchError: Error | undefined;
    try {
      const books = await this.deps.markets.getBooks(ids, { depth: 1 });
      const orders = await this.deps.exchange.currentOrders(ids);
      const rules = await this.deps.exchange.currencyRules();
      for (const id of ids) {
        views.set(id, { marketId: id, book: books.find((b) => b.marketId === id), orders: orders.filter((o) => o.marketId === id), rules, dirty: false });
      }
    } catch (error) {
      fetchError = error as Error;
    }
    for (const bot of running) {
      if (bot.status !== "running") continue;
      if (!metaOf(bot)?.kind || !Array.isArray(bot.betIds) || !Array.isArray(bot.log)) {
        bot.status = "failed";
        bot.log = [...(Array.isArray(bot.log) ? bot.log : []), { at: new Date(this.now()).toISOString(), message: "Unreadable bot state; bot stopped." }];
        this.deps.state.changed();
        continue;
      }
      if (fetchError) {
        // Betfair (or the network) being unreachable is not the bot failing: giving up would leave its
        // position unmanaged (e.g. no close before the off), so it retries on the next tick.
        this.note(bot, `Could not read the market or orders (${fetchError.message}); retrying on the next tick.`);
        this.deps.state.changed();
        continue;
      }
      try {
        await this.evaluate(bot, views.get(bot.marketId)!);
        if (bot.status === "running") metaOf(bot).failures = 0;
      } catch (error) {
        this.failure(bot, error as Error);
      }
      this.deps.state.changed();
    }
  }

  private async evaluate(bot: BotState, view: MarketView) {
    const m = metaOf(bot);
    if (view.dirty) await this.refresh(view);
    if (m.pendingOrderRefs?.length) this.reconcile(bot, m, view);
    if (bot.status !== "running") return;
    const book = view.book;
    if (!book) return this.finish(bot, "finished", "The market is no longer available from Betfair (closed or purged); bot finished.");
    if (book.status === "CLOSED") return this.finish(bot, "finished", "Market closed; bot finished.");
    const runner = runnerOf(book, bot);
    if (!runner) return this.finish(bot, "finished", "The selection is no longer in the market; bot finished.");
    if (runner.status !== "ACTIVE") {
      return this.finish(bot, "finished", `The selection is ${runnerStatusName(runner.status)} (Betfair voids a non-runner's bets); bot finished.`);
    }
    if (book.status !== "OPEN") return this.note(bot, `Market is ${marketStatusName(book.status)}; waiting.`);
    if (m.pendingOrderRefs?.length) {
      // Nothing new is placed until every order sent earlier is found or known not to exist.
      const refs = m.pendingOrderRefs.map((p) => `${p.role} ${p.ref}`).join(", ");
      return this.note(bot, `Waiting to find the bet(s) sent before (${refs}) among the current orders before placing anything new.`);
    }
    switch (m.phase) {
      case "waiting":
        return this.placeEntry(bot, m, view, runner);
      case "fillOrKill":
        return this.fillOrKill(bot, m, view);
      case "open":
        return this.openTrade(bot, m, view, runner);
      case "monitoring":
        return m.kind === "trailing" ? this.trail(bot, m, view, runner) : this.monitor(bot, m, view, runner);
      case "closing":
        return this.apply(bot, await this.closeStep(bot, m, view, runner, false));
      default:
        return this.finish(bot, "finished", `Nothing left to do (phase ${m.phase}).`);
    }
  }

  private entryParams(bot: BotState): Params {
    return metaOf(bot).kind === "trade" ? groupValues(bot.parameters as Params, OPEN) : (bot.parameters as Params);
  }

  private closeParams(bot: BotState): Params {
    return metaOf(bot).kind === "trade" ? groupValues(bot.parameters as Params, CLOSE) : (bot.parameters as Params);
  }

  // ---------------------------------------------------------------- phases

  /** Delayed entry (PlaceBetTimeSpan). */
  private async placeEntry(bot: BotState, m: BotMeta, view: MarketView, runner: Runner) {
    const open = this.entryParams(bot);
    const book = view.book!;
    const now = this.now();
    if (m.placeAt !== undefined && now < m.placeAt) {
      if (book.inplay && open.AllowPlacingBetInPlay === false) {
        return this.finish(bot, "finished", "The market turned in-play before the bet time and AllowPlacingBetInPlay is false; no bet placed.");
      }
      return this.note(bot, `Waiting to place the bet at ${new Date(m.placeAt).toISOString()}.`);
    }
    if (m.kind === "trade" && m.closeAt !== undefined && now >= m.closeAt) {
      return this.finish(bot, "finished", "The close time (ClosePositionTimeSpan) has already passed; the trade was not opened.");
    }
    const balance = open.StakeType === "BankrollPercentage" ? (await this.deps.exchange.accountFunds()).availableToBetBalance : undefined;
    const name = m.selectionName ?? keyOf(bot);
    const plan = planEntry(open, { runner, name, inPlay: Boolean(book.inplay), ladder: m.ladder, balance });
    if ("skip" in plan) return this.finish(bot, "finished", plan.skip);
    if ("problem" in plan) return this.finish(bot, "failed", plan.problem);
    const ref = { selectionId: bot.selectionId, handicap: bot.handicap };
    const placement = await this.placeTracked(bot, m, view, "entry", { ...ref, ...plan, role: "entry", selectionName: m.selectionName }, Boolean(book.inplay));
    if (placement.reason) return this.finish(bot, "failed", `${name}: ${placement.reason} Bet not placed.`);
    const bet = placement.bet!;
    if (bet.status === "UNKNOWN") {
      return this.finish(bot, "failed", `The entry bet's outcome is unknown (${bet.errorCode}); check get_current_orders. The bot does not manage it.`);
    }
    if (bet.status !== "SUCCESS" || !bet.betId) return this.finish(bot, "failed", `The entry bet failed (${bet.errorCode ?? bet.status}).`);
    bot.betIds.push(bet.betId);
    m.entryBetIds.push(bet.betId);
    this.log(bot, `Placed ${bet.side} ${bet.size} @ ${bet.price} (bet ${bet.betId}, matched ${round(bet.sizeMatched ?? 0)}).`);
    this.entryPlaced(bot, m, bet.size, bet.sizeMatched ?? 0, now, Boolean(book.inplay));
  }

  /** The entry bet exists (placed now, or found after a restart): move on to the next phase. */
  private entryPlaced(bot: BotState, m: BotMeta, size: number, sizeMatched: number, at: number, inPlay: boolean) {
    m.placedInPlay = inPlay;
    if (m.kind === "place") return this.finish(bot, "finished", "Bet placed; bot finished.");
    if (m.kind === "fillOrKill") {
      if (sizeMatched >= size - 1e-9) return this.finish(bot, "finished", "Fill or kill: fully matched.");
      m.phase = "fillOrKill";
      m.fillOrKillUntil = at + Math.min(timeSpanMs(this.entryParams(bot).BetMatchingTimeout) ?? DEFAULT_MATCHING_TIMEOUT_MS, FILL_OR_KILL_MAX_MS);
      return;
    }
    m.phase = "open";
  }

  private async fillOrKill(bot: BotState, m: BotMeta, view: MarketView) {
    const entries = view.orders.filter((o) => m.entryBetIds.includes(o.betId));
    const matched = round(sum(entries.map((o) => o.sizeMatched)));
    const resting = entries.filter((o) => o.sizeRemaining > 0);
    if (!resting.length) return this.finish(bot, "finished", `Fill or kill: nothing left unmatched (matched ${matched}).`);
    if (this.now() < (m.fillOrKillUntil ?? 0)) return this.note(bot, "Fill or kill: waiting for the bet to match.");
    const results = await this.cancel(view, resting.map((o) => o.betId));
    const failed = results.filter((r) => !cancelSucceeded(r));
    if (failed.length) throw new Error(`Could not cancel the unmatched bet ${failed.map((r) => `${r.betId} (${r.status})`).join(", ")}.`);
    return this.finish(bot, "finished", `Fill or kill: matched ${matched}; cancelled ${round(sum(results.map((r) => r.sizeCancelled)))} unmatched.`);
  }

  /** "Place Bet and Close Selection Bet Position": wait for the entry, then watch the targets. */
  private async openTrade(bot: BotState, m: BotMeta, view: MarketView, runner: Runner) {
    const open = this.entryParams(bot);
    const now = this.now();
    const own = view.orders.filter((o) => bot.betIds.includes(o.betId));
    const entries = own.filter((o) => m.entryBetIds.includes(o.betId));
    const matched = sum(entries.map((o) => o.sizeMatched));
    if (matched < 0.01) {
      const resting = entries.filter((o) => o.sizeRemaining > 0);
      if (!resting.length) return this.finish(bot, "finished", "The entry bet ended without being matched (cancelled or lapsed); nothing to manage.");
      if (view.book!.inplay && !m.placedInPlay && open.AtInPlayKeepBet !== true) {
        await this.cancelQuietly(bot, view, resting.map((o) => o.betId));
        return this.finish(bot, "finished", "The market turned in-play with the entry unmatched (AtInPlayKeepBet false): the entry lapsed.");
      }
      if (m.closeAt !== undefined && now >= m.closeAt) {
        const results = await this.cancel(view, resting.map((o) => o.betId));
        const failed = results.filter((r) => !cancelSucceeded(r));
        if (failed.length) throw new Error(`Close time reached but the unmatched entry could not be cancelled (${failed.map((r) => r.status).join(", ")}).`);
        return this.finish(bot, "finished", "The close time was reached before the entry was matched; the entry was cancelled.");
      }
      return this.note(bot, "Waiting for the entry to match.");
    }
    m.hadPosition = true;
    const position = positionOf(own);
    const entryPrice = averagePrice(entries)!;
    const risk = liability(entries[0].side, entryPrice, matched);
    const reason = this.targetReason(m, this.closeParams(bot), position, runner, { price: entryPrice, risk });
    if (reason) return this.beginClose(bot, m, view, runner, reason);
  }

  /** "Close Selection Bet Position" on targets: the selection's whole position. */
  private async monitor(bot: BotState, m: BotMeta, view: MarketView, runner: Runner) {
    const close = this.closeParams(bot);
    const mine = view.orders.filter((o) => o.selectionId === keyOf(bot));
    const position = positionOf(mine);
    if (isFlatAt(position, close.HedgingEnabled !== false, runner)) return this.flatOrWait(bot, m, mine);
    m.hadPosition = true;
    const base = mine.filter((o) => !m.closeBetIds.includes(o.betId));
    const long = position.ifWin > position.ifLose;
    const refPrice = averagePrice(base.filter((o) => o.side === (long ? "BACK" : "LAY")));
    const risk = -worstCase(positionOf(base));
    const reason = this.targetReason(m, close, position, runner, { price: refPrice, risk });
    if (reason) return this.beginClose(bot, m, view, runner, reason);
  }

  /** "Trailing Stop Loss": close when the price comes back Loss ticks from the best reached. */
  private async trail(bot: BotState, m: BotMeta, view: MarketView, runner: Runner) {
    const p = this.closeParams(bot);
    const mine = view.orders.filter((o) => o.selectionId === keyOf(bot));
    const position = positionOf(mine);
    if (isFlatAt(position, p.HedgingEnabled !== false, runner)) return this.flatOrWait(bot, m, mine);
    m.hadPosition = true;
    const long = position.ifWin > position.ifLose;
    const side: Side = long ? "BACK" : "LAY";
    if (m.trailSide !== side) {
      m.trailSide = side;
      m.bestPrice = undefined;
    }
    const best = bestPrices(runner);
    const price = long ? best.lay : best.back;
    if (!price) return this.note(bot, `No ${long ? "lay" : "back"} price to trail; waiting.`);
    if (m.bestPrice === undefined || (long ? price < m.bestPrice : price > m.bestPrice)) {
      m.bestPrice = price;
      return this.log(bot, `Trailing from the best price ${price} (stop ${p.Loss} ticks back).`);
    }
    const against = long ? ticksBetween(m.bestPrice, price, m.ladder) : ticksBetween(price, m.bestPrice, m.ladder);
    if (against >= Number(p.Loss)) {
      return this.beginClose(bot, m, view, runner, `trailing stop: price ${price} is ${against} ticks back from the best ${m.bestPrice}`);
    }
  }

  private flatOrWait(bot: BotState, m: BotMeta, orders: OrderView[]) {
    if (!m.hadPosition && orders.some((o) => o.sizeRemaining > 0)) {
      if (m.closeAt !== undefined && this.now() >= m.closeAt) return this.finish(bot, "finished", "The close time was reached with no matched position.");
      return this.note(bot, "Waiting for a matched position.");
    }
    return this.finish(bot, "finished", m.hadPosition ? "The position is flat; bot finished." : "No position to manage; bot finished.");
  }

  private targetReason(m: BotMeta, close: Params, position: Position, runner: Runner, ref: { price?: number; risk?: number }): string | undefined {
    if (m.closeAt !== undefined && this.now() >= m.closeAt) return `close time reached (${close.ClosePositionTimeSpan} from the start)`;
    // With a Profit, Loss or time target the targets decide; ClosePositionImmediately applies only without them.
    if (close.ClosePositionImmediately === true && !hasCloseTargets(close)) return "ClosePositionImmediately";
    const long = position.ifWin > position.ifLose;
    const best = bestPrices(runner);
    const price = close.CheckingLastPriceTraded === true ? runner.lastPriceTraded : long ? best.lay : best.back;
    if (!price) return undefined;
    const profit = greenUpProfit(position, price);
    const target = Number(close.Profit ?? 0);
    const stop = Number(close.Loss ?? 0);
    switch (close.ProfitLossType) {
      case "Money":
        if (target > 0 && profit >= target - 1e-9) return `profit ${round(profit)} reached the target ${target} (price ${price})`;
        if (stop > 0 && -profit >= stop - 1e-9) return `loss ${round(-profit)} reached the limit ${stop} (price ${price})`;
        return undefined;
      case "Percentage": {
        if (!ref.risk || ref.risk <= 0) return undefined;
        const percent = (profit / ref.risk) * 100;
        if (target > 0 && percent >= target - 1e-9) return `profit ${round(percent, 1)}% of the opening risk ${round(ref.risk)} reached the target ${target}% (price ${price})`;
        if (stop > 0 && percent <= -stop + 1e-9) return `loss ${round(-percent, 1)}% of the opening risk ${round(ref.risk)} reached the limit ${stop}% (price ${price})`;
        return undefined;
      }
      default: {
        if (!ref.price) return undefined;
        const ticks = long ? ticksBetween(price, ref.price, m.ladder) : ticksBetween(ref.price, price, m.ladder);
        if (target > 0 && ticks >= target) return `price ${price} is ${ticks} ticks in our favour from ${round(ref.price)} (target ${target})`;
        if (stop > 0 && -ticks >= stop) return `price ${price} is ${-ticks} ticks against us from ${round(ref.price)} (limit ${stop})`;
        return undefined;
      }
    }
  }

  private async beginClose(bot: BotState, m: BotMeta, view: MarketView, runner: Runner, reason: string) {
    m.phase = "closing";
    m.closeReason = reason;
    this.log(bot, `Closing: ${reason}.`);
    this.apply(bot, await this.closeStep(bot, m, view, runner, false));
  }

  /**
   * One closing step: cancel the entry remainder and stale closing bets, then hedge what is
   * matched at the best opposite price. A closing bet younger than BetMatchingTimeout is left to
   * match; an older one is cancelled and re-placed at the new best price. `oneShot` (stop with
   * closePosition) cancels every unmatched bet of the bot and hedges once.
   */
  private async closeStep(bot: BotState, m: BotMeta, view: MarketView, runner: Runner, oneShot: boolean): Promise<Step> {
    const close = this.closeParams(bot);
    const hedging = close.HedgingEnabled !== false;
    const timeout = timeSpanMs(close.BetMatchingTimeout) ?? DEFAULT_MATCHING_TIMEOUT_MS;
    const now = this.now();
    const key = keyOf(bot);
    const scoped = () => (m.scope === "own" ? view.orders.filter((o) => bot.betIds.includes(o.betId)) : view.orders.filter((o) => o.selectionId === key));
    const resting = scoped().filter((o) => o.sizeRemaining > 0);
    const restingCloses = resting.filter((o) => m.closeBetIds.includes(o.betId));
    if (!oneShot && restingCloses.length && m.lastCloseAt !== undefined && now - m.lastCloseAt < timeout) {
      return { message: "Waiting for the closing bet to match." };
    }
    const toCancel = m.scope === "own" || close.CancelUnmatchedBets !== false ? resting : restingCloses;
    if (toCancel.length) {
      const results = await this.cancel(view, toCancel.map((o) => o.betId));
      const failed = toCancel.filter((o) => {
        const result = results.find((r) => r.betId === o.betId);
        return !result || !cancelSucceeded(result);
      });
      const repricing = restingCloses.length && !oneShot ? " (re-pricing the closing bet)" : "";
      this.log(bot, `Cancelled unmatched bet(s) ${toCancel.map((o) => o.betId).join(", ")}${repricing}.`);
      if (failed.length) {
        const statuses = failed.map((o) => `${o.betId}: ${results.find((r) => r.betId === o.betId)?.status ?? "no result"}`);
        throw new Error(`Could not cancel ${statuses.join(", ")}; not hedging while they can still be matched.`);
      }
      await this.refresh(view); // size the hedge on the final matched amounts
    }
    const orders = scoped();
    if (!orders.some((o) => o.sizeMatched > 0)) return { done: "finished", message: "No matched bets to close; bot finished." };
    const position = positionOf(orders);
    const because = m.closeReason ? ` (${m.closeReason})` : "";
    if (isFlatAt(position, hedging, runner)) return { done: "finished", message: `Position closed${because}: ${describePosition(position)}.` };
    const best = bestPrices(runner);
    let order: ReturnType<typeof closeOrder>;
    try {
      order = closeOrder(position, hedging, best.back, best.lay);
    } catch (error) {
      return { message: `${(error as Error).message} Waiting for a price (${describePosition(position)}).` };
    }
    if (!order) return { done: "finished", message: `Position closed${because}: ${describePosition(position)}.` };
    if (order.note) this.log(bot, `${order.note}.`);
    if (m.scope === "own") {
      // Closing bets are exempt from the limits because they reduce risk: never hedge the bot's part
      // again when other bets (e.g. a manual Close Selection) already flattened or reversed the selection,
      // or would once their unmatched hedge-side part matches.
      const onSelection = view.orders.filter((o) => o.selectionId === key);
      const selection = positionOf(onSelection);
      const closing = (p: Position) => {
        try {
          return closeOrder(p, hedging, best.back, best.lay);
        } catch {
          return undefined;
        }
      };
      let whole = closing(selection);
      if (!whole || whole.side !== order.side) {
        return { done: "finished", message: `Other bets already closed the selection's position (${describePosition(selection)}); not hedging this bot's part again.` };
      }
      const hedgeSide = order.side;
      const pending = onSelection.filter((o) => o.sizeRemaining > 0 && o.side === hedgeSide);
      if (pending.length) {
        // Unmatched bets never finish the bot (they may be cancelled or lapse): wait while they would cover the
        // position, and otherwise hedge only what they leave uncovered.
        const ifMatched = pending.reduce((p, o) => addBet(p, o.side, o.price, o.sizeRemaining), selection);
        const rest = closing(ifMatched);
        if (!rest || rest.side !== hedgeSide) {
          return {
            message:
              `Unmatched ${hedgeSide} bet(s) ${pending.map((o) => o.betId).join(", ")} on the selection would close its position when matched; ` +
              "not hedging this bot's part while they rest (it hedges what is left open if they are cancelled or lapse).",
          };
        }
        whole = rest;
      }
      if (whole.size < order.size) {
        this.log(bot, `Other bets on the selection already cover part of this position: hedging ${whole.size} instead of ${order.size}.`);
        order = { ...order, size: whole.size };
      }
    }
    const side = order.side;
    const blocking = orders.filter((o) => o.sizeRemaining > 0 && o.side === side);
    if (blocking.length) {
      return {
        message: `Unmatched ${order.side} bet(s) ${blocking.map((o) => o.betId).join(", ")} would over-hedge the position when matched; not hedging (cancel them, or use CancelUnmatchedBets true).`,
      };
    }
    const tooSmall = betSizeProblem(order.size, order.price, view.rules);
    if (tooSmall) {
      return {
        done: "finished",
        message: `The residual position (${describePosition(position)}) needs ${order.side} ${order.size} @ ${order.price}: ${tooSmall} Left open; bot finished.`,
      };
    }
    const placement = await this.placeTracked(
      bot,
      m,
      view,
      "close",
      {
        selectionId: bot.selectionId,
        handicap: bot.handicap,
        side: order.side,
        price: order.price,
        size: order.size,
        persistenceType: "LAPSE",
        reducesRisk: true,
        role: "close",
        selectionName: m.selectionName,
      },
      Boolean(view.book?.inplay),
    );
    if (placement.reason) throw new Error(`Closing bet not sent: ${placement.reason}`);
    const bet = placement.bet!;
    if (bet.status === "UNKNOWN") {
      return {
        done: "failed",
        message: `The closing bet's outcome is unknown (${bet.errorCode}); bot stopped to avoid hedging twice. Check get_current_orders and close manually if needed.`,
      };
    }
    if (bet.status !== "SUCCESS" || !bet.betId) throw new Error(`Closing bet ${order.side} ${order.size} @ ${order.price} failed (${bet.errorCode ?? bet.status}).`);
    bot.betIds.push(bet.betId);
    m.closeBetIds.push(bet.betId);
    m.lastCloseAt = now;
    this.log(bot, `Placed closing ${bet.side} ${bet.size} @ ${bet.price} (bet ${bet.betId}, matched ${round(bet.sizeMatched ?? 0)}).`);
    const matched = bet.sizeMatched ?? 0;
    if (matched >= bet.size - 1e-9 && bet.averagePriceMatched) {
      const after = addBet(position, bet.side, bet.averagePriceMatched, matched);
      if (isFlatAt(after, hedging, runner)) return { done: "finished", message: `Position closed${because}: ${describePosition(after)}.` };
    }
    return {};
  }

  /** stop(closePosition): one closing attempt, no re-pricing afterwards. Returns why nothing closed the position. */
  private async closeNow(bot: BotState): Promise<string | undefined> {
    const m = metaOf(bot);
    const book = await this.deps.markets.getBook(bot.marketId, { depth: 1 });
    if (book.status !== "OPEN") throw new Error(`the market is ${marketStatusName(book.status)}`);
    const runner = runnerOf(book, bot);
    if (!runner || runner.status !== "ACTIVE") throw new Error(`the selection is ${runnerStatusName(runner?.status) ?? "not in the market"}`);
    const view: MarketView = {
      marketId: bot.marketId,
      book,
      orders: await this.deps.exchange.currentOrders([bot.marketId]),
      rules: await this.deps.exchange.currencyRules(),
      dirty: false,
    };
    if (m.pendingOrderRefs?.length) this.reconcile(bot, m, view);
    if (m.pendingOrderRefs?.length) {
      return `bet(s) sent earlier (${m.pendingOrderRefs.map((p) => `${p.role} ${p.ref}`).join(", ")}) are not among the current orders yet, so no closing bet was placed.`;
    }
    m.closeReason = "stopped by request";
    const placed = m.closeBetIds.length;
    const step = await this.closeStep(bot, m, view, runner, true);
    this.log(bot, step.message ?? "Closing bet placed; the bot is stopped, so it will not be re-priced if it does not match.");
    if (step.done === "failed" || (!step.done && m.closeBetIds.length === placed)) return step.message ?? "no closing bet was placed.";
    return undefined;
  }

  private async cancelRestingCloses(bot: BotState) {
    const m = metaOf(bot);
    if (!m.closeBetIds.length) return;
    const orders = await this.deps.exchange.currentOrders([bot.marketId]);
    const ids = orders.filter((o) => m.closeBetIds.includes(o.betId) && o.sizeRemaining > 0).map((o) => o.betId);
    if (!ids.length) return;
    const results = await this.deps.exchange.cancelOrders(bot.marketId, ids);
    this.log(bot, `Cancelled the bot's unmatched closing bet(s): ${results.map((r) => `${r.betId} ${r.status}`).join(", ")}.`);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Place one order of the bot with its intent saved first: the order's customerOrderRef is recorded in
   * the bot and the state saved synchronously before the request, so a restart while it is in flight
   * finds the bet (reconcile) instead of placing it again. The ref is cleared once the result is back.
   */
  private async placeTracked(bot: BotState, m: BotMeta, view: MarketView, role: PendingOrderRef["role"], order: PlannedOrder, inPlay: boolean): Promise<Placement> {
    const ref = `${bot.id}-${role[0]}${crypto.randomBytes(6).toString("hex")}`;
    m.pendingOrderRefs = [...(m.pendingOrderRefs ?? []), { ref, role, at: this.now(), inPlay }];
    this.deps.state.changed();
    this.deps.state.flush();
    const [placement] = await this.desk.place(bot.marketId, [{ ...order, customerOrderRef: ref }], m.tag, view.rules, m.ladder);
    // A request that threw keeps the ref pending: the next tick looks for the bet before placing anything.
    const left = (m.pendingOrderRefs ?? []).filter((p) => p.ref !== ref);
    m.pendingOrderRefs = left.length ? left : undefined;
    view.dirty = true;
    return placement;
  }

  /** Adopt pending orders found among the current orders (by customerOrderRef); drop those not found in time. */
  private reconcile(bot: BotState, m: BotMeta, view: MarketView) {
    const now = this.now();
    const left: PendingOrderRef[] = [];
    for (const p of m.pendingOrderRefs ?? []) {
      const order = view.orders.find((o) => o.customerOrderRef === p.ref);
      if (!order) {
        if (now - p.at < PENDING_ORDER_MS) left.push(p);
        else {
          this.log(
            bot,
            `The ${p.role} bet sent at ${new Date(p.at).toISOString()} (customerOrderRef ${p.ref}) is not among the current orders after ${PENDING_ORDER_MS / 60_000} minutes: it was not placed; carrying on.`,
          );
        }
        continue;
      }
      if (!bot.betIds.includes(order.betId)) bot.betIds.push(order.betId);
      const what = `${order.side} ${order.size} @ ${order.price} (bet ${order.betId}, matched ${round(order.sizeMatched)})`;
      if (p.role === "entry") {
        if (!m.entryBetIds.includes(order.betId)) m.entryBetIds.push(order.betId);
        this.log(bot, `Found the entry bet sent before (customerOrderRef ${p.ref}): ${what}.`);
        if (m.phase === "waiting") this.entryPlaced(bot, m, order.size, order.sizeMatched, p.at, Boolean(p.inPlay));
      } else {
        if (!m.closeBetIds.includes(order.betId)) m.closeBetIds.push(order.betId);
        m.lastCloseAt = Math.max(m.lastCloseAt ?? 0, p.at);
        this.log(bot, `Found the closing bet sent before (customerOrderRef ${p.ref}): ${what}.`);
      }
    }
    m.pendingOrderRefs = left.length ? left : undefined;
  }

  private async refresh(view: MarketView) {
    view.orders = await this.deps.exchange.currentOrders([view.marketId]);
    view.dirty = false;
  }

  private async cancel(view: MarketView, betIds: string[]): Promise<CancelResult[]> {
    if (!betIds.length) return [];
    view.dirty = true;
    return this.deps.exchange.cancelOrders(view.marketId, betIds);
  }

  private async cancelQuietly(bot: BotState, view: MarketView, betIds: string[]) {
    try {
      const results = await this.cancel(view, betIds);
      const failed = results.filter((r) => !cancelSucceeded(r));
      if (failed.length) this.log(bot, `Could not cancel ${failed.map((r) => `${r.betId} (${r.status})`).join(", ")}.`);
    } catch (error) {
      this.log(bot, `Could not cancel ${betIds.join(", ")}: ${(error as Error).message}`);
    }
  }

  private apply(bot: BotState, step: Step) {
    if (step.done) this.finish(bot, step.done, step.message ?? "Finished.");
    else if (step.message) this.note(bot, step.message);
  }

  private log(bot: BotState, message: string) {
    const at = new Date(this.now()).toISOString();
    bot.log.push({ at, message });
    if (bot.log.length > MAX_LOG) bot.log.splice(0, bot.log.length - MAX_LOG);
    bot.updatedAt = at;
  }

  /** Log a waiting/status message once (not on every tick). */
  private note(bot: BotState, message: string) {
    const m = metaOf(bot);
    if (m.lastNote === message) return;
    m.lastNote = message;
    this.log(bot, message);
  }

  private finish(bot: BotState, status: "finished" | "failed", message: string) {
    bot.status = status;
    metaOf(bot).phase = "done";
    this.log(bot, message);
  }

  private failure(bot: BotState, error: Error) {
    const m = metaOf(bot);
    m.failures = (m.failures ?? 0) + 1;
    this.log(bot, `Error (${m.failures}/${MAX_FAILURES}): ${error.message}`);
    if (m.failures >= MAX_FAILURES) {
      bot.status = "failed";
      m.phase = "done";
      this.log(bot, `Failed ${MAX_FAILURES} ticks in a row; bot stopped. Any open position is left as it is: check get_current_orders.`);
    }
  }

  private prune() {
    const ended = this.deps.state.bots.filter((b) => b.status !== "running");
    if (ended.length <= KEEP_ENDED_BOTS) return;
    const drop = new Set(ended.slice(0, ended.length - KEEP_ENDED_BOTS));
    this.deps.state.bots = this.deps.state.bots.filter((b) => !drop.has(b));
  }
}
