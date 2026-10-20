// Risk guard: the one place every order passes on its way to the exchange (paper or live).
//
// Strategies and bots already check single bets against MAX_STAKE / MAX_LIABILITY before they
// send anything. This layer sits underneath them and enforces the limits that need the whole
// account in view, so that no strategy bug, mislabelled "closing" bet or concurrent request can
// get around them:
//
//   - per bet:     MAX_STAKE (back stake) and MAX_LIABILITY (stake or lay liability)
//   - per market:  MAX_MARKET_LIABILITY, the market's worst-case loss
//   - account:     MAX_TOTAL_EXPOSURE, the worst-case loss across every open market
//   - per day:     DAILY_LOSS_LIMIT >= today's settled losses + the worst case of everything open
//   - kill switch: no new risk at all until the account holder releases it
//   - live mode:   no new risk on delayed market data
//   - Australia:   no bets on in-play sport (Betfair only takes those by phone)
//
// "Risk" is the market's worst-case loss with unmatched bets counted only where they hurt
// (Betfair's exposure rule). A bet that does not raise it is closing or neutral and always goes
// through, whatever it is labelled; a bet that raises it is checked, whatever it is labelled.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CurrencyRules } from "../betfair/currency.js";
import type { MarketBook, MarketCatalogue } from "../betfair/types.js";
import type { Config, Jurisdiction } from "../config.js";
import { formatSelectionId, round } from "../format.js";
import type { MarketService } from "../markets.js";
import { addBet, liability, positionOf, worstCase } from "./math.js";
import { marketExposure, type ExposureLeg } from "./paper.js";
import type { CancelResult, Exchange, FundsView, OrderRequest, OrderView, PlacedBet, SettledBets, StrategyTag } from "./types.js";

export type RiskLimits = Pick<Config["trading"], "maxStake" | "maxLiability" | "maxMarketLiability" | "maxTotalExposure" | "dailyLossLimit">;

export interface RiskOptions {
  limits: RiskLimits;
  jurisdiction: Jurisdiction;
  /** IANA zone whose midnight starts a new day for DAILY_LOSS_LIMIT. */
  timeZone: string;
  /** With DATA_DIR the kill switch lives in DATA_DIR/kill-switch.json, so every process sharing it sees it. */
  dataDir?: string;
  /** Clock in epoch ms (tests inject one). */
  now?: () => number;
}

export interface KillSwitchState {
  engagedAt: string;
  reason: string;
}

export interface RiskStatus {
  mode: "paper" | "live";
  limits: RiskLimits;
  /** Set while the kill switch is engaged: no risk-adding bet is placed. */
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
  /** Why the account figures are missing. */
  error?: string;
}

/** Betfair event types that Australian customers may bet on in-play online (racing, not sport). */
const RACING_EVENT_TYPES = new Set(["7", "4339"]);
/** Money comparisons: well below a cent, well above float noise. */
const EPS = 1e-6;
/** An UNKNOWN order (timed out, not found yet) counts as open for this long unless it shows up among the current orders. */
const UNCONFIRMED_MS = 10 * 60_000;

const keyOf = (order: { selectionId: number; handicap: number }) => formatSelectionId(order.selectionId, order.handicap);

/** An order view as the exposure model sees it: one fill at the average matched price plus the unmatched remainder. */
function legOfView(o: OrderView): ExposureLeg {
  const fills = o.sizeMatched > 0 && o.averagePriceMatched ? [{ price: o.averagePriceMatched, size: o.sizeMatched }] : [];
  return { key: o.selectionId, side: o.side, price: o.price, remaining: o.sizeRemaining, fills };
}

/** A new order as the exposure model sees it: nothing matched yet (it may all match). */
function legOfOrder(o: OrderRequest): ExposureLeg {
  return { key: keyOf(o), side: o.side, price: o.price, remaining: o.size, fills: [] };
}

function refused(order: OrderRequest, errorCode: string): PlacedBet {
  return { selectionId: keyOf(order), side: order.side, price: order.price, size: order.size, status: "FAILURE", errorCode };
}

const money = (value: number) => (round(value, 2) ?? 0).toFixed(2);

/** Offset of `timeZone` from UTC at `ms`, in ms (local wall clock minus UTC). */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of the latest local midnight in `timeZone` at or before `now`. */
export function startOfDay(now: number, timeZone: string): number {
  const local = new Date(now + zoneOffset(now, timeZone));
  const midnightWall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // The offset at midnight can differ from the one now (a daylight-saving change in between).
  let start = midnightWall - zoneOffset(now, timeZone);
  start = midnightWall - zoneOffset(start, timeZone);
  return start > now ? start - 86400_000 : start;
}

/** Kill switch flag: a file in DATA_DIR (shared by every process using it), otherwise memory. */
class KillSwitchStore {
  private memory?: KillSwitchState;

  constructor(readonly file?: string) {}

  get(): KillSwitchState | undefined {
    if (!this.file) return this.memory;
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return { engagedAt: "", reason: `the kill switch file could not be read (${(error as Error).message}), so it counts as engaged` };
    }
    try {
      const parsed = JSON.parse(text) as Partial<KillSwitchState>;
      return { engagedAt: String(parsed.engagedAt ?? ""), reason: String(parsed.reason ?? "engaged") };
    } catch {
      // Fail safe: a damaged file still means "stop".
      return { engagedAt: "", reason: "the kill switch file is damaged, so it counts as engaged" };
    }
  }

  engage(state: KillSwitchState): KillSwitchState {
    const current = this.get();
    if (current) return current; // keep the first reason and time
    if (!this.file) {
      this.memory = state;
      return state;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return state;
  }

  /** How the account holder releases it (deliberately not something a tool can do). */
  releaseHint(): string {
    return this.file ? `delete ${this.file}` : "restart the connector (without DATA_DIR the kill switch lives in memory)";
  }
}

interface MarketRisk {
  book: MarketBook;
  catalogue?: MarketCatalogue;
  legs: ExposureLeg[];
  /** Undefined when outcomes are not mutually exclusive winners (handicap/line markets): selections count independently. */
  winners?: number;
  active: string[];
}

interface AccountRisk {
  /** Worst-case loss of everything open (before this batch). */
  exposure: number;
  /** Today's net settled result (negative: a loss). */
  settledToday: number;
}

/** Exchange decorator that enforces the account's risk limits on every order. */
export class GuardedExchange implements Exchange {
  readonly mode: "paper" | "live";
  private readonly killSwitchStore: KillSwitchStore;
  private queue: Promise<unknown> = Promise.resolve();
  /** Orders whose outcome came back UNKNOWN: counted as open until found or expired. */
  private unconfirmed: Array<{ marketId: string; leg: ExposureLeg; ref?: string; until: number }> = [];

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

  /** Engage the kill switch (idempotent: an engaged switch keeps its first reason and time). */
  engageKillSwitch(reason: string): KillSwitchState {
    return this.killSwitchStore.engage({ engagedAt: new Date(this.now()).toISOString(), reason: reason.trim() || "engaged" });
  }

  killSwitchReleaseHint(): string {
    return this.killSwitchStore.releaseHint();
  }

  // ---------------------------------------------------------------- placing

  /** Placements are serialised: two requests checked at the same time could each fit a limit that both together break. */
  placeOrders(marketId: string, orders: OrderRequest[], strategy: StrategyTag): Promise<PlacedBet[]> {
    const run = () => this.guardedPlace(marketId, orders, strategy);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async guardedPlace(marketId: string, orders: OrderRequest[], strategy: StrategyTag): Promise<PlacedBet[]> {
    if (!orders.length) return [];
    const results: Array<PlacedBet | undefined> = new Array(orders.length);
    const send: number[] = [];
    const warnings = new Map<number, string>();

    let market: MarketRisk | undefined;
    let marketError: string | undefined;
    try {
      market = await this.marketRisk(marketId);
    } catch (error) {
      marketError = (error as Error).message;
    }

    if (!market) {
      // Without the positions no bet can be shown not to add risk: only bets the caller flagged as
      // closing are sent (Betfair still checks them); everything else is refused.
      orders.forEach((order, i) => {
        if (order.reducesRisk) send.push(i);
        else results[i] = refused(order, `RISK_CHECK_FAILED: could not read the market or its orders (${marketError}); nothing that adds risk was sent.`);
      });
    } else {
      const sportInPlay = this.options.jurisdiction === "au" && Boolean(market.book.inplay) && Boolean(market.catalogue) && !RACING_EVENT_TYPES.has(market.catalogue?.eventType?.id ?? "");
      const delayed = Boolean(market.book.isMarketDataDelayed);
      const before = marketExposure(market.legs, market.winners, market.active);
      let legs = market.legs;
      let exposure = before;
      let account: AccountRisk | undefined;
      let accountError: string | undefined;
      const accountRisk = async (): Promise<AccountRisk | undefined> => {
        if (!account && !accountError) {
          try {
            account = await this.accountRisk();
          } catch (error) {
            accountError = (error as Error).message;
          }
        }
        return account;
      };
      const kill = this.killSwitch();

      for (const [i, order] of orders.entries()) {
        if (sportInPlay) {
          results[i] = refused(
            order,
            "IN_PLAY_SPORT_NOT_ALLOWED: Australian customers can't bet in-play on sport online, including through the API (Betfair only takes those bets by phone). Close sport positions before the off.",
          );
          continue;
        }
        const leg = legOfOrder(order);
        const after = marketExposure([...legs, leg], market.winners, market.active);
        if (after > exposure + EPS) {
          const problem = await this.addedRiskProblem(order, { kill, delayed, before, after }, accountRisk, () => accountError);
          if (problem) {
            results[i] = refused(order, problem);
            continue;
          }
        }
        send.push(i);
        legs = [...legs, leg];
        exposure = Math.max(exposure, after);
        if (delayed && this.mode === "paper") {
          warnings.set(
            i,
            "Delayed data: Betfair is sending this market's prices late (up to 3 minutes on a delayed app key) and without traded volume, so this paper result doesn't show what a live bet would have done.",
          );
        }
      }
    }

    if (send.length) {
      const batch = send.map((i) => orders[i]);
      let placed: PlacedBet[];
      try {
        placed = await this.inner.placeOrders(marketId, batch, strategy);
      } catch (error) {
        // Nothing was refused here: keep the exchange's own contract (the caller decides what a throw means).
        if (send.length === orders.length) throw error;
        placed = batch.map((order) => ({
          selectionId: keyOf(order),
          side: order.side,
          price: order.price,
          size: order.size,
          status: "UNKNOWN" as const,
          errorCode: `REQUEST_FAILED: ${(error as Error).message}; check get_current_orders before retrying`,
          customerOrderRef: order.customerOrderRef,
        }));
      }
      send.forEach((i, k) => {
        const bet = placed[k];
        if (!bet) return;
        const warning = warnings.get(i);
        results[i] = warning ? { ...bet, warning } : bet;
        if (bet.status === "UNKNOWN") {
          this.unconfirmed.push({ marketId, leg: legOfOrder(orders[i]), ref: bet.customerOrderRef ?? orders[i].customerOrderRef, until: this.now() + UNCONFIRMED_MS });
        }
      });
    }

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

  /** Why a bet that adds risk may not be placed (undefined: it may). Checked in order of how absolute the rule is. */
  private async addedRiskProblem(
    order: OrderRequest,
    risk: { kill?: KillSwitchState; delayed: boolean; before: number; after: number },
    accountRisk: () => Promise<AccountRisk | undefined>,
    accountError: () => string | undefined,
  ): Promise<string | undefined> {
    const limits = this.options.limits;
    const flagged = order.reducesRisk ? " (it was sent as a closing bet, but it would add risk, so it is checked as a new bet)" : "";
    if (risk.kill) {
      return `KILL_SWITCH_ENGAGED: no new risk${risk.kill.engagedAt ? ` since ${risk.kill.engagedAt}` : ""} (${risk.kill.reason}). Closing bets still go through. Only the account holder can release it: ${this.killSwitchReleaseHint()}.${flagged}`;
    }
    if (risk.delayed && this.mode === "live") {
      return `DELAYED_DATA: Betfair is sending this market's prices with a delay (a delayed app key, an unfunded account or a throttled live key), so no real-money bet that adds risk is placed on it.${flagged}`;
    }
    if (order.side === "BACK" && order.size > limits.maxStake + EPS) return `MAX_STAKE: stake ${money(order.size)} exceeds MAX_STAKE ${limits.maxStake}.${flagged}`;
    const betRisk = liability(order.side, order.price, order.size);
    if (betRisk > limits.maxLiability + EPS) return `MAX_LIABILITY: liability ${money(betRisk)} exceeds MAX_LIABILITY ${limits.maxLiability}.${flagged}`;
    if (risk.after > limits.maxMarketLiability + EPS) {
      return `MAX_MARKET_LIABILITY: this would take the market's worst-case loss from ${money(risk.before)} to ${money(risk.after)}, above MAX_MARKET_LIABILITY ${limits.maxMarketLiability}.${flagged}`;
    }
    const account = await accountRisk();
    if (!account) return `RISK_CHECK_FAILED: could not read the account's exposure or today's results (${accountError()}); nothing that adds risk was sent.`;
    const total = account.exposure + (risk.after - risk.before);
    if (total > limits.maxTotalExposure + EPS) {
      return `MAX_TOTAL_EXPOSURE: open worst-case loss would be ${money(total)}, above MAX_TOTAL_EXPOSURE ${limits.maxTotalExposure}.${flagged}`;
    }
    const lossToday = Math.max(0, -account.settledToday);
    if (lossToday >= limits.dailyLossLimit - EPS) {
      return `DAILY_LOSS_LIMIT: today's settled loss ${money(lossToday)} has reached DAILY_LOSS_LIMIT ${limits.dailyLossLimit}; no new risk until midnight (${this.options.timeZone}).${flagged}`;
    }
    if (lossToday + total > limits.dailyLossLimit + EPS) {
      return (
        `DAILY_LOSS_LIMIT: today's settled loss ${money(lossToday)} plus an open worst case of ${money(total)} would exceed DAILY_LOSS_LIMIT ${limits.dailyLossLimit} ` +
        `(${money(Math.max(0, limits.dailyLossLimit - lossToday - account.exposure))} of new risk is left today).${flagged}`
      );
    }
    return undefined;
  }

  /** The market's book, catalogue and current orders (plus unconfirmed ones) for the exposure model. */
  private async marketRisk(marketId: string): Promise<MarketRisk> {
    const book = await this.markets.getBook(marketId, { depth: 1 });
    let catalogue: MarketCatalogue | undefined;
    try {
      catalogue = await this.markets.getCatalogue(marketId);
    } catch {
      catalogue = this.markets.cachedCatalogue(marketId);
    }
    const orders = (await this.inner.currentOrders([marketId])).filter((o) => o.marketId === marketId);
    const legs = orders.map(legOfView);
    const refs = new Set(orders.map((o) => o.customerOrderRef).filter(Boolean));
    const now = this.now();
    this.unconfirmed = this.unconfirmed.filter((u) => u.until > now && !(u.ref && refs.has(u.ref)));
    legs.push(...this.unconfirmed.filter((u) => u.marketId === marketId).map((u) => u.leg));
    const bettingType = catalogue?.description?.bettingType;
    const handicap = legs.some((l) => l.key.includes("_")) || (bettingType !== undefined && bettingType !== "ODDS");
    return {
      book,
      catalogue,
      legs,
      winners: handicap ? undefined : book.numberOfWinners,
      active: book.runners.filter((r) => r.status === "ACTIVE").map((r) => keyOf(r)),
    };
  }

  /** Open exposure (before any new bet) and today's settled result. */
  private async accountRisk(): Promise<AccountRisk> {
    // Never cached: a market settling between two bets moves money from "open" to "settled today".
    const [funds, settled] = await Promise.all([this.inner.accountFunds(), this.inner.settledBets(new Date(startOfDay(this.now(), this.options.timeZone)))]);
    const gross = settled.bets.reduce((total, b) => total + (Number(b.profit) || 0), 0);
    return { exposure: Math.abs(Number(funds.exposure) || 0), settledToday: gross - (settled.commission ?? 0) };
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
      limits: { ...pickLimits(this.options.limits) },
      killSwitch: kill ? { ...kill, release: `only the account holder can release it: ${this.killSwitchReleaseHint()}` } : undefined,
      dayStartedAt: new Date(dayStart).toISOString(),
    };
    try {
      const account = await this.accountRisk();
      const lossToday = Math.max(0, -account.settledToday);
      status.settledToday = round(account.settledToday, 2);
      status.openExposure = round(account.exposure, 2);
      status.headroom = round(
        Math.max(0, Math.min(this.options.limits.maxTotalExposure - account.exposure, this.options.limits.dailyLossLimit - lossToday - account.exposure)),
        2,
      );
      status.dailyLimitHit = lossToday >= this.options.limits.dailyLossLimit - EPS;
    } catch (error) {
      status.error = (error as Error).message;
    }
    return status;
  }

  /** Today's settled losses have reached DAILY_LOSS_LIMIT. */
  async dailyLimitHit(): Promise<boolean> {
    const account = await this.accountRisk();
    return Math.max(0, -account.settledToday) >= this.options.limits.dailyLossLimit - EPS;
  }

  /** Cancel every unmatched bet on the account (kill switch). */
  async cancelAllUnmatched(): Promise<CancelResult[]> {
    const orders = await this.inner.currentOrders();
    const markets = [...new Set(orders.filter((o) => o.sizeRemaining > 0).map((o) => o.marketId))];
    const results: CancelResult[] = [];
    for (const marketId of markets) results.push(...(await this.inner.cancelOrders(marketId, "ALL")));
    return results;
  }

  /**
   * Cancel unmatched bets that would add risk if they matched (entries, over-hedges) and keep the
   * ones that would reduce it (resting closing bets), judged on each selection's matched position.
   */
  async cancelRiskAddingUnmatched(): Promise<CancelResult[]> {
    const orders = await this.inner.currentOrders();
    const byMarket = new Map<string, string[]>();
    for (const o of orders) {
      if (o.sizeRemaining <= 0) continue;
      const matched = positionOf(orders.filter((x) => x.marketId === o.marketId && x.selectionId === o.selectionId));
      const ifMatched = addBet(matched, o.side, o.price, o.sizeRemaining);
      if (worstCase(ifMatched) < worstCase(matched) - EPS) byMarket.set(o.marketId, [...(byMarket.get(o.marketId) ?? []), o.betId]);
    }
    const results: CancelResult[] = [];
    for (const [marketId, betIds] of byMarket) results.push(...(await this.inner.cancelOrders(marketId, betIds)));
    return results;
  }
}

function pickLimits(limits: RiskLimits): RiskLimits {
  const { maxStake, maxLiability, maxMarketLiability, maxTotalExposure, dailyLossLimit } = limits;
  return { maxStake, maxLiability, maxMarketLiability, maxTotalExposure, dailyLossLimit };
}
