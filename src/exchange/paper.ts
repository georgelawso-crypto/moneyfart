import { betSizeProblem, type CurrencyRules } from "../betfair/currency.js";
import { isValidPrice, type LadderType } from "../betfair/ticks.js";
import type { MarketBook, MarketCatalogue, PriceSize, Runner, Side } from "../betfair/types.js";
import { assertMarketId, formatSelectionId, round, sameSelection, type SelectionRef } from "../format.js";
import type { MarketService } from "../markets.js";
import type { State } from "../state.js";
import { betOutcomeProfit } from "./math.js";
import type { PaperMarketState, PaperOrder, PaperSelectionLiquidity } from "./paperTypes.js";
import type { CancelResult, Exchange, FundsView, OrderRequest, OrderView, PlacedBet, SettledBets, SettledBetView, StrategyTag } from "./types.js";

export interface PaperOptions {
  startingBalance: number;
  commissionRate: number;
  currency: CurrencyRules;
  /** Waits out the in-play bet delay (default: a real timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in epoch ms for bet ids, fills and settlement times (default Date.now). */
  now?: () => number;
}

/** Price levels fetched for placement: immediate matching walks the opposite ladder. */
const PLACE_DEPTH = 10;
/** A market with open paper orders that Betfair no longer returns is voided this long after its start. */
const VANISHED_AFTER_MS = 24 * 3600_000;
const EPS = 1e-9;

/** Engine state kept on each order. */
type OrderMeta = {
  /** Money displayed ahead of the resting remainder in its own queue (null: beyond the depth seen). */
  queue?: number | null;
  /** Removed selections already applied to this order. */
  removals?: string[];
  note?: string;
};

/** "B": availableToBack (lay offers, taken by BACK orders); "L": availableToLay (back offers, taken by LAY orders). */
type Ladder = "B" | "L";

// ------------------------------------------------------------------ order arithmetic

/** Stakes, fills and traded volumes are whole pennies on Betfair: snap the float noise of their sums. */
const pennies = (value: number) => Math.round(value * 100) / 100;

const meta = (o: PaperOrder) => (o.meta ??= {}) as OrderMeta;
const keyOf = (ref: SelectionRef) => formatSelectionId(ref.selectionId, ref.handicap);

export function sizeMatched(o: PaperOrder): number {
  return pennies(o.fills.reduce((total, f) => total + f.size, 0));
}

export function sizeRemaining(o: PaperOrder): number {
  return Math.max(0, pennies(o.size - sizeMatched(o) - o.sizeCancelled - o.sizeLapsed));
}

/** Size-weighted average of the fills (unrounded; undefined when nothing matched). */
export function averagePrice(o: PaperOrder): number | undefined {
  let size = 0;
  let value = 0;
  for (const f of o.fills) {
    size += f.size;
    value += f.size * f.price;
  }
  return size > 0 ? value / size : undefined;
}

/** Unsettled and still carrying a position or an unmatched remainder. */
function isLive(o: PaperOrder): boolean {
  return !o.settlement && (sizeRemaining(o) > 0 || sizeMatched(o) > 0);
}

function addFill(o: PaperOrder, price: number, size: number, at: string) {
  if (size <= 0) return;
  const last = o.fills[o.fills.length - 1];
  if (last && last.at === at && last.price === price && last.originalPrice === undefined) last.size = pennies(last.size + size);
  else o.fills.push({ price, size: pennies(size), at });
}

function findRunner(book: MarketBook, ref: SelectionRef): Runner | undefined {
  return book.runners.find((r) => sameSelection(r, ref));
}

const activeKeys = (book: MarketBook) => book.runners.filter((r) => r.status === "ACTIVE").map(keyOf);
const isRemoved = (r: Runner) => r.status === "REMOVED" || r.status === "REMOVED_VACANT";

// ------------------------------------------------------------------ exposure

/** An order as seen by the exposure model: matched fills plus an unmatched remainder at its limit price. */
export interface ExposureLeg {
  /** Formatted selection id. */
  key: string;
  side: Side;
  price: number;
  remaining: number;
  fills: Array<{ price: number; size: number }>;
}

function legOf(o: PaperOrder): ExposureLeg {
  return { key: keyOf(o), side: o.side, price: o.price, remaining: sizeRemaining(o), fills: o.fills };
}

/** Profit of a leg in one scenario; an unmatched remainder can only make it worse (Betfair's rule). */
function legProfit(leg: ExposureLeg, wins: boolean): number {
  let profit = 0;
  for (const f of leg.fills) profit += betOutcomeProfit(leg.side, f.price, f.size, wins);
  if (leg.remaining > 0) profit += Math.min(0, betOutcomeProfit(leg.side, leg.price, leg.remaining, wins));
  return profit;
}

/**
 * Worst-case loss of one market. Single-winner markets enumerate "selection X wins" for every
 * selection with a position, plus "a runner without a position wins" when the field is not
 * fully covered (or unknown). Multi-winner and unknown markets treat selections independently.
 */
export function marketExposure(legs: ExposureLeg[], numberOfWinners?: number, activeRunners?: string[]): number {
  const positions = legs.filter((l) => l.remaining > 0 || l.fills.length > 0);
  if (!positions.length) return 0;
  const selections = [...new Set(positions.map((l) => l.key))];
  if (numberOfWinners === 1) {
    const uncovered = !activeRunners?.length || activeRunners.some((k) => !selections.includes(k));
    const winners: Array<string | null> = uncovered ? [...selections, null] : selections;
    const scenarios = winners.map((winner) => positions.reduce((total, l) => total + legProfit(l, l.key === winner), 0));
    return Math.max(0, -Math.min(...scenarios));
  }
  let exposure = 0;
  for (const key of selections) {
    const mine = positions.filter((l) => l.key === key);
    const ifWin = mine.reduce((total, l) => total + legProfit(l, true), 0);
    const ifLose = mine.reduce((total, l) => total + legProfit(l, false), 0);
    exposure += Math.max(0, -Math.min(ifWin, ifLose));
  }
  return exposure;
}

// ------------------------------------------------------------------ ladders and liquidity

const takes = (side: Side): Ladder => (side === "BACK" ? "B" : "L");
const restsIn = (side: Side): Ladder => (side === "BACK" ? "L" : "B");
const priceKey = (price: number) => price.toFixed(2);
const levelKey = (ladder: Ladder, price: number) => `${ladder}:${priceKey(price)}`;

function ladderOf(runner: Runner, ladder: Ladder): PriceSize[] | undefined {
  return ladder === "B" ? runner.ex?.availableToBack : runner.ex?.availableToLay;
}

/** True when `price` is at least as good as `limit` for an order taking this ladder (BACK >= limit, LAY <= limit). */
function acceptable(ladder: Ladder, price: number, limit: number): boolean {
  return ladder === "B" ? price >= limit - EPS : price <= limit + EPS;
}

/**
 * Displayed size at a price: the level's size, 0 when the shown ladder proves the level is
 * empty (the price lies within or better than the shown range), undefined beyond its depth.
 */
function shownAt(levels: PriceSize[] | undefined, ladder: Ladder, price: number): number | undefined {
  if (!levels) return undefined;
  const hit = levels.find((l) => Math.abs(l.price - price) < EPS);
  if (hit) return hit.size;
  if (!levels.length) return 0;
  const prices = levels.map((l) => l.price);
  return (ladder === "B" ? price > Math.min(...prices) : price < Math.max(...prices)) ? 0 : undefined;
}

/**
 * Take displayed liquidity this engine has not consumed yet, best price first, never worse than
 * `limit`. The taken size is remembered per level, so neither a later order in the same batch nor
 * a later call (or a later book showing the same money) can match it again.
 */
function takeLiquidity(sel: PaperSelectionLiquidity, runner: Runner, side: Side, limit: number, size: number): PriceSize[] {
  const ladder = takes(side);
  const levels = [...(ladderOf(runner, ladder) ?? [])].sort((a, b) => (ladder === "B" ? b.price - a.price : a.price - b.price));
  const taken: PriceSize[] = [];
  let left = size;
  for (const level of levels) {
    if (left <= 0 || !acceptable(ladder, level.price, limit)) break;
    const key = levelKey(ladder, level.price);
    const use = sel.levels[key] ?? { used: 0, credit: 0 };
    const x = pennies(Math.min(left, level.size - use.used));
    if (x <= 0) continue;
    use.used = pennies(use.used + x);
    use.credit = pennies(use.credit + x);
    sel.levels[key] = use;
    taken.push({ price: level.price, size: x });
    left = pennies(left - x);
  }
  return taken;
}

/**
 * Traded volume that appeared since the last book, per price. Growth at a price first absorbs
 * liquidity this engine already took there (other bettors trading money that, in the paper
 * world, is gone); only the rest is evidence for resting orders. Books without traded volume
 * (e.g. delayed application keys) are ignored rather than read as zero.
 */
function tradedGrowth(sel: PaperSelectionLiquidity, runner: Runner): Map<string, number> {
  const fresh = new Map<string, number>();
  const volume = runner.ex?.tradedVolume;
  if (!volume) return fresh;
  const baseline = !sel.traded;
  const traded = (sel.traded ??= {});
  for (const level of volume) {
    const key = priceKey(level.price);
    const seen = traded[key] ?? 0;
    let growth = baseline ? 0 : pennies(level.size - seen);
    // Cumulative volume only grows; an older book processed late must not lower the baseline.
    traded[key] = Math.max(seen, level.size);
    for (const ladder of ["B", "L"] as const) {
      const use = sel.levels[`${ladder}:${key}`];
      if (growth <= 0 || !use?.credit) continue;
      const absorbed = Math.min(growth, use.credit);
      use.credit = pennies(use.credit - absorbed);
      growth = pennies(growth - absorbed);
    }
    if (growth > 0) fresh.set(key, growth);
  }
  return fresh;
}

/**
 * Reconcile consumed levels with a new OPEN book: consumption never exceeds what is still shown
 * (the rest was traded or cancelled by others), and is forgotten once the level is gone.
 */
function syncLevels(sel: PaperSelectionLiquidity, runner: Runner) {
  for (const [key, use] of Object.entries(sel.levels)) {
    const ladder = key[0] as Ladder;
    const shown = shownAt(ladderOf(runner, ladder), ladder, Number(key.slice(2)));
    if (shown === undefined) continue;
    if (shown <= 0) {
      delete sel.levels[key];
      continue;
    }
    use.used = Math.min(use.used, shown);
    use.credit = Math.min(use.credit, use.used);
  }
}

// ------------------------------------------------------------------ validation

function failure(req: OrderRequest, errorCode: string): PlacedBet {
  return { selectionId: formatSelectionId(req.selectionId, req.handicap), side: req.side, price: req.price, size: req.size, status: "FAILURE", errorCode };
}

function marketProblem(book: MarketBook): string | undefined {
  if (book.status === "SUSPENDED") return "MARKET_SUSPENDED";
  if (book.status !== "OPEN") return "MARKET_NOT_OPEN_FOR_BETTING";
  // Paper fills against delayed in-play prices would be fiction.
  if (book.isMarketDataDelayed && book.inplay) return "DELAYED_DATA_IN_PLAY";
  return undefined;
}

function marketTypeProblem(catalogue: MarketCatalogue): string | undefined {
  const d = catalogue.description;
  // Each-way terms (place leg at (price-1)/divisor, two stakes) are not modelled by paper settlement.
  if (d?.marketType === "EACH_WAY") return "EACH_WAY_NOT_SUPPORTED";
  // Line markets quote a line, not odds: paper profit maths would be meaningless.
  if (d?.bettingType === "LINE" || d?.priceLadderDescription?.type === "LINE_RANGE") return "LINE_MARKET_NOT_SUPPORTED";
  return undefined;
}

function runnerProblem(book: MarketBook, req: OrderRequest): string | undefined {
  const runner = findRunner(book, req);
  if (!runner) return "INVALID_RUNNER";
  return runner.status === "ACTIVE" ? undefined : "RUNNER_REMOVED";
}

const ladderType = (catalogue: MarketCatalogue): LadderType =>
  catalogue.description?.priceLadderDescription?.type === "FINEST" ? "FINEST" : "CLASSIC";

// ------------------------------------------------------------------ settlement

/**
 * Betfair's dead-heat rule (Betfair Exchange Rules and Regulations, General Rules, "Dead Heats"):
 * when more runners are returned WINNER than the market has winning places, the stake on each of
 * them is divided. With n places and k winners, n/k of the stake is settled as a winner and the
 * rest as a loser: a back of S at P returns S x (P - 1) x n/k - S x (1 - n/k), a lay the opposite.
 * Exact when one place is shared. With several places Betfair divides only the stakes on the
 * runners tied for the last place, which the results do not identify, so every winner takes the
 * average share (an approximation). Runner.adjustmentFactor is not a dead-heat term: Betfair
 * publishes it on every horse as the reduction factor its removal would cause.
 */
function deadHeatOf(book: MarketBook, knownPlaces?: number): { share: number; note: string } | undefined {
  const places = book.numberOfWinners ?? knownPlaces;
  // Several WINNER lines are normal in handicap markets.
  if (!places || places < 1 || book.runners.some((r) => r.handicap)) return undefined;
  const winners = book.runners.filter((r) => r.status === "WINNER").length;
  if (winners <= places) return undefined;
  const approximation = places > 1 ? " Betfair divides only the stakes on the runners tied for the last place, which the results do not name: this is an approximation." : "";
  return {
    share: places / winners,
    note: `Dead heat: ${winners} winners for ${places} place(s); ${places}/${winners} of the stake was settled as a winner, the rest as a loser.${approximation}`,
  };
}

// ------------------------------------------------------------------ exchange

/**
 * Practice-mode exchange on the real Betfair order book. Orders match immediately against
 * displayed liquidity (depleted by everything this engine already took); the remainder rests
 * and fills only on evidence: the book crossing its price, or traded volume at the price beyond
 * the queue ahead of it, or through the price. Markets settle from Betfair's runner statuses,
 * including non-runners (void + reduction factors) and dead heats, with commission on net market
 * winnings at the market's base rate.
 */
export class PaperExchange implements Exchange {
  readonly mode = "paper" as const;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    protected readonly markets: MarketService,
    protected readonly state: State,
    protected readonly options: PaperOptions,
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    markets.onBook((book) => this.onBook(book));
  }

  async currencyRules(): Promise<CurrencyRules> {
    return this.options.currency;
  }

  // ---------------------------------------------------------------- placing

  async placeOrders(marketId: string, orders: OrderRequest[], strategy: StrategyTag): Promise<PlacedBet[]> {
    const id = assertMarketId(marketId);
    if (!orders.length) return [];
    let catalogue: MarketCatalogue | undefined;
    let catalogueError: unknown;
    try {
      catalogue = await this.markets.getCatalogue(id);
    } catch (error) {
      catalogueError = error;
    }
    // Fetching the book first applies it to resting orders (fills, lapses) before matching new ones.
    let book = await this.placementBook(id);
    const marketError = marketProblem(book);
    if (marketError) return orders.map((req) => failure(req, marketError));
    if (!catalogue) throw catalogueError;
    const market = catalogue;
    const typeError = marketTypeProblem(market);
    if (typeError) return orders.map((req) => failure(req, typeError));
    const problems = orders.map((req) => this.orderProblem(req, book, market));
    if (book.inplay && (book.betDelay ?? 0) > 0 && problems.some((p) => !p)) {
      // Betfair holds in-play bets for the bet delay, then matches them against the book at that moment.
      await this.sleep(book.betDelay! * 1000);
      book = await this.placementBook(id);
    }
    // From here on no awaits: the batch matches atomically against one book, depleting it as it goes.
    const placedAt = this.isoNow();
    return orders.map((req, i) => {
      const problem = problems[i] ?? marketProblem(book) ?? runnerProblem(book, req);
      if (problem) return failure(req, problem);
      if (this.wouldOverdraw(book, req)) return failure(req, "INSUFFICIENT_FUNDS");
      return this.execute(req, book, market, strategy, placedAt);
    });
  }

  /**
   * The book new orders match against. A response older than one already processed (answered
   * late, or by a lagging server) would match vanished offers and date earlier trades after the
   * order, so it is requested once more.
   */
  private async placementBook(marketId: string): Promise<MarketBook> {
    const book = await this.markets.getBook(marketId, { depth: PLACE_DEPTH });
    return this.markets.isStale(book) ? this.markets.getBook(marketId, { depth: PLACE_DEPTH }) : book;
  }

  private orderProblem(req: OrderRequest, book: MarketBook, catalogue: MarketCatalogue): string | undefined {
    if (req.persistenceType === "MARKET_ON_CLOSE") return "MARKET_ON_CLOSE_NOT_SUPPORTED"; // no BSP conversion in paper mode
    if (req.persistenceType !== "LAPSE" && req.persistenceType !== "PERSIST") return "INVALID_PERSISTENCE_TYPE";
    if (req.persistenceType === "PERSIST" && catalogue.description?.persistenceEnabled === false) return "INVALID_PERSISTENCE_TYPE";
    const runner = runnerProblem(book, req);
    if (runner) return runner;
    if (!isValidPrice(req.price, ladderType(catalogue))) return "INVALID_ODDS";
    // Stakes are whole pennies, at least the currency minimum unless the payout reaches the minimum payout.
    if (!(req.size > 0) || Math.abs(req.size * 100 - Math.round(req.size * 100)) > 1e-6) return "INVALID_BET_SIZE";
    if (betSizeProblem(req.size, req.price, this.options.currency)) return "INVALID_BET_SIZE";
    return undefined;
  }

  /** Funds check on the pro-forma book (new order unmatched): refuse only orders that both overdraw and add exposure. */
  private wouldOverdraw(book: MarketBook, req: OrderRequest): boolean {
    const orders = this.liveOrders(book.marketId);
    const before = this.marketExposureOf(book.marketId, orders, book);
    const after = this.marketExposureOf(book.marketId, orders, book, { key: keyOf(req), side: req.side, price: req.price, remaining: req.size, fills: [] });
    if (after <= before + EPS) return false;
    return pennies(this.balance() - (this.exposure() - before + after)) < 0;
  }

  private execute(req: OrderRequest, book: MarketBook, catalogue: MarketCatalogue, strategy: StrategyTag, placedAt: string): PlacedBet {
    const runner = findRunner(book, req)!;
    const key = keyOf(req);
    const market = this.market(book.marketId);
    market.numberOfWinners = book.numberOfWinners ?? market.numberOfWinners;
    market.activeRunners = activeKeys(book);
    const sel = (market.selections[key] ??= { levels: {} });
    // Baseline for a selection without live orders: only trades after this book are evidence for the new order.
    if (!sel.traded) tradedGrowth(sel, runner);
    // Removals the book already shows happened before this order: they must never lapse or reduce it,
    // whatever removalDate says (it can be missing, or ahead of our clock).
    const removals = book.runners.filter(isRemoved).map(keyOf);
    const order: PaperOrder = {
      betId: this.nextBetId(),
      marketId: book.marketId,
      selectionId: req.selectionId,
      handicap: req.handicap,
      side: req.side,
      price: req.price,
      size: req.size,
      fills: [],
      sizeCancelled: 0,
      sizeLapsed: 0,
      sizeVoided: 0,
      persistenceType: req.persistenceType,
      placedDate: placedAt,
      placedInPlay: Boolean(book.inplay),
      strategyName: strategy.name,
      strategyRef: strategy.ref,
      customerOrderRef: req.customerOrderRef,
      marketName: catalogue.marketName,
      eventName: catalogue.event?.name,
      eventType: catalogue.eventType?.name,
      marketStartTime: catalogue.marketStartTime ?? catalogue.description?.marketTime,
      selectionName: catalogue.runners?.find((r) => sameSelection(r, req))?.runnerName,
      marketType: catalogue.description?.marketType,
      eachWayDivisor: catalogue.description?.eachWayDivisor,
      numberOfWinners: book.numberOfWinners,
      // Kept on the order: Betfair no longer returns the catalogue once the market has closed.
      marketBaseRate: catalogue.description?.marketBaseRate,
      bookVersion: book.version,
      meta: removals.length ? { removals } : {},
    };
    for (const fill of takeLiquidity(sel, runner, req.side, req.price, req.size)) addFill(order, fill.price, fill.size, placedAt);
    if (sizeRemaining(order) > 0) {
      const own = restsIn(req.side);
      meta(order).queue = shownAt(ladderOf(runner, own), own, req.price) ?? null;
    }
    this.state.paper.orders.push(order);
    this.state.changed();
    const remaining = sizeRemaining(order);
    return {
      selectionId: key,
      side: req.side,
      price: req.price,
      size: req.size,
      status: "SUCCESS",
      betId: order.betId,
      sizeMatched: sizeMatched(order),
      averagePriceMatched: averagePrice(order),
      orderStatus: remaining > 0 ? "EXECUTABLE" : "EXECUTION_COMPLETE",
    };
  }

  /** Unique across restarts: persisted counter behind a fixed-width time prefix. */
  private nextBetId(): string {
    this.state.paper.betCounter += 1;
    return `P${Math.floor(this.now()).toString(36).padStart(9, "0")}${this.state.paper.betCounter}`;
  }

  // ---------------------------------------------------------------- cancelling and reading

  async cancelOrders(marketId: string, betIds: string[] | "ALL"): Promise<CancelResult[]> {
    const id = assertMarketId(marketId);
    if (betIds !== "ALL" && !betIds.length) return [];
    try {
      await this.refresh([id]); // apply fills the market already gave before cancelling
    } catch {
      // Cancel against the last known state rather than not at all.
    }
    const results: CancelResult[] = [];
    const cancel = (o: PaperOrder, remaining: number) => {
      o.sizeCancelled = pennies(o.sizeCancelled + remaining);
      results.push({ betId: o.betId, sizeCancelled: remaining, status: "SUCCESS" });
    };
    if (betIds === "ALL") {
      for (const o of this.unsettled(id)) {
        const remaining = sizeRemaining(o);
        if (remaining > 0) cancel(o, remaining);
      }
    } else {
      for (const betId of betIds) {
        const o = this.state.paper.orders.find((x) => x.betId === betId && x.marketId === id);
        const remaining = o && !o.settlement ? sizeRemaining(o) : 0;
        if (!o) results.push({ betId, sizeCancelled: 0, status: "INVALID_BET_ID" });
        else if (remaining <= 0) results.push({ betId, sizeCancelled: 0, status: "BET_TAKEN_OR_LAPSED" });
        else cancel(o, remaining);
      }
    }
    if (results.some((r) => r.status === "SUCCESS")) {
      this.prune(id);
      this.state.changed();
    }
    return results;
  }

  async currentOrders(marketIds?: string[]): Promise<OrderView[]> {
    await this.refresh(marketIds);
    return this.state.paper.orders.filter((o) => isLive(o) && (!marketIds || marketIds.includes(o.marketId))).map(orderView);
  }

  async accountFunds(): Promise<FundsView> {
    await this.refresh();
    const settled = this.settledProfitLoss();
    const balance = this.options.startingBalance + settled;
    const exposure = this.exposure();
    return {
      mode: "paper",
      currency: this.options.currency.currency,
      availableToBetBalance: round(balance - exposure)!,
      exposure: round(exposure)!,
      balance: round(balance)!,
      startingBalance: this.options.startingBalance,
      settledProfitLoss: round(settled)!,
    };
  }

  async settledBets(from: Date, marketIds?: string[]): Promise<SettledBets> {
    await this.refresh(marketIds);
    const fromIso = from.toISOString();
    const bets: SettledBetView[] = this.state.paper.orders
      .filter((o) => o.settlement && o.settlement.outcome !== "VOID" && sizeMatched(o) > 0)
      .filter((o) => o.settlement!.settledDate >= fromIso && (!marketIds || marketIds.includes(o.marketId)))
      .map((o) => ({
        betId: o.betId,
        marketId: o.marketId,
        selectionId: keyOf(o),
        eventType: o.eventType,
        event: o.eventName,
        market: o.marketName,
        selection: o.selectionName,
        marketStartTime: o.marketStartTime,
        side: o.side,
        priceMatched: averagePrice(o),
        sizeSettled: sizeMatched(o),
        outcome: o.settlement!.outcome,
        profit: o.settlement!.profit,
        placedDate: o.placedDate,
        lastMatchedDate: o.fills[o.fills.length - 1]?.at,
        settledDate: o.settlement!.settledDate,
        strategy: o.strategyName,
      }));
    const settledMarkets = new Set(bets.map((b) => b.marketId));
    const commission = this.state.paper.settlements.filter((s) => settledMarkets.has(s.marketId)).reduce((total, s) => total + s.commission, 0);
    return { bets, commission };
  }

  pendingMarketIds(): string[] {
    return [...new Set(this.state.paper.orders.filter(isLive).map((o) => o.marketId))];
  }

  /** Fetch the books of markets with live orders (matching, lapsing, settling them); void markets Betfair no longer returns. */
  async refresh(marketIds?: string[]): Promise<void> {
    const wanted = marketIds ? new Set(marketIds) : undefined;
    const pending = this.pendingMarketIds().filter((id) => !wanted || wanted.has(id));
    if (!pending.length) return;
    const books = await this.markets.getBooks(pending);
    const returned = new Set(books.map((b) => b.marketId));
    const cutoff = this.now() - VANISHED_AFTER_MS;
    for (const id of pending) if (!returned.has(id)) this.voidVanished(id, cutoff);
  }

  // ---------------------------------------------------------------- books

  private onBook(book: MarketBook) {
    const orders = this.unsettled(book.marketId);
    if (!orders.length) return;
    // MarketService drops books older than one it already processed; after a restart it has no
    // history, so a book older than the one an order was placed on is ignored here too.
    const version = book.version;
    if (version !== undefined && orders.some((o) => o.bookVersion !== undefined && version < o.bookVersion)) return;
    const now = this.isoNow();
    const market = this.market(book.marketId);
    market.numberOfWinners = book.numberOfWinners ?? market.numberOfWinners;
    market.activeRunners = activeKeys(book);
    // Volume first seen in a book showing a new non-runner cannot be dated against the removal either
    // (the market may have reopened at reduced prices since): orders cancelled by it get none of it.
    this.applyRemovals(book, orders, now);
    // LAPSE orders placed before the off were cancelled at the off. Volume first seen in an in-play
    // book may have traded before or after it and cannot be dated, so it is not credited to them.
    this.applyLapses(book, orders, "off");
    const fresh = this.trackLiquidity(book, orders);
    // Volume first seen in a SUSPENDED or CLOSED book traded while the market was open and these
    // orders were resting: credit it before anything lapses or settles. Only OPEN offers can cross.
    if (!(book.isMarketDataDelayed && book.inplay)) this.fillResting(book, orders, fresh, now, book.status === "OPEN");
    this.applyLapses(book, orders, "close");
    // Results are final once no runner is ACTIVE (a CLOSED market can still await a photo or stewards).
    if (book.status === "CLOSED" && book.runners.every((r) => r.status !== "ACTIVE")) this.settle(book, now);
    this.prune(book.marketId);
    this.state.changed();
  }

  /**
   * Non-runners: void bets on the removed runner, lapse unmatched bets placed before the removal
   * (Betfair cancels them), and apply the reduction factor to earlier fills on the other runners.
   */
  private applyRemovals(book: MarketBook, orders: PaperOrder[], now: string) {
    for (const runner of book.runners) {
      if (!isRemoved(runner)) continue;
      const removed = keyOf(runner);
      const declared = Date.parse(runner.removalDate ?? "");
      const removedAt = Number.isFinite(declared) ? declared : Date.parse(now);
      const factor = runner.adjustmentFactor ?? 0;
      for (const o of orders) {
        const m = meta(o);
        if (o.settlement || m.removals?.includes(removed)) continue;
        m.removals = [...(m.removals ?? []), removed];
        if (keyOf(o) === removed) {
          this.voidOrder(o, now, `Non-runner: ${o.selectionName ?? removed} was removed.`);
          continue;
        }
        if (Date.parse(o.placedDate) < removedAt) o.sizeLapsed = pennies(o.sizeLapsed + sizeRemaining(o));
        if (factor <= 0) continue;
        for (const f of o.fills) {
          if (Date.parse(f.at) >= removedAt) continue;
          f.originalPrice ??= f.price;
          f.price = Math.max(1.01, f.price * (1 - factor / 100));
        }
      }
    }
  }

  /** At the off, LAPSE orders placed before it lapse; at the close, everything unmatched at CLOSED or on a non-active runner does. */
  private applyLapses(book: MarketBook, orders: PaperOrder[], at: "off" | "close") {
    for (const o of orders) {
      const remaining = sizeRemaining(o);
      if (o.settlement || remaining <= 0) continue;
      const lapses =
        at === "off"
          ? o.persistenceType === "LAPSE" && !o.placedInPlay && Boolean(book.inplay)
          : book.status === "CLOSED" || findRunner(book, o)?.status !== "ACTIVE";
      if (lapses) o.sizeLapsed = pennies(o.sizeLapsed + remaining);
    }
  }

  /** Update traded-volume baselines and consumed levels; returns the fresh traded evidence per selection. */
  private trackLiquidity(book: MarketBook, orders: PaperOrder[]): Map<string, Map<string, number>> {
    const market = this.market(book.marketId);
    const live = new Set(orders.filter(isLive).map(keyOf));
    const fresh = new Map<string, Map<string, number>>();
    for (const runner of book.runners) {
      const key = keyOf(runner);
      if (!live.has(key)) continue;
      const sel = (market.selections[key] ??= { levels: {} });
      fresh.set(key, tradedGrowth(sel, runner));
      // Suspended books often show no offers: keep the consumption until prices are back.
      if (book.status === "OPEN") syncLevels(sel, runner);
    }
    return fresh;
  }

  /**
   * Resting fills, in Betfair's priority (BACK: lowest price first, LAY: highest; then time).
   * Each side draws on its own copy of the traded evidence, so one print never fills two of
   * this engine's orders on the same side; all fills are at the order's own price. Only an OPEN
   * book's ladders are live: other books (SUSPENDED, CLOSED) contribute traded volume alone.
   */
  private fillResting(book: MarketBook, orders: PaperOrder[], fresh: Map<string, Map<string, number>>, now: string, open: boolean) {
    const market = this.market(book.marketId);
    for (const runner of book.runners) {
      const key = keyOf(runner);
      const sel = market.selections[key];
      // A settled WINNER or LOSER still traded until the close; bets on a removed runner are void.
      if (!sel || isRemoved(runner)) continue;
      const live = open && runner.status === "ACTIVE";
      for (const side of ["BACK", "LAY"] as const) {
        const resting = orders
          .filter((o) => !o.settlement && o.side === side && keyOf(o) === key && sizeRemaining(o) > 0)
          .sort((a, b) => (side === "BACK" ? a.price - b.price : b.price - a.price));
        const pool = new Map(fresh.get(key) ?? []);
        for (let i = 0; i < resting.length; ) {
          const group = [resting[i++]];
          while (i < resting.length && Math.abs(resting[i].price - group[0].price) < EPS) group.push(resting[i++]);
          this.fillGroup(group, side, runner, sel, pool, now, live);
        }
      }
    }
  }

  /**
   * Fill orders resting at one price. Each unit of volume traded at the price is used once: it
   * first clears money queued ahead, and only the excess fills these orders.
   */
  private fillGroup(group: PaperOrder[], side: Side, runner: Runner, sel: PaperSelectionLiquidity, pool: Map<string, number>, now: string, live: boolean) {
    const price = group[0].price;
    const own = restsIn(side);
    // The book shows the level after this interval's trades (a suspended book's empty ladder says nothing).
    const shownOwn = live ? shownAt(ladderOf(runner, own), own, price) : undefined;
    const atPrice = pool.get(priceKey(price)) ?? 0;
    // Money ahead before those trades cannot exceed what is still displayed plus what traded at the price.
    const queues = group.map((o) => Math.min(meta(o).queue ?? Infinity, (shownOwn ?? Infinity) + atPrice));
    // Volume traded at the price first clears the shortest queue ahead; the excess may reach these orders.
    let excessPool = Math.max(0, atPrice - Math.min(...queues));
    const through = [...pool.keys()]
      .map(Number)
      .filter((q) => (side === "BACK" ? q > price + EPS : q < price - EPS))
      .sort((a, b) => (side === "BACK" ? a - b : b - a));
    group.forEach((o, i) => {
      let left = sizeRemaining(o);
      // (a) The book crossed the price: offers at or better than it would have matched this order.
      for (const t of live ? takeLiquidity(sel, runner, side, price, left) : []) {
        addFill(o, price, t.size, now);
        left = pennies(left - t.size);
      }
      // (b) Volume traded through the price since the last book would have matched this order first.
      for (const q of through) {
        const available = pool.get(priceKey(q)) ?? 0;
        const x = pennies(Math.min(left, available));
        if (x <= 0) continue;
        pool.set(priceKey(q), pennies(available - x));
        addFill(o, price, x, now);
        left = pennies(left - x);
      }
      // (b) Volume traded at the price beyond the money queued ahead of this order.
      const x = pennies(Math.min(left, Math.max(0, atPrice - queues[i]), excessPool));
      if (x > 0) {
        excessPool = pennies(excessPool - x);
        addFill(o, price, x, now);
      }
      // What is left ahead after the trades, never more than the level still shows.
      const queue = Math.min(Math.max(0, pennies(queues[i] - atPrice)), shownOwn ?? Infinity);
      meta(o).queue = Number.isFinite(queue) ? queue : null;
    });
  }

  // ---------------------------------------------------------------- settlement

  private settle(book: MarketBook, now: string) {
    const orders = this.unsettled(book.marketId);
    const deadHeat = deadHeatOf(book, this.market(book.marketId).numberOfWinners);
    let gross = 0;
    for (const o of orders) {
      o.sizeLapsed = pennies(o.sizeLapsed + sizeRemaining(o));
      const status = findRunner(book, o)?.status;
      if (sizeMatched(o) <= 0 || (status !== "WINNER" && status !== "LOSER" && status !== "PLACED")) {
        this.voidOrder(o, now, status ? `Runner status ${status}.` : "Runner missing from the closed market.");
        continue;
      }
      // PLACED only occurs in EACH_WAY markets, which paper mode refuses: it is not a win.
      const wins = status === "WINNER";
      // Share of each stake settled as a winner (below 1 only for a winner in a dead heat), the rest as a loser.
      const share = wins && deadHeat ? deadHeat.share : 1;
      const profit = o.fills.reduce(
        (total, f) => total + share * betOutcomeProfit(o.side, f.price, f.size, wins) + (1 - share) * betOutcomeProfit(o.side, f.price, f.size, false),
        0,
      );
      gross += profit;
      o.settlement = { outcome: (o.side === "BACK") === wins ? "WON" : "LOST", profit, settledDate: now };
      if (share < 1) meta(o).note = deadHeat!.note;
    }
    this.recordSettlement(book.marketId, orders, gross, now);
  }

  private voidOrder(o: PaperOrder, now: string, note: string) {
    o.sizeLapsed = pennies(o.sizeLapsed + sizeRemaining(o));
    o.sizeVoided = sizeMatched(o);
    o.settlement = { outcome: "VOID", profit: 0, settledDate: now };
    meta(o).note = note;
  }

  /** One settlement per market; commission is charged on net market winnings at the market's base rate. */
  private recordSettlement(marketId: string, orders: PaperOrder[], gross: number, now: string, note?: string) {
    const existing = this.state.paper.settlements.find((s) => s.marketId === marketId);
    const rate = existing?.commissionRate ?? this.commissionRate(marketId);
    const commission = (profit: number) => rate * Math.max(0, profit);
    if (existing) {
      existing.grossProfit += gross;
      existing.commission = commission(existing.grossProfit);
      existing.commissionRate = rate;
      return;
    }
    const named = orders.find((o) => o.marketName) ?? orders[0];
    this.state.paper.settlements.push({
      marketId,
      marketName: named?.marketName ?? this.markets.cachedCatalogue(marketId)?.marketName ?? marketId,
      eventName: named?.eventName ?? "",
      grossProfit: gross,
      commission: commission(gross),
      commissionRate: rate,
      settledDate: now,
      note,
    });
  }

  /** Betfair charges each market's own base rate (a percentage in its catalogue); PAPER_COMMISSION_RATE when it is unknown. */
  private commissionRate(marketId: string): number {
    const baseRate =
      this.state.paper.orders.find((o) => o.marketId === marketId && o.marketBaseRate !== undefined)?.marketBaseRate ??
      this.markets.cachedCatalogue(marketId)?.description?.marketBaseRate;
    return baseRate !== undefined && Number.isFinite(baseRate) && baseRate >= 0 ? baseRate / 100 : this.options.commissionRate;
  }

  /** Betfair purges settled markets; one that never showed a result cannot hold exposure forever. */
  private voidVanished(marketId: string, cutoff: number) {
    const orders = this.unsettled(marketId);
    if (!orders.length) return;
    const start = Date.parse(orders.find((o) => o.marketStartTime)?.marketStartTime ?? "");
    const reference = Number.isFinite(start) ? start : Math.min(...orders.map((o) => Date.parse(o.placedDate)));
    if (reference > cutoff) return;
    const now = this.isoNow();
    const note = `Betfair no longer returns market ${marketId} more than 24 h after its start; its result is unknown, so the paper bets were voided.`;
    for (const o of orders) this.voidOrder(o, now, note);
    this.recordSettlement(marketId, orders, 0, now, note);
    this.prune(marketId);
    this.state.changed();
  }

  // ---------------------------------------------------------------- ledger helpers

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private unsettled(marketId: string): PaperOrder[] {
    return this.state.paper.orders.filter((o) => o.marketId === marketId && !o.settlement);
  }

  private liveOrders(marketId: string): PaperOrder[] {
    return this.state.paper.orders.filter((o) => o.marketId === marketId && isLive(o));
  }

  private market(marketId: string): PaperMarketState {
    const markets = (this.state.paper.markets ??= {});
    return (markets[marketId] ??= { selections: {} });
  }

  /** Drop matching state no live order needs (all of it once the market has none). */
  private prune(marketId: string) {
    const markets = this.state.paper.markets;
    const market = markets?.[marketId];
    if (!markets || !market) return;
    const live = new Set(this.liveOrders(marketId).map(keyOf));
    if (!live.size) {
      delete markets[marketId];
      return;
    }
    for (const key of Object.keys(market.selections)) if (!live.has(key)) delete market.selections[key];
  }

  private settledProfitLoss(): number {
    return this.state.paper.settlements.reduce((total, s) => total + s.grossProfit - s.commission, 0);
  }

  private balance(): number {
    return this.options.startingBalance + this.settledProfitLoss();
  }

  /** Exposure of a market's live orders (plus an optional pro-forma leg), using the latest book's runners and winner count. */
  private marketExposureOf(marketId: string, orders: PaperOrder[], book?: MarketBook, extra?: ExposureLeg): number {
    const market = this.state.paper.markets?.[marketId];
    // Handicap lines overlap: never enumerate them as mutually exclusive winners.
    const handicap = orders.some((o) => o.handicap) || Boolean(extra?.key.includes("_"));
    const winners = handicap ? undefined : (book?.numberOfWinners ?? market?.numberOfWinners ?? orders.find((o) => o.numberOfWinners !== undefined)?.numberOfWinners);
    const active = book ? activeKeys(book) : market?.activeRunners;
    const legs = orders.map(legOf);
    if (extra) legs.push(extra);
    return marketExposure(legs, winners, active);
  }

  /** Total worst-case loss over all markets with live orders (shared by accountFunds and the funds check). */
  private exposure(): number {
    const byMarket = new Map<string, PaperOrder[]>();
    for (const o of this.state.paper.orders) {
      if (!isLive(o)) continue;
      const list = byMarket.get(o.marketId);
      if (list) list.push(o);
      else byMarket.set(o.marketId, [o]);
    }
    let total = 0;
    for (const [marketId, orders] of byMarket) total += this.marketExposureOf(marketId, orders);
    return total;
  }
}

function orderView(o: PaperOrder): OrderView {
  const remaining = sizeRemaining(o);
  return {
    betId: o.betId,
    marketId: o.marketId,
    selectionId: keyOf(o),
    side: o.side,
    price: o.price,
    size: o.size,
    sizeMatched: sizeMatched(o),
    averagePriceMatched: averagePrice(o),
    sizeRemaining: remaining,
    sizeVoided: o.sizeVoided,
    status: remaining > 0 ? "EXECUTABLE" : "EXECUTION_COMPLETE",
    persistenceType: o.persistenceType,
    placedDate: o.placedDate,
    matchedDate: o.fills[o.fills.length - 1]?.at,
    strategy: o.strategyName,
    customerOrderRef: o.customerOrderRef,
  };
}
