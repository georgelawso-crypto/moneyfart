import type { BetfairApi } from "./betfair/client.js";
import type { MarketBook, PersistenceType, PriceSize, Side } from "./betfair/types.js";
import { formatSelectionId, round, type MarketService } from "./markets.js";
import type { PaperOrder, State } from "./state.js";

export interface OrderRequest {
  selectionId: number;
  handicap: number;
  side: Side;
  price: number;
  size: number;
  persistenceType: PersistenceType;
}

export interface PlacedBet {
  selectionId: string;
  side: Side;
  price: number;
  size: number;
  status: "SUCCESS" | "FAILURE";
  betId?: string;
  errorCode?: string;
  sizeMatched?: number;
  averagePriceMatched?: number;
  orderStatus?: string;
}

export interface OrderView {
  betId: string;
  marketId: string;
  selectionId: string;
  side: Side;
  price: number;
  size: number;
  sizeMatched: number;
  averagePriceMatched?: number;
  sizeRemaining: number;
  status: string;
  persistenceType: string;
  placedDate: string;
  strategy?: string;
}

export interface SettledBetView {
  betId: string;
  marketId: string;
  selectionId: string;
  eventType?: string;
  event?: string;
  market?: string;
  selection?: string;
  marketStartTime?: string;
  side: Side;
  priceMatched?: number;
  sizeSettled?: number;
  outcome: string;
  profit: number;
  settledDate?: string;
  strategy?: string;
}

export interface FundsView {
  mode: "paper" | "live";
  availableToBetBalance: number;
  exposure: number;
  [key: string]: unknown;
}

export interface Exchange {
  readonly mode: "paper" | "live";
  placeOrders(marketId: string, orders: OrderRequest[], strategyName: string): Promise<PlacedBet[]>;
  cancelOrders(marketId: string, betIds?: string[]): Promise<Array<{ betId: string; sizeCancelled: number; status: string }>>;
  currentOrders(marketIds?: string[]): Promise<OrderView[]>;
  accountFunds(): Promise<FundsView>;
  settledBets(from: Date, marketIds?: string[]): Promise<{ bets: SettledBetView[]; commission?: number }>;
}

/** Profit of a matched bet if its selection wins / loses. */
export function betOutcomeProfit(side: Side, price: number, size: number, wins: boolean): number {
  if (side === "BACK") return wins ? size * (price - 1) : -size;
  return wins ? -size * (price - 1) : size;
}

/** Match an order against the opposite side of the ladder, best price first. */
export function matchAgainstLadder(side: Side, price: number, size: number, ladder: PriceSize[] | undefined) {
  let remaining = size;
  let matched = 0;
  let weighted = 0;
  const levels = [...(ladder ?? [])].sort((a, b) => (side === "BACK" ? b.price - a.price : a.price - b.price));
  for (const level of levels) {
    if (remaining <= 0) break;
    const acceptable = side === "BACK" ? level.price >= price : level.price <= price;
    if (!acceptable) break;
    const take = Math.min(remaining, level.size);
    matched += take;
    weighted += take * level.price;
    remaining -= take;
  }
  return { sizeMatched: round(matched)!, averagePriceMatched: matched > 0 ? round(weighted / matched)! : 0 };
}

function orderView(o: PaperOrder): OrderView {
  const remaining = round(o.size - o.sizeMatched - o.sizeCancelled - o.sizeLapsed)!;
  return {
    betId: o.betId,
    marketId: o.marketId,
    selectionId: formatSelectionId(o.selectionId, o.handicap),
    side: o.side,
    price: o.price,
    size: o.size,
    sizeMatched: o.sizeMatched,
    averagePriceMatched: o.sizeMatched > 0 ? o.averagePriceMatched : undefined,
    sizeRemaining: remaining,
    status: remaining > 0 ? "EXECUTABLE" : "EXECUTION_COMPLETE",
    persistenceType: o.persistenceType,
    placedDate: o.placedDate,
    strategy: o.strategyName,
  };
}

/**
 * Practice-mode exchange: orders are matched against the real Betfair order book
 * (immediately against available liquidity, later when the market trades through
 * the requested price) and settled with real results when the market closes.
 */
export class PaperExchange implements Exchange {
  readonly mode = "paper" as const;

  constructor(
    private readonly markets: MarketService,
    private readonly state: State,
    private readonly startingBalance: number,
    private readonly commissionRate: number,
  ) {
    markets.onBook((book) => this.onBook(book));
  }

  async placeOrders(marketId: string, orders: OrderRequest[], strategyName: string): Promise<PlacedBet[]> {
    const catalogue = await this.markets.getCatalogue(marketId).catch(() => undefined);
    const book = await this.markets.getBook(marketId, ["EX_BEST_OFFERS"], 10);
    const now = new Date().toISOString();
    return orders.map((req) => {
      const selectionId = formatSelectionId(req.selectionId, req.handicap);
      const base = { selectionId, side: req.side, price: req.price, size: req.size };
      if (book.status !== "OPEN") return { ...base, status: "FAILURE" as const, errorCode: `MARKET_${book.status}` };
      const runner = book.runners.find((r) => r.selectionId === req.selectionId && r.handicap === req.handicap);
      if (!runner || runner.status !== "ACTIVE") return { ...base, status: "FAILURE" as const, errorCode: "RUNNER_REMOVED" };
      const ladder = req.side === "BACK" ? runner.ex?.availableToBack : runner.ex?.availableToLay;
      const fill = matchAgainstLadder(req.side, req.price, req.size, ladder);
      const order: PaperOrder = {
        betId: this.state.nextPaperBetId(),
        marketId: book.marketId,
        selectionId: req.selectionId,
        handicap: req.handicap,
        side: req.side,
        price: req.price,
        size: req.size,
        sizeMatched: fill.sizeMatched,
        averagePriceMatched: fill.averagePriceMatched,
        sizeCancelled: 0,
        sizeLapsed: 0,
        persistenceType: req.persistenceType,
        placedDate: now,
        matchedDate: fill.sizeMatched > 0 ? now : undefined,
        strategyName,
        marketName: catalogue?.marketName,
        eventName: catalogue?.event?.name,
        selectionName: catalogue?.runners?.find((r) => r.selectionId === req.selectionId && r.handicap === req.handicap)?.runnerName,
      };
      this.state.paperOrders.push(order);
      this.state.changed();
      return {
        ...base,
        status: "SUCCESS" as const,
        betId: order.betId,
        sizeMatched: order.sizeMatched,
        averagePriceMatched: order.sizeMatched > 0 ? order.averagePriceMatched : undefined,
        orderStatus: order.sizeMatched >= order.size ? "EXECUTION_COMPLETE" : "EXECUTABLE",
      };
    });
  }

  async cancelOrders(marketId: string, betIds?: string[]) {
    const results = [];
    for (const o of this.state.paperOrders) {
      if (o.marketId !== marketId || o.settlement) continue;
      if (betIds && !betIds.includes(o.betId)) continue;
      const remaining = round(o.size - o.sizeMatched - o.sizeCancelled - o.sizeLapsed)!;
      if (remaining <= 0) continue;
      o.sizeCancelled = round(o.sizeCancelled + remaining)!;
      results.push({ betId: o.betId, sizeCancelled: remaining, status: "SUCCESS" });
    }
    this.state.changed();
    return results;
  }

  async currentOrders(marketIds?: string[]): Promise<OrderView[]> {
    await this.refresh(marketIds);
    return this.state.paperOrders
      .filter((o) => !o.settlement && (!marketIds || marketIds.includes(o.marketId)))
      .filter((o) => o.sizeMatched > 0 || o.size - o.sizeCancelled - o.sizeLapsed > 0)
      .map(orderView);
  }

  async accountFunds(): Promise<FundsView> {
    await this.refresh();
    const settled = this.state.paperSettlements.reduce((total, s) => total + s.grossProfit - s.commission, 0);
    const exposure = this.exposure();
    const balance = this.startingBalance + settled;
    return {
      mode: "paper",
      availableToBetBalance: round(balance - exposure)!,
      exposure: round(exposure)!,
      balance: round(balance)!,
      startingBalance: this.startingBalance,
      settledProfitLoss: round(settled)!,
    };
  }

  async settledBets(from: Date, marketIds?: string[]) {
    await this.refresh(marketIds);
    const fromIso = from.toISOString();
    const settlements = this.state.paperSettlements.filter(
      (s) => s.settledDate >= fromIso && (!marketIds || marketIds.includes(s.marketId)),
    );
    const byMarket = new Map(settlements.map((s) => [s.marketId, s]));
    const bets: SettledBetView[] = this.state.paperOrders
      .filter((o) => o.settlement && byMarket.has(o.marketId) && o.sizeMatched > 0)
      .map((o) => ({
        betId: o.betId,
        marketId: o.marketId,
        selectionId: formatSelectionId(o.selectionId, o.handicap),
        event: o.eventName,
        market: o.marketName,
        selection: o.selectionName,
        side: o.side,
        priceMatched: o.averagePriceMatched,
        sizeSettled: o.sizeMatched,
        outcome: o.settlement!.outcome,
        profit: o.settlement!.profit,
        settledDate: o.settlement!.settledDate,
        strategy: o.strategyName,
      }));
    return { bets, commission: round(settlements.reduce((total, s) => total + s.commission, 0)) };
  }

  /** Fetch books for markets holding unsettled paper orders so they get matched/settled. */
  private async refresh(marketIds?: string[]) {
    const pending = [
      ...new Set(
        this.state.paperOrders.filter((o) => !o.settlement && (!marketIds || marketIds.includes(o.marketId))).map((o) => o.marketId),
      ),
    ];
    for (let i = 0; i < pending.length; i += 10) {
      await this.markets.getBooks(pending.slice(i, i + 10), ["EX_BEST_OFFERS"], 1);
    }
  }

  private onBook(book: MarketBook) {
    const orders = this.state.paperOrders.filter((o) => o.marketId === book.marketId && !o.settlement);
    if (!orders.length) return;
    let changed = false;
    const now = new Date().toISOString();
    for (const o of orders) {
      const remaining = round(o.size - o.sizeMatched - o.sizeCancelled - o.sizeLapsed)!;
      if (remaining <= 0) continue;
      const runner = book.runners.find((r) => r.selectionId === o.selectionId && r.handicap === o.handicap);
      const closing = book.status === "CLOSED" || !runner || runner.status !== "ACTIVE";
      if (closing || (book.inplay && o.persistenceType === "LAPSE")) {
        o.sizeLapsed = round(o.sizeLapsed + remaining)!;
        changed = true;
        continue;
      }
      if (book.status !== "OPEN") continue;
      const best = o.side === "BACK" ? runner.ex?.availableToBack?.[0]?.price : runner.ex?.availableToLay?.[0]?.price;
      const ltp = runner.lastPriceTraded;
      const reached =
        o.side === "BACK"
          ? (best !== undefined && best >= o.price) || (ltp !== undefined && ltp > o.price)
          : (best !== undefined && best <= o.price) || (ltp !== undefined && ltp < o.price);
      if (reached) {
        o.averagePriceMatched = round((o.averagePriceMatched * o.sizeMatched + o.price * remaining) / (o.sizeMatched + remaining))!;
        o.sizeMatched = round(o.sizeMatched + remaining)!;
        o.matchedDate = now;
        changed = true;
      }
    }
    // A closed market is settled once no runner is still ACTIVE (results are final).
    if (book.status === "CLOSED" && book.runners.every((r) => r.status !== "ACTIVE")) {
      this.settle(book, orders);
      changed = true;
    }
    if (changed) this.state.changed();
  }

  private settle(book: MarketBook, orders: PaperOrder[]) {
    const now = new Date().toISOString();
    let gross = 0;
    for (const o of orders) {
      const runner = book.runners.find((r) => r.selectionId === o.selectionId && r.handicap === o.handicap);
      const status = runner?.status;
      if (!runner || status === "REMOVED" || status === "REMOVED_VACANT" || o.sizeMatched <= 0) {
        o.settlement = { outcome: "VOID", profit: 0, settledDate: now };
        continue;
      }
      const wins = status === "WINNER" || status === "PLACED";
      const profit = round(betOutcomeProfit(o.side, o.averagePriceMatched, o.sizeMatched, wins))!;
      gross += profit;
      o.settlement = { outcome: profit >= 0 ? "WON" : "LOST", profit, settledDate: now };
    }
    this.state.paperSettlements.push({
      marketId: book.marketId,
      marketName: orders[0]?.marketName ?? "",
      eventName: orders[0]?.eventName ?? "",
      grossProfit: round(gross)!,
      commission: round(Math.max(0, gross) * this.commissionRate)!,
      settledDate: now,
    });
  }

  /** Worst-case loss over all "this selection wins" scenarios per market, plus unmatched liability. */
  private exposure(): number {
    const byMarket = new Map<string, PaperOrder[]>();
    for (const o of this.state.paperOrders) {
      if (o.settlement) continue;
      byMarket.set(o.marketId, [...(byMarket.get(o.marketId) ?? []), o]);
    }
    let exposure = 0;
    for (const orders of byMarket.values()) {
      const selections = [...new Set(orders.map((o) => formatSelectionId(o.selectionId, o.handicap)))];
      const scenarios = [...selections, null].map((winner) =>
        orders.reduce(
          (total, o) =>
            total + betOutcomeProfit(o.side, o.averagePriceMatched, o.sizeMatched, formatSelectionId(o.selectionId, o.handicap) === winner),
          0,
        ),
      );
      exposure += Math.max(0, -Math.min(...scenarios));
      for (const o of orders) {
        const remaining = o.size - o.sizeMatched - o.sizeCancelled - o.sizeLapsed;
        if (remaining > 0) exposure += o.side === "BACK" ? remaining : remaining * (o.price - 1);
      }
    }
    return exposure;
  }
}

/** Real-money exchange backed by the Betfair API. */
export class LiveExchange implements Exchange {
  readonly mode = "live" as const;

  constructor(private readonly api: BetfairApi) {}

  async placeOrders(marketId: string, orders: OrderRequest[], strategyName: string): Promise<PlacedBet[]> {
    const report = await this.api.placeOrders({
      marketId,
      customerStrategyRef: strategyName.slice(0, 15),
      instructions: orders.map((o) => ({
        orderType: "LIMIT",
        selectionId: o.selectionId,
        handicap: o.handicap,
        side: o.side,
        limitOrder: { size: o.size, price: o.price, persistenceType: o.persistenceType },
      })),
    });
    return orders.map((o, i) => {
      const r = report.instructionReports?.[i];
      return {
        selectionId: formatSelectionId(o.selectionId, o.handicap),
        side: o.side,
        price: o.price,
        size: o.size,
        status: r?.status === "SUCCESS" ? "SUCCESS" : "FAILURE",
        betId: r?.betId,
        errorCode: r?.errorCode ?? (r?.status === "SUCCESS" ? undefined : report.errorCode ?? report.status),
        sizeMatched: r?.sizeMatched,
        averagePriceMatched: r?.averagePriceMatched,
        orderStatus: r?.orderStatus,
      };
    });
  }

  async cancelOrders(marketId: string, betIds?: string[]) {
    const report = await this.api.cancelOrders({ marketId, instructions: betIds?.map((betId) => ({ betId })) });
    return (report.instructionReports ?? []).map((r) => ({
      betId: r.instruction.betId,
      sizeCancelled: r.sizeCancelled ?? 0,
      status: r.status === "SUCCESS" ? "SUCCESS" : r.errorCode ?? r.status,
    }));
  }

  async currentOrders(marketIds?: string[]): Promise<OrderView[]> {
    const orders: OrderView[] = [];
    for (let fromRecord = 0; ; ) {
      const report = await this.api.listCurrentOrders({ marketIds, orderProjection: "ALL", fromRecord, recordCount: 1000 });
      for (const o of report.currentOrders) {
        orders.push({
          betId: o.betId,
          marketId: o.marketId,
          selectionId: formatSelectionId(o.selectionId, o.handicap),
          side: o.side,
          price: o.priceSize.price,
          size: o.priceSize.size,
          sizeMatched: o.sizeMatched ?? 0,
          averagePriceMatched: o.averagePriceMatched || undefined,
          sizeRemaining: o.sizeRemaining ?? 0,
          status: o.status,
          persistenceType: o.persistenceType,
          placedDate: o.placedDate,
          strategy: o.customerStrategyRef,
        });
      }
      if (!report.moreAvailable || !report.currentOrders.length) break;
      fromRecord += report.currentOrders.length;
    }
    return orders;
  }

  async accountFunds(): Promise<FundsView> {
    const funds = await this.api.getAccountFunds();
    return { ...funds, mode: "live", exposure: Math.abs(funds.exposure) };
  }

  async settledBets(from: Date, marketIds?: string[]) {
    const bets: SettledBetView[] = [];
    for (let fromRecord = 0; fromRecord < 5000; ) {
      const report = await this.api.listClearedOrders({
        betStatus: "SETTLED",
        marketIds,
        settledDateRange: { from: from.toISOString() },
        includeItemDescription: true,
        fromRecord,
        recordCount: 1000,
      });
      for (const o of report.clearedOrders) {
        bets.push({
          betId: o.betId ?? "",
          marketId: o.marketId ?? "",
          selectionId: formatSelectionId(o.selectionId ?? 0, o.handicap ?? 0),
          eventType: o.itemDescription?.eventTypeDesc,
          event: o.itemDescription?.eventDesc,
          market: o.itemDescription?.marketDesc,
          selection: o.itemDescription?.runnerDesc,
          marketStartTime: o.itemDescription?.marketStartTime,
          side: o.side ?? "BACK",
          priceMatched: o.priceMatched,
          sizeSettled: o.sizeSettled,
          outcome: o.betOutcome ?? "",
          profit: o.profit ?? 0,
          settledDate: o.settledDate,
          strategy: o.customerStrategyRef,
        });
      }
      if (!report.moreAvailable || !report.clearedOrders.length) break;
      fromRecord += report.clearedOrders.length;
    }
    return { bets };
  }
}
