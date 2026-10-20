// Risk guard: the one place every order passes on its way to the exchange (paper or live).
//
// Strategies and bots already check single bets against MAX_STAKE / MAX_LIABILITY before they
// send anything. This layer sits underneath them and holds whatever reaches it, whatever it is
// labelled, to the limits that need the whole account in view:
//
//   - per bet:     MAX_STAKE (back stake) and MAX_LIABILITY (stake or lay liability)
//   - per market:  MAX_MARKET_LIABILITY, the market's worst-case loss
//   - account:     MAX_TOTAL_EXPOSURE, the worst-case loss across every open market
//   - per day:     DAILY_LOSS_LIMIT >= today's settled losses + the worst case of everything open
//   - kill switch: nothing but closing bets until the account holder releases it
//   - live mode:   nothing but closing bets on delayed market data
//   - Australia:   no bets at all on in-play sport (Betfair only takes those by phone)
//
// A request is closing, and skips those checks, when it is bets on one selection on the side that
// reduces its matched position, without going past flat, and however much of it matches and
// whatever happens to the market's other unmatched or possibly-placed bets, the market's worst case
// can't rise. Everything else is new risk, checked against every limit, all or nothing.
//
// The guard fails closed: when it can't read the market, the account or today's results it refuses
// (callers retry), and a kill switch it can't save to disk still holds in this process.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CurrencyRules } from "../betfair/currency.js";
import type { MarketBook, MarketCatalogue } from "../betfair/types.js";
import type { Config, Jurisdiction } from "../config.js";
import { assertMarketId, formatSelectionId, round, sameSelection } from "../format.js";
import type { MarketService } from "../markets.js";
import { addedBound, closingVerdict, enumerable, legLiability, worstLoss, type Closing, type Leg, type MarketShape } from "./exposure.js";
import { liability } from "./math.js";
import type { CancelResult, Exchange, FundsView, OrderRequest, OrderView, PlacedBet, SettledBets, StrategyTag } from "./types.js";

export type RiskLimits = Pick<Config["trading"], "maxStake" | "maxLiability" | "maxMarketLiability" | "maxTotalExposure" | "dailyLossLimit">;

export interface RiskOptions {
  limits: RiskLimits;
  jurisdiction: Jurisdiction;
  /** IANA zone whose midnight starts a new day for DAILY_LOSS_LIMIT. */
  timeZone: string;
  /** With DATA_DIR the kill switch lives in DATA_DIR/kill-switch.json, so every process sharing it sees it. */
  dataDir?: string;
  /** Why this process may not add risk right now (another process owns DATA_DIR), or undefined. */
  addRiskBlocked?: () => string | undefined;
  /** Clock in epoch ms (tests inject one). */
  now?: () => number;
}

export interface KillSwitchState {
  engagedAt: string;
  reason: string;
  /**
   * The file could not be read (not absent, not damaged): new risk is refused meanwhile, but
   * nothing irreversible (stopping bots, cancelling bets) is done on it, as the error may clear.
   */
  unreadable?: true;
}

export interface RiskStatus {
  mode: "paper" | "live";
  limits: RiskLimits;
  /** Set while the kill switch is engaged: only closing bets are placed. */
  killSwitch?: KillSwitchState & { release: string };
  /** Start of the current day for DAILY_LOSS_LIMIT. */
  dayStartedAt: string;
  /** Net settled profit (after commission) since dayStartedAt. */
  settledToday?: number;
  /** Worst-case loss of everything open (Betfair's exposure in live mode). */
  openExposure?: number;
  /** How much more worst-case loss may still be added today. */
  headroom?: number;
  /** Today's settled losses have reached DAILY_LOSS_LIMIT: no new risk until midnight. */
  dailyLimitHit?: boolean;
  /** Caveats on the figures (e.g. commission that could not be read). */
  note?: string;
  /** Why the account figures are missing. */
  error?: string;
}

/** Cancels made by a clean-up, the markets where cancelling failed, and bets the API can't cancel. */
export interface CancelReport {
  cancelled: CancelResult[];
  failures: string[];
  /** Unmatched Betfair SP bets: the API only cancels LIMIT orders. */
  uncancellable: string[];
}

/** Refusals that will not clear while the market lasts (a bot stops retrying them). */
export const PERMANENT_REFUSALS = new Set(["IN_PLAY_SPORT_NOT_ALLOWED", "INVALID_ORDER"]);
/** Refusals caused by a read that failed: a bot tries its entry again rather than giving up. */
export const TRANSIENT_REFUSALS = new Set(["RISK_CHECK_FAILED", "KILL_SWITCH_UNREADABLE"]);

/** The guard's refusal code of a bet it refused, or undefined (Betfair's own codes are never read as one). */
export function guardRefusal(bet: Pick<PlacedBet, "refusedBy" | "errorCode">): string | undefined {
  return bet.refusedBy === "risk-guard" ? (bet.errorCode?.split(":")[0]?.trim() ?? "REFUSED") : undefined;
}

/** Betfair event types that Australian customers may bet on in-play online (racing, not sport). */
const RACING_EVENT_TYPES = new Set(["7", "4339"]);
/** Money comparisons: well below a cent, well above float noise. */
const EPS = 1e-6;
/** An UNKNOWN order (timed out, not found yet) counts as possibly placed for this long unless it shows up among the current orders. */
const UNCONFIRMED_MS = 10 * 60_000;

const keyOf = (order: { selectionId: number; handicap: number }) => formatSelectionId(order.selectionId, order.handicap ?? 0);
const money = (value: number) => (round(value, 2) ?? 0).toFixed(2);

/** An order view as legs see it: one fill at the average matched price, the unmatched remainder, an unmatched SP bet. */
function legOfView(o: OrderView): Leg {
  const fills = o.sizeMatched > 0 && o.averagePriceMatched ? [{ price: o.averagePriceMatched, size: o.sizeMatched }] : [];
  const sp = o.status === "EXECUTABLE" && o.sizeRemaining <= 0 && (o.bspLiability ?? 0) > 0 ? o.bspLiability : undefined;
  return { key: o.selectionId, side: o.side, price: o.price, remaining: o.sizeRemaining, fills, spLiability: sp };
}

/** A new order as a leg: nothing matched yet (it may all match, or any part of it). */
function legOfOrder(o: OrderRequest): Leg {
  return { key: keyOf(o), side: o.side, price: o.price, remaining: o.size, fills: [] };
}

/** The most an order can lose on its own, whatever else happens in its market. */
function ownWorstLoss(legs: Leg[], shape: MarketShape): number {
  return worstLoss(legs, shape, "hurt");
}

function refused(order: OrderRequest, errorCode: string): PlacedBet {
  return { selectionId: keyOf(order), side: order.side, price: order.price, size: order.size, status: "FAILURE", errorCode, refusedBy: "risk-guard" };
}

/** Prices and stakes in whole cents, as every exchange sends them (checked as sent). */
function normalised(o: OrderRequest): OrderRequest {
  return { ...o, price: round(o.price, 2) ?? Number.NaN, size: round(o.size, 2) ?? Number.NaN };
}

/** Why an order cannot even be assessed (NaN, out-of-range price, stake under a cent). */
function invalidOrder(o: OrderRequest): string | undefined {
  if (o.side !== "BACK" && o.side !== "LAY") return `side must be BACK or LAY, got ${String(o.side)}`;
  if (!Number.isInteger(o.selectionId) || !Number.isFinite(o.handicap ?? 0)) return "the selection is not valid";
  if (!Number.isFinite(o.price) || o.price < 1.01 || o.price > 1000) return `price ${o.price} is not a Betfair price (1.01 to 1000)`;
  if (!Number.isFinite(o.size) || o.size < 0.01) return `size ${o.size} is not a positive amount`;
  return undefined;
}

/** A leg reduced to its matched part (cancelled, or judged as the request itself). */
const matchedOnly = (leg: Leg): Leg => ({ ...leg, remaining: 0, spLiability: undefined });

// ------------------------------------------------------------------ day boundary

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** Local calendar date of `ms` in `timeZone` (YYYY-MM-DD). */
function localDate(ms: number, timeZone: string): string {
  let format = dateFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormats.set(timeZone, format);
  }
  return format.format(new Date(ms));
}

/**
 * Epoch ms of the first instant of the local day containing `now` in `timeZone`: a binary search
 * on the local date, so days that start twice (clocks going back at 01:00) or not at midnight
 * (clocks going forward at 00:00) start at their first instant.
 */
export function startOfDay(now: number, timeZone: string): number {
  const today = localDate(now, timeZone);
  let hi = Math.floor(now / 1000); // seconds: zone offsets are whole seconds
  let lo = hi - 30 * 3600;
  while (localDate(lo * 1000, timeZone) === today) lo -= 24 * 3600;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(mid * 1000, timeZone) === today) hi = mid;
    else lo = mid;
  }
  return hi * 1000;
}

// ------------------------------------------------------------------ kill switch

type FileRead = { state: KillSwitchState } | { absent: true } | { broken: string; unreadable?: true };

/**
 * Kill switch flag. With DATA_DIR it is a file every process sharing DATA_DIR reads, and deleting
 * the file releases it. Engaging sets it in memory before writing the file, so a disk error can't
 * leave it off here: then it holds in this process until it restarts.
 */
class KillSwitchStore {
  private memory?: KillSwitchState;
  /** Engaged, but the file could not be written. */
  private memoryOnly = false;

  constructor(readonly file?: string) {}

  private read(): FileRead {
    let text: string;
    try {
      text = fs.readFileSync(this.file!, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
      return { broken: `the kill switch file could not be read (${(error as Error).message}), so it counts as engaged until it can be`, unreadable: true };
    }
    try {
      const parsed = JSON.parse(text) as Partial<KillSwitchState>;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      return { state: { engagedAt: String(parsed.engagedAt ?? ""), reason: String(parsed.reason ?? "engaged") } };
    } catch {
      return { broken: "the kill switch file is damaged, so it counts as engaged" };
    }
  }

  get(): KillSwitchState | undefined {
    if (!this.file || this.memoryOnly) return this.memory;
    const read = this.read();
    if ("absent" in read) {
      this.memory = undefined; // released by deleting the file
      return undefined;
    }
    if ("state" in read) return read.state;
    return { engagedAt: "", reason: read.broken, ...(read.unreadable ? { unreadable: true as const } : {}) };
  }

  engage(state: KillSwitchState): KillSwitchState & { fileError?: string } {
    if (!this.file) return (this.memory ??= state);
    if (this.memoryOnly) return this.memory!;
    const read = this.read();
    if ("state" in read) return read.state; // engaged already: keep the first reason and time
    // Absent, unreadable or damaged: engage now, in memory first, then in the file.
    this.memory = state;
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return state;
    } catch (error) {
      this.memoryOnly = true;
      return { ...state, fileError: (error as Error).message };
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Nothing to clean up.
      }
    }
  }

  /** How the account holder releases it (deliberately not something a tool can do). */
  releaseHint(): string {
    if (this.file && !this.memoryOnly) return `delete ${this.file}`;
    return this.file
      ? "restart the connector (the kill switch file could not be written, so it holds in this process until it restarts)"
      : "restart the connector (without DATA_DIR the kill switch lives in memory)";
  }
}

// ------------------------------------------------------------------ the guard

interface MarketRisk {
  book: MarketBook;
  catalogue?: MarketCatalogue;
  /** The market's orders as the exchange reports them. */
  views: OrderView[];
  /** Those orders as legs (same order as views). */
  legs: Leg[];
  /** Orders sent earlier whose outcome is unknown: they may exist. */
  phantoms: Leg[];
  shape: MarketShape;
}

interface AccountRisk {
  /** Worst-case loss of everything open, as the exchange reports it (before this request). */
  exposure: number;
  /** Today's net settled result (negative: a loss); a lower bound when commission is unknown. */
  settledToday: number;
  note?: string;
}

interface Verdict {
  /** Per-order refusal, or undefined for orders that may be sent. */
  problems: Array<string | undefined>;
  /** The request adds risk (checked) rather than only closing a position. */
  addsRisk: boolean;
  /** Exposure reserved at account level until the request has landed. */
  reservation?: number;
}

/** Exchange decorator that enforces the account's risk limits on every order. */
export class GuardedExchange implements Exchange {
  readonly mode: "paper" | "live";
  private readonly killSwitchStore: KillSwitchStore;
  /** One placement at a time per market. */
  private readonly marketQueues = new Map<string, Promise<unknown>>();
  /** Account-level checks one at a time, with the exposure of requests still on their way reserved. */
  private accountQueue: Promise<unknown> = Promise.resolve();
  private readonly reservations = new Map<number, { amount: number; landed: boolean }>();
  private nextReservation = 0;
  /** Orders whose outcome came back UNKNOWN: counted as possibly placed until found or expired. */
  private unconfirmed: Array<{ marketId: string; leg: Leg; ref?: string; until: number }> = [];

  constructor(
    readonly inner: Exchange,
    private readonly markets: MarketService,
    private readonly options: RiskOptions,
  ) {
    this.mode = inner.mode;
    this.killSwitchStore = new KillSwitchStore(options.dataDir ? path.join(options.dataDir, "kill-switch.json") : undefined);
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  // ---------------------------------------------------------------- pass-through

  currencyRules(): Promise<CurrencyRules> {
    return this.inner.currencyRules();
  }

  cancelOrders(marketId: string, betIds: string[] | "ALL"): Promise<CancelResult[]> {
    return this.inner.cancelOrders(marketId, betIds);
  }

  currentOrders(marketIds?: string[]): Promise<OrderView[]> {
    return this.inner.currentOrders(marketIds);
  }

  accountFunds(): Promise<FundsView> {
    return this.inner.accountFunds();
  }

  settledBets(from: Date, marketIds?: string[]): Promise<SettledBets> {
    return this.inner.settledBets(from, marketIds);
  }

  pendingMarketIds(): string[] {
    return this.inner.pendingMarketIds();
  }

  // ---------------------------------------------------------------- kill switch

  killSwitch(): KillSwitchState | undefined {
    return this.killSwitchStore.get();
  }

  /** Engage the kill switch (an engaged switch keeps its first reason and time). `fileError`: it holds in this process only. */
  engageKillSwitch(reason: string): KillSwitchState & { fileError?: string } {
    return this.killSwitchStore.engage({ engagedAt: new Date(this.now()).toISOString(), reason: reason.trim() || "engaged" });
  }

  killSwitchReleaseHint(): string {
    return this.killSwitchStore.releaseHint();
  }

  // ---------------------------------------------------------------- placing

  /** One placement at a time per market (a slow in-play placement on one market doesn't hold up another). */
  placeOrders(marketId: string, orders: OrderRequest[], strategy: StrategyTag): Promise<PlacedBet[]> {
    let id: string;
    try {
      id = assertMarketId(marketId);
    } catch (error) {
      return Promise.resolve(orders.map((order) => refused(order, `INVALID_ORDER: ${(error as Error).message}`)));
    }
    const run = () => this.guardedPlace(id, orders.map(normalised), strategy);
    const next = (this.marketQueues.get(id) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => undefined);
    this.marketQueues.set(id, tail);
    void tail.then(() => {
      if (this.marketQueues.get(id) === tail) this.marketQueues.delete(id);
    });
    return next;
  }

  private withAccountQueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.accountQueue.then(fn, fn);
    this.accountQueue = next.catch(() => undefined);
    return next;
  }

  /** Why a request that adds risk can't be sent at all right now (kill switch, read-only process), or undefined. */
  private blockedNow(): string | undefined {
    const kill = this.killSwitch();
    if (kill?.unreadable) return `KILL_SWITCH_UNREADABLE: ${kill.reason}; nothing that adds risk is sent meanwhile. Try again.`;
    if (kill) {
      return `KILL_SWITCH_ENGAGED: no new risk${kill.engagedAt ? ` since ${kill.engagedAt}` : ""} (${kill.reason}). Bets that close a position still go through. Only the account holder can release it: ${this.killSwitchReleaseHint()}.`;
    }
    const blocked = this.options.addRiskBlocked?.();
    return blocked ? `READ_ONLY_PROCESS: ${blocked}` : undefined;
  }

  private async guardedPlace(marketId: string, requested: OrderRequest[], strategy: StrategyTag): Promise<PlacedBet[]> {
    if (!requested.length) return [];

    let market: MarketRisk;
    try {
      market = await this.marketRisk(marketId);
    } catch (error) {
      // Without the positions nothing can be shown to close one: refuse everything, the caller retries.
      const reason = `RISK_CHECK_FAILED: could not read the market or its orders (${(error as Error).message}); nothing was sent. Try again.`;
      return requested.map((order) => refused(order, invalidOrder(order) ? `INVALID_ORDER: ${invalidOrder(order)}` : reason));
    }
    // Every order is sent as the market's own runner (exact selection id and handicap), so it is
    // judged with the same key as the bets already on that runner.
    const orders = requested.map((order) => {
      const runner = market.book.runners.find((r) => sameSelection({ selectionId: r.selectionId, handicap: r.handicap ?? 0 }, { selectionId: order.selectionId, handicap: order.handicap ?? 0 }));
      return runner ? { ...order, selectionId: runner.selectionId, handicap: runner.handicap ?? 0 } : order;
    });
    const invalid = orders.map((order) => {
      const problem = invalidOrder(order);
      if (problem) return problem;
      const runner = market.book.runners.find((r) => r.selectionId === order.selectionId && (r.handicap ?? 0) === order.handicap);
      if (!runner) return `selection ${keyOf(order)} is not a runner in this market`;
      if (runner.status !== "ACTIVE") return `selection ${keyOf(order)} is not an active runner (${runner.status})`;
      return undefined;
    });
    const bettingType = market.catalogue?.description?.bettingType ?? "ODDS";

    const sportInPlay =
      this.options.jurisdiction === "au" && Boolean(market.book.inplay) && !RACING_EVENT_TYPES.has(market.catalogue?.eventType?.id ?? "");
    let verdict: Verdict;
    if (sportInPlay) {
      const reason = market.catalogue
        ? "IN_PLAY_SPORT_NOT_ALLOWED: Australian customers can't bet in-play on sport online, including through the API (Betfair only takes those bets by phone). Close sport positions before the off."
        : "IN_PLAY_SPORT_NOT_ALLOWED: the market is in-play and its sport could not be read; Australian customers can't bet in-play on sport online, so nothing was sent.";
      verdict = { problems: orders.map(() => reason), addsRisk: false };
    } else if (!market.catalogue) {
      const reason = "RISK_CHECK_FAILED: the market's description could not be read; nothing was sent. Try again.";
      verdict = { problems: orders.map(() => reason), addsRisk: false };
    } else if (bettingType !== "ODDS") {
      // Line and handicap markets don't price bets as odds: the guard's maths would not hold there.
      const reason = `INVALID_ORDER: this is a ${bettingType} market; the connector only places bets on fixed-odds (ODDS) markets.`;
      verdict = { problems: orders.map(() => reason), addsRisk: false };
    } else if (market.catalogue.description?.marketType === "EACH_WAY") {
      // An each-way bet is two bets (win and place at a fraction of the odds): not what the guard models.
      const reason = "INVALID_ORDER: this is an each-way market; the connector's risk model only covers win-or-lose bets, so it doesn't bet on them.";
      verdict = { problems: orders.map(() => reason), addsRisk: false };
    } else if (invalid.some(Boolean)) {
      verdict = {
        problems: orders.map((_, i) =>
          invalid[i] ? `INVALID_ORDER: ${invalid[i]}` : "BATCH_REFUSED: not sent because another bet in the same request is not a valid order; bets sent together go all or nothing.",
        ),
        addsRisk: true,
      };
    } else {
      verdict = await this.assess(market, orders);
    }

    const results: Array<PlacedBet | undefined> = verdict.problems.map((problem, i) => (problem ? refused(orders[i], problem) : undefined));
    const send = orders.map((_, i) => i).filter((i) => !verdict.problems[i]);
    const release = () => {
      if (verdict.reservation !== undefined) this.reservations.delete(verdict.reservation);
    };
    if (!send.length) {
      release();
      return results as PlacedBet[];
    }
    // Checked again just before sending (nothing awaits in between): a kill switch engaged, or the
    // DATA_DIR lock lost, while this request waited for its checks stops it here.
    const blocked = verdict.addsRisk ? this.blockedNow() : undefined;
    if (blocked) {
      release();
      return orders.map((order) => refused(order, blocked));
    }

    const delayedPaper =
      this.mode === "paper" && market.book.isMarketDataDelayed
        ? "Delayed data: Betfair is sending this market's prices late (up to 3 minutes on a delayed app key) and without traded volume, so this paper result doesn't show what a live bet would have done."
        : undefined;
    let placed: PlacedBet[];
    try {
      placed = await this.inner.placeOrders(marketId, send.map((i) => orders[i]), strategy);
    } catch (error) {
      release(); // nothing was placed
      throw error;
    }
    // Landed: the next account read includes it, so the reservation goes at the start of that read.
    const reservation = verdict.reservation !== undefined ? this.reservations.get(verdict.reservation) : undefined;
    if (reservation) reservation.landed = true;

    // A kill switch engaged while this request was on its way: take back what it left resting.
    const cancelNotes = verdict.addsRisk && this.killSwitch() ? await this.cancelLanded(marketId, placed) : undefined;

    send.forEach((i, k) => {
      const bet = placed[k];
      if (!bet) return;
      const warning = [delayedPaper, bet.betId ? cancelNotes?.get(bet.betId) : undefined].filter(Boolean).join(" ");
      results[i] = warning ? { ...bet, warning } : bet;
      if (bet.status === "UNKNOWN") {
        this.unconfirmed.push({ marketId, leg: { ...legOfOrder(orders[i]), improvable: true }, ref: bet.customerOrderRef ?? orders[i].customerOrderRef, until: this.now() + UNCONFIRMED_MS });
      }
    });

    return results.map(
      (bet, i) =>
        bet ?? {
          selectionId: keyOf(orders[i]),
          side: orders[i].side,
          price: orders[i].price,
          size: orders[i].size,
          status: "UNKNOWN",
          errorCode: "NO_REPORT: check get_current_orders before retrying",
        },
    );
  }

  /** Cancel the unmatched part of bets that landed after the kill switch was engaged; betId -> note. */
  private async cancelLanded(marketId: string, placed: PlacedBet[]): Promise<Map<string, string>> {
    const notes = new Map<string, string>();
    const resting = placed.filter((b) => b.status === "SUCCESS" && b.betId && (b.orderStatus === "EXECUTABLE" || (b.sizeMatched ?? 0) < b.size - EPS));
    if (!resting.length) return notes;
    try {
      const results = await this.inner.cancelOrders(marketId, resting.map((b) => b.betId!));
      for (const bet of resting) {
        const result = results.find((r) => r.betId === bet.betId);
        notes.set(
          bet.betId!,
          result?.status === "SUCCESS" || result?.status === "BET_TAKEN_OR_LAPSED"
            ? "The kill switch was engaged while this bet was being placed: its unmatched part was cancelled."
            : `The kill switch was engaged while this bet was being placed, and cancelling its unmatched part failed (${result?.status ?? "no result"}): cancel it with cancel_bets.`,
        );
      }
    } catch (error) {
      for (const bet of resting) {
        notes.set(bet.betId!, `The kill switch was engaged while this bet was being placed, and cancelling its unmatched part failed (${(error as Error).message}): cancel it with cancel_bets.`);
      }
    }
    return notes;
  }

  /** Closing requests pass; anything else is checked as new risk, all or nothing. */
  private async assess(market: MarketRisk, orders: OrderRequest[]): Promise<Verdict> {
    const legs = orders.map(legOfOrder);
    const closing = this.closes(market, legs);
    if (closing.closing) return { problems: orders.map(() => undefined), addsRisk: false };

    const note = closing.why
      ? ` (It reduces the position on its selection, but it isn't counted as a closing bet: ${closing.why}.)`
      : orders.some((o) => o.reducesRisk)
        ? " (It was sent as a closing bet, but it doesn't reduce a matched position on its selection, so it was checked as a new bet.)"
        : "";
    const all = (problem: string): Verdict => ({ problems: orders.map(() => problem + note), addsRisk: true });
    const limits = this.options.limits;

    const blocked = this.blockedNow();
    if (blocked) return all(blocked);
    if (this.mode === "live" && market.book.isMarketDataDelayed) {
      return all(
        "DELAYED_DATA: Betfair is sending this market's prices with a delay (a delayed app key, an unfunded account or a throttled live key), so no real-money bet that adds risk is placed on it.",
      );
    }

    // Per bet.
    const perBet = orders.map((order) => {
      if (order.side === "BACK" && order.size > limits.maxStake + EPS) return `MAX_STAKE: stake ${money(order.size)} exceeds MAX_STAKE ${limits.maxStake}.`;
      const risk = liability(order.side, order.price, order.size);
      if (risk > limits.maxLiability + EPS) return `MAX_LIABILITY: liability ${money(risk)} exceeds MAX_LIABILITY ${limits.maxLiability}.`;
      return undefined;
    });
    const first = perBet.findIndex(Boolean);
    if (first >= 0) {
      const name = keyOf(orders[first]);
      return {
        problems: orders.map(
          (_, i) =>
            (perBet[i] ?? `BATCH_REFUSED: not sent because the bet on ${name} in the same request was refused (${perBet[first]!.split(":")[0]}); bets sent together go all or nothing.`) + note,
        ),
        addsRisk: true,
      };
    }

    // Market: unmatched and possibly-placed bets counted where they hurt (exact, or an upper bound
    // when the outcomes can't be enumerated).
    const known = [...market.legs, ...market.phantoms];
    const all_ = [...known, ...legs];
    const shape: MarketShape = legs.some((l) => l.key.includes("_")) ? { ...market.shape, winners: undefined } : market.shape;
    const exact = enumerable(all_.map((l) => l.key), shape);
    const before = worstLoss(known, shape, "hurt");
    const after = worstLoss(all_, shape, "hurt");
    if (after > limits.maxMarketLiability + EPS) {
      return all(
        `MAX_MARKET_LIABILITY: this would take the market's worst-case loss from ${money(before)} to ${money(after)}, above MAX_MARKET_LIABILITY ${limits.maxMarketLiability}.`,
      );
    }
    // What this request can add to the account's worst case, whatever happens meanwhile to the market's
    // other bets (an unmatched one cancelled or lapsing while this request is on its way must not free
    // its headroom): its own worst loss, or less where the market's matched bets cover it for sure.
    let added = ownWorstLoss(legs, shape);
    const bound = exact ? addedBound(known, shape, legs) : undefined;
    if (bound !== undefined) added = Math.min(added, bound);

    // Account and day: one request at a time, with requests still on their way reserved.
    return this.withAccountQueue(async (): Promise<Verdict> => {
      // Snapshot before reading the account: a request that has landed is in the figures read below; one
      // still on its way is not, so it stays counted until a read that starts after it landed.
      let pending = 0;
      for (const [id, r] of this.reservations) {
        if (r.landed) this.reservations.delete(id);
        else pending += r.amount;
      }
      const now = this.now();
      // Possibly-placed bets: the exchange's figure may not include them yet.
      for (const u of this.unconfirmed) if (u.until > now) pending += legLiability(u.leg);
      let account: AccountRisk;
      try {
        account = await this.accountRisk();
      } catch (error) {
        return all(`RISK_CHECK_FAILED: could not read the account's exposure or today's results (${(error as Error).message}); nothing that adds risk was sent. Try again.`);
      }
      const stopped = this.blockedNow();
      if (stopped) return all(stopped);
      const total = account.exposure + pending + added;
      if (total > limits.maxTotalExposure + EPS) {
        return all(`MAX_TOTAL_EXPOSURE: open worst-case loss would be ${money(total)}, above MAX_TOTAL_EXPOSURE ${limits.maxTotalExposure}.`);
      }
      const lossToday = Math.max(0, -account.settledToday);
      if (lossToday >= limits.dailyLossLimit - EPS) {
        return all(`DAILY_LOSS_LIMIT: today's settled loss ${money(lossToday)} has reached DAILY_LOSS_LIMIT ${limits.dailyLossLimit}; no new risk until midnight (${this.options.timeZone}).`);
      }
      if (lossToday + total > limits.dailyLossLimit + EPS) {
        const left = Math.max(0, limits.dailyLossLimit - lossToday - (total - added));
        return all(
          `DAILY_LOSS_LIMIT: today's settled loss ${money(lossToday)} plus an open worst case of ${money(total)} would exceed DAILY_LOSS_LIMIT ${limits.dailyLossLimit} (${money(left)} of new risk is left today).`,
        );
      }
      const reservation = ++this.nextReservation;
      this.reservations.set(reservation, { amount: added, landed: false });
      return { problems: orders.map(() => undefined), addsRisk: true, reservation };
    });
  }

  private closes(market: MarketRisk, legs: Leg[]): Closing {
    const shape: MarketShape = legs.some((l) => l.key.includes("_")) ? { ...market.shape, winners: undefined } : market.shape;
    return closingVerdict([...market.legs, ...market.phantoms], shape, legs);
  }

  /** The market's book, catalogue and orders, plus orders whose outcome is unknown. Throws when the book or orders cannot be read. */
  private async marketRisk(marketId: string): Promise<MarketRisk> {
    const book = await this.markets.getBook(marketId, { depth: 1 });
    let catalogue: MarketCatalogue | undefined;
    try {
      catalogue = await this.markets.getCatalogue(marketId);
    } catch {
      catalogue = this.markets.cachedCatalogue(marketId);
    }
    const views = (await this.inner.currentOrders([marketId])).filter((o) => o.marketId === marketId);
    const legs = views.map(legOfView);
    const refs = new Set(views.map((o) => o.customerOrderRef).filter(Boolean));
    const now = this.now();
    this.unconfirmed = this.unconfirmed.filter((u) => u.until > now && !(u.ref && refs.has(u.ref)));
    const phantoms = this.unconfirmed.filter((u) => u.marketId === marketId).map((u) => u.leg);
    const bettingType = catalogue?.description?.bettingType;
    const handicap = [...legs, ...phantoms].some((l) => l.key.includes("_")) || (bettingType !== undefined && bettingType !== "ODDS");
    return {
      book,
      catalogue,
      views,
      legs,
      phantoms,
      shape: {
        winners: handicap ? undefined : book.numberOfWinners,
        active: book.runners.filter((r) => r.status === "ACTIVE").map((r) => keyOf(r)),
        removed: book.runners.filter((r) => r.status === "REMOVED" || r.status === "REMOVED_VACANT").map((r) => keyOf(r)),
      },
    };
  }

  /**
   * Open exposure (before any new bet) and today's settled result. Read in that order, so a market
   * settling in between is counted twice (open and settled) rather than not at all. Without the
   * commission figure, winning markets count as zero (commission can't exceed a market's winnings).
   */
  private async accountRisk(): Promise<AccountRisk> {
    const funds = await this.inner.accountFunds();
    const exposure = Number(funds.exposure);
    if (funds.exposure === undefined || funds.exposure === null || !Number.isFinite(exposure)) throw new Error("the account's exposure figure is missing");
    const settled = await this.inner.settledBets(new Date(startOfDay(this.now(), this.options.timeZone)));
    if (settled.truncated) throw new Error("too many bets settled today to add up");
    const byMarket = new Map<string, number>();
    for (const b of settled.bets) byMarket.set(b.marketId, (byMarket.get(b.marketId) ?? 0) + (Number(b.profit) || 0));
    let settledToday: number;
    let note: string | undefined;
    if (settled.commission === undefined || !Number.isFinite(settled.commission)) {
      settledToday = 0;
      for (const profit of byMarket.values()) settledToday += Math.min(0, profit);
      note = "Today's commission could not be read, so today's winning markets are counted as zero.";
    } else {
      settledToday = -settled.commission;
      for (const profit of byMarket.values()) settledToday += profit;
    }
    return { exposure: Math.abs(exposure), settledToday, note };
  }

  // ---------------------------------------------------------------- status and clean-up

  riskLimits(): RiskLimits {
    return pickLimits(this.options.limits);
  }

  async riskStatus(): Promise<RiskStatus> {
    const dayStart = startOfDay(this.now(), this.options.timeZone);
    const kill = this.killSwitch();
    const status: RiskStatus = {
      mode: this.mode,
      limits: pickLimits(this.options.limits),
      killSwitch: kill ? { ...kill, release: `only the account holder can release it: ${this.killSwitchReleaseHint()}` } : undefined,
      dayStartedAt: new Date(dayStart).toISOString(),
    };
    try {
      const account = await this.accountRisk();
      const lossToday = Math.max(0, -account.settledToday);
      const limits = this.options.limits;
      status.settledToday = round(account.settledToday, 2);
      status.openExposure = round(account.exposure, 2);
      status.headroom = round(Math.max(0, Math.min(limits.maxTotalExposure - account.exposure, limits.dailyLossLimit - lossToday - account.exposure)), 2);
      status.dailyLimitHit = lossToday >= limits.dailyLossLimit - EPS;
      status.note = account.note;
    } catch (error) {
      status.error = (error as Error).message;
    }
    return status;
  }

  /**
   * Today's settled losses have reached DAILY_LOSS_LIMIT. Undefined when the account can't be read
   * (placements are refused meanwhile, so the clean-up can wait for the next check).
   */
  async dailyLimitHit(): Promise<boolean | undefined> {
    let account: AccountRisk;
    try {
      account = await this.accountRisk();
    } catch {
      return undefined;
    }
    return Math.max(0, -account.settledToday) >= this.options.limits.dailyLossLimit - EPS;
  }

  /** Unmatched SP bets among `orders` (the API can't cancel them), for reports. */
  private spBets(orders: OrderView[]): string[] {
    return orders
      .filter((o) => o.status === "EXECUTABLE" && o.sizeRemaining <= 0 && (o.bspLiability ?? 0) > 0)
      .map((o) => `${o.betId} (${o.side} at Betfair SP, liability ${money(o.bspLiability!)}, market ${o.marketId})`);
  }

  /** Cancel every unmatched bet on the account (kill switch), market by market; one market's failure doesn't stop the others. */
  async cancelAllUnmatched(): Promise<CancelReport> {
    const orders = await this.inner.currentOrders();
    const report: CancelReport = { cancelled: [], failures: [], uncancellable: this.spBets(orders) };
    for (const marketId of [...new Set(orders.filter((o) => o.sizeRemaining > 0).map((o) => o.marketId))]) {
      try {
        const results = await this.inner.cancelOrders(marketId, "ALL");
        report.cancelled.push(...results);
        for (const r of results) if (r.status !== "SUCCESS" && r.status !== "BET_TAKEN_OR_LAPSED") report.failures.push(`${marketId}: bet ${r.betId} ${r.status}`);
      } catch (error) {
        report.failures.push(`${marketId}: ${(error as Error).message}`);
      }
    }
    return report;
  }

  /**
   * Cancel the unmatched bets that would add risk if they matched and keep the ones that close a
   * position, judged by the closing rule: first every bet that doesn't reduce a matched position is
   * cancelled, then the rest, oldest first, each with the others still resting counted as uncertain.
   */
  async cancelRiskAddingUnmatched(): Promise<CancelReport> {
    const orders = await this.inner.currentOrders();
    const report: CancelReport = { cancelled: [], failures: [], uncancellable: this.spBets(orders) };
    for (const marketId of [...new Set(orders.filter((o) => o.sizeRemaining > 0).map((o) => o.marketId))]) {
      try {
        const market = await this.marketRisk(marketId);
        const resting = market.views
          .map((view, i) => ({ view, i }))
          .filter(({ view }) => view.sizeRemaining > 0)
          .sort((a, b) => a.view.placedDate.localeCompare(b.view.placedDate));
        const cancel = new Set<number>();
        const judge = (i: number) => {
          const legs = market.legs.map((leg, j) => (j === i || cancel.has(j) ? matchedOnly(leg) : leg));
          const view = market.views[i];
          return this.closes({ ...market, legs }, [{ key: view.selectionId, side: view.side, price: view.price, remaining: view.sizeRemaining, fills: [] }]);
        };
        // Bets that don't reduce a matched position add risk whatever else happens.
        for (const { i } of resting) {
          const verdict = judge(i);
          if (!verdict.closing && !verdict.why) cancel.add(i);
        }
        for (const { i } of resting) if (!cancel.has(i) && !judge(i).closing) cancel.add(i);
        const betIds = [...cancel].map((i) => market.views[i].betId);
        if (!betIds.length) continue;
        const results = await this.inner.cancelOrders(marketId, betIds);
        report.cancelled.push(...results);
        for (const id of betIds) {
          const r = results.find((x) => x.betId === id);
          if (!r || (r.status !== "SUCCESS" && r.status !== "BET_TAKEN_OR_LAPSED")) report.failures.push(`${marketId}: bet ${id} ${r?.status ?? "no result"}`);
        }
      } catch (error) {
        report.failures.push(`${marketId}: ${(error as Error).message}`);
      }
    }
    return report;
  }
}

function pickLimits(limits: RiskLimits): RiskLimits {
  const { maxStake, maxLiability, maxMarketLiability, maxTotalExposure, dailyLossLimit } = limits;
  return { maxStake, maxLiability, maxMarketLiability, maxTotalExposure, dailyLossLimit };
}
