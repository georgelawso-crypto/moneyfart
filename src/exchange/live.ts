import crypto from "node:crypto";
import { BetfairApiError, outcomeUnknown, type BetfairApi } from "../betfair/client.js";
import { betSizeProblem, currencyRules, type CurrencyRules } from "../betfair/currency.js";
import type {
  CancelExecutionReport,
  ClearedOrderSummary,
  CurrentOrderSummary,
  PlaceExecutionReport,
  PlaceInstruction,
  PlaceInstructionReport,
  TimeRange,
} from "../betfair/types.js";
import { formatSelectionId, round } from "../format.js";
import type { State } from "../state.js";
import type { CancelResult, Exchange, FundsView, OrderRequest, OrderView, PlacedBet, SettledBetView, SettledBets, StrategyTag } from "./types.js";

// Betfair request limits.
const PLACE_INSTRUCTIONS_PER_REQUEST = 200;
const CANCEL_INSTRUCTIONS_PER_REQUEST = 60;
const MARKET_IDS_PER_REQUEST = 250;
const RECORDS_PER_PAGE = 1000;
/** Safety stop for paging loops (a misbehaving API must not loop forever). */
const MAX_PAGES = 200;
const MAX_SETTLED_BETS = 10_000;

export const UNCONFIRMED = "TIMEOUT_UNCONFIRMED: check get_current_orders before retrying";
/** Execution-report codes that only say "see the instruction reports". */
const GENERIC_REPORT_CODES = new Set(["BET_ACTION_ERROR", "PROCESSED_WITH_ERRORS"]);

export interface LiveOptions {
  /** Wait before the second look for an unconfirmed order (default 1000 ms). */
  reconcileDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Pending {
  index: number;
  instruction: PlaceInstruction & { customerOrderRef: string };
}

type CurrentOrdersQuery = Omit<Parameters<BetfairApi["listCurrentOrders"]>[0], "fromRecord" | "recordCount">;

/** Real-money exchange backed by the Betfair API. */
export class LiveExchange implements Exchange {
  readonly mode = "live" as const;
  private rules?: Promise<CurrencyRules>;
  private readonly reconcileDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    protected readonly api: BetfairApi,
    protected readonly state: State,
    protected readonly overrides: { minBetSize?: number; minBetPayout?: number } = {},
    options: LiveOptions = {},
  ) {
    this.reconcileDelayMs = options.reconcileDelayMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Minimum bet rules of the account currency (account details are read once). */
  currencyRules(): Promise<CurrencyRules> {
    if (!this.rules) {
      const pending = this.api.getAccountDetails().then((details) => {
        if (!details?.currencyCode) throw new Error("Betfair account details did not include the account currency.");
        return currencyRules(details.currencyCode, this.overrides);
      });
      this.rules = pending;
      pending.catch(() => {
        if (this.rules === pending) this.rules = undefined; // retry on the next call
      });
    }
    return this.rules;
  }

  // ---------------------------------------------------------------- placing

  /**
   * Places LIMIT orders. Every request carries a unique customerRef (Betfair de-duplicates
   * resubmissions) and every instruction a unique customerOrderRef, so an answer lost to a
   * timeout can be looked up: such orders are reported SUCCESS when found and UNKNOWN when
   * not, never FAILURE. Errors that prove nothing was sent are thrown when no request of this
   * call has been sent yet; later they become FAILURE results so placed bets are never hidden.
   */
  async placeOrders(marketId: string, orders: OrderRequest[], strategy: StrategyTag): Promise<PlacedBet[]> {
    const rules = await this.currencyRules();
    const results: PlacedBet[] = new Array(orders.length);
    const pending: Pending[] = [];
    const refPrefix = crypto.randomBytes(12).toString("hex");
    orders.forEach((order, index) => {
      // Ladder prices and stakes have 2 decimals; rounding here only strips float noise before sending.
      const price = round(order.price, 2) ?? Number.NaN;
      const size = round(order.size, 2) ?? Number.NaN;
      const selectionId = formatSelectionId(order.selectionId, order.handicap);
      const problem = !(price >= 1.01 && price <= 1000) ? "INVALID_ODDS" : betSizeProblem(size, price, rules) ? "INVALID_BET_SIZE" : undefined;
      if (problem) {
        results[index] = { selectionId, side: order.side, price: order.price, size: order.size, status: "FAILURE", errorCode: problem };
        return;
      }
      pending.push({
        index,
        instruction: {
          orderType: "LIMIT",
          selectionId: order.selectionId,
          handicap: order.handicap,
          side: order.side,
          limitOrder: { size, price, persistenceType: order.persistenceType },
          customerOrderRef: `${refPrefix}-${index.toString(36)}`,
        },
      });
    });

    const strategyRef = strategy.ref && strategy.ref.length <= 15 ? strategy.ref : strategy.name ? this.state.strategyRefFor(strategy.name) : undefined;
    let sent = false;
    for (const chunk of chunks(pending, PLACE_INSTRUCTIONS_PER_REQUEST)) {
      let report: PlaceExecutionReport;
      try {
        report = await this.api.placeOrders({
          marketId,
          instructions: chunk.map((p) => p.instruction),
          customerRef: crypto.randomUUID().replace(/-/g, ""),
          customerStrategyRef: strategyRef || undefined,
        });
      } catch (error) {
        if (outcomeUnknown(error)) {
          sent = true;
          await this.reconcile(marketId, chunk, results);
          continue;
        }
        if (!sent) throw error; // nothing of this call reached Betfair
        for (const p of chunk) results[p.index] = { ...placedBase(p), status: "FAILURE", errorCode: errorCodeOf(error) };
        continue;
      }
      sent = true;
      await this.reconcile(marketId, this.applyReport(report, chunk, results), results);
    }
    return results;
  }

  /** Map an execution report onto the results; returns the instructions whose outcome is unknown. */
  private applyReport(report: PlaceExecutionReport, chunk: Pending[], results: PlacedBet[]): Pending[] {
    // A duplicate customerRef means an earlier identical request was processed: look the orders up.
    if (report?.errorCode === "DUPLICATE_TRANSACTION") return chunk;
    const reports = report?.instructionReports ?? [];
    const byRef = new Map(reports.filter((r) => r.instruction?.customerOrderRef).map((r) => [r.instruction.customerOrderRef!, r]));
    const unknown: Pending[] = [];
    chunk.forEach((p, i) => {
      const r: PlaceInstructionReport | undefined = byRef.get(p.instruction.customerOrderRef) ?? (reports.length === chunk.length && !byRef.size ? reports[i] : undefined);
      if (r?.status === "SUCCESS") {
        results[p.index] = {
          ...placedBase(p),
          status: "SUCCESS",
          betId: r.betId,
          sizeMatched: r.sizeMatched ?? 0,
          averagePriceMatched: matchedPrice(r),
          orderStatus: r.orderStatus,
        };
      } else if (r?.status === "FAILURE" || (!r && report?.status === "FAILURE")) {
        results[p.index] = { ...placedBase(p), status: "FAILURE", errorCode: failureCode(r?.errorCode, report) };
      } else {
        unknown.push(p); // TIMEOUT, or no instruction report for an order that may have been processed
      }
    });
    return unknown;
  }

  /** Look up orders whose outcome is unknown by customerOrderRef (once more after a short wait). */
  private async reconcile(marketId: string, items: Pending[], results: PlacedBet[]) {
    if (!items.length) return;
    const found = new Map<string, CurrentOrderSummary>();
    const missing = () => items.map((p) => p.instruction.customerOrderRef).filter((ref) => !found.has(ref));
    for (let attempt = 0; attempt < 2 && missing().length; attempt++) {
      if (attempt) await this.sleep(this.reconcileDelayMs);
      try {
        for (const o of await this.listOrders({ customerOrderRefs: missing(), marketIds: [marketId], orderProjection: "ALL" })) {
          if (o.customerOrderRef) found.set(o.customerOrderRef, o);
        }
      } catch {
        // Still unknown; the second attempt (if any) may succeed.
      }
    }
    for (const p of items) {
      const o = found.get(p.instruction.customerOrderRef);
      results[p.index] = o
        ? {
            ...placedBase(p),
            status: "SUCCESS",
            betId: o.betId,
            sizeMatched: o.sizeMatched ?? 0,
            averagePriceMatched: matchedPrice(o),
            orderStatus: o.status,
          }
        : { ...placedBase(p), status: "UNKNOWN", errorCode: UNCONFIRMED };
    }
  }

  // ---------------------------------------------------------------- cancelling

  /**
   * Cancels unmatched bets by explicit betId only: Betfair treats a missing or empty instruction
   * list as "cancel everything in the market", so [] cancels nothing and "ALL" lists the market's
   * unmatched bets first.
   */
  async cancelOrders(marketId: string, betIds: string[] | "ALL"): Promise<CancelResult[]> {
    const ids =
      betIds === "ALL"
        ? (await this.listOrders({ marketIds: [marketId], orderProjection: "EXECUTABLE" })).filter((o) => (o.sizeRemaining ?? 0) > 0).map((o) => o.betId)
        : betIds;
    const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    const results: CancelResult[] = [];
    let sent = false;
    for (const chunk of chunks(unique, CANCEL_INSTRUCTIONS_PER_REQUEST)) {
      let report: CancelExecutionReport;
      try {
        report = await this.api.cancelOrders({ marketId, instructions: chunk.map((betId) => ({ betId })) });
      } catch (error) {
        if (!sent && !outcomeUnknown(error)) throw error;
        sent = true;
        for (const betId of chunk) results.push({ betId, sizeCancelled: 0, status: errorCodeOf(error) });
        continue;
      }
      sent = true;
      // Cancel reports are not guaranteed to come back in instruction order.
      const byBet = new Map((report?.instructionReports ?? []).map((r) => [String(r.instruction?.betId), r]));
      for (const betId of chunk) {
        const r = byBet.get(betId);
        const status = r
          ? r.status === "SUCCESS"
            ? "SUCCESS"
            : failureCode(r.errorCode ?? (r.status === "TIMEOUT" ? "TIMEOUT" : undefined), report)
          : (report?.errorCode ?? (report?.status === "SUCCESS" || !report?.status ? "UNCONFIRMED" : report.status));
        results.push({ betId, sizeCancelled: r?.sizeCancelled ?? 0, status });
      }
    }
    return results;
  }

  // ---------------------------------------------------------------- reading

  async currentOrders(marketIds?: string[]): Promise<OrderView[]> {
    if (marketIds && !marketIds.length) return [];
    return (await this.listOrders({ marketIds, orderProjection: "ALL" })).map((o) => this.orderView(o));
  }

  async accountFunds(): Promise<FundsView> {
    const [funds, rules] = await Promise.all([this.api.getAccountFunds(), this.currencyRules()]);
    return {
      mode: "live",
      currency: rules.currency,
      availableToBetBalance: funds.availableToBetBalance,
      exposure: Math.abs(funds.exposure ?? 0),
      retainedCommission: funds.retainedCommission,
      exposureLimit: funds.exposureLimit,
      discountRate: funds.discountRate,
      pointsBalance: funds.pointsBalance,
    };
  }

  /**
   * Settled bets since `from` (up to 10000, `truncated` when more existed) plus the commission
   * Betfair charged on those markets: bet-level rows carry gross profit only, commission is
   * reported by the MARKET rollup.
   */
  async settledBets(from: Date, marketIds?: string[]): Promise<SettledBets> {
    if (marketIds && !marketIds.length) return { bets: [], commission: 0 };
    const settledDateRange = { from: from.toISOString() };
    const bets = new Map<string, SettledBetView>();
    let truncated = false;
    for (const group of marketIdGroups(marketIds)) {
      await this.pages(
        (fromRecord) =>
          this.api.listClearedOrders({ betStatus: "SETTLED", marketIds: group, settledDateRange, includeItemDescription: true, fromRecord, recordCount: RECORDS_PER_PAGE }),
        (report) => report.clearedOrders,
        (rows, moreAvailable) => {
          for (const o of rows) {
            const key = o.betId ?? `${o.marketId}:${o.selectionId}:${o.placedDate}:${bets.size}`;
            if (bets.has(key)) continue;
            if (bets.size >= MAX_SETTLED_BETS) {
              truncated = true;
              return false;
            }
            bets.set(key, this.settledView(o));
          }
          if (bets.size >= MAX_SETTLED_BETS && moreAvailable) truncated = true;
          return !truncated;
        },
      );
      if (truncated) break;
    }
    const list = [...bets.values()];
    let commission: number | undefined;
    try {
      commission = await this.commission(settledDateRange, [...new Set(list.map((b) => b.marketId))]);
    } catch (error) {
      console.error(`[live] commission lookup failed: ${(error as Error).message}`);
    }
    return { bets: list, commission, ...(truncated ? { truncated: true } : {}) };
  }

  pendingMarketIds(): string[] {
    return [];
  }

  // ---------------------------------------------------------------- helpers

  /** Σ commission of the MARKET rollup, restricted to the given markets. */
  private async commission(settledDateRange: TimeRange, marketIds: string[]): Promise<number> {
    const byMarket = new Map<string, number>();
    const wanted = new Set(marketIds);
    for (const group of chunks(marketIds, MARKET_IDS_PER_REQUEST)) {
      await this.pages(
        (fromRecord) =>
          this.api.listClearedOrders({ betStatus: "SETTLED", marketIds: group, settledDateRange, groupBy: "MARKET", fromRecord, recordCount: RECORDS_PER_PAGE }),
        (report) => report.clearedOrders,
        (rows) => {
          for (const m of rows) if (m.marketId && wanted.has(m.marketId)) byMarket.set(m.marketId, m.commission ?? 0);
          return true;
        },
      );
    }
    let total = 0;
    for (const value of byMarket.values()) total += value;
    // A sum of whole pennies: rounding only removes float noise (0.1 + 0.2 + 0.3 = 0.6000000000000001).
    return round(total, 2) ?? 0;
  }

  /** listCurrentOrders over every page, with market ids split into Betfair-sized groups; de-duplicated by betId. */
  private async listOrders(query: CurrentOrdersQuery): Promise<CurrentOrderSummary[]> {
    const orders = new Map<string, CurrentOrderSummary>();
    for (const marketIds of marketIdGroups(query.marketIds)) {
      await this.pages(
        (fromRecord) => this.api.listCurrentOrders({ ...query, marketIds, fromRecord, recordCount: RECORDS_PER_PAGE }),
        (report) => report.currentOrders,
        (rows) => {
          for (const o of rows) orders.set(o.betId, o);
          return true;
        },
      );
    }
    return [...orders.values()];
  }

  /** Page through a Betfair list call until moreAvailable is false (or `take` returns false). */
  private async pages<R extends { moreAvailable: boolean }, T>(
    fetch: (fromRecord: number) => Promise<R>,
    rowsOf: (report: R) => T[] | undefined,
    take: (rows: T[], moreAvailable: boolean) => boolean,
  ) {
    for (let page = 0, fromRecord = 0; page < MAX_PAGES; page++) {
      const report = await fetch(fromRecord);
      const rows = rowsOf(report) ?? [];
      if (!take(rows, Boolean(report.moreAvailable)) || !report.moreAvailable || !rows.length) return;
      fromRecord += rows.length;
    }
  }

  private orderView(o: CurrentOrderSummary): OrderView {
    return {
      betId: o.betId,
      marketId: o.marketId,
      selectionId: formatSelectionId(o.selectionId, o.handicap ?? 0),
      side: o.side,
      price: o.priceSize?.price ?? 0,
      size: o.priceSize?.size ?? 0,
      sizeMatched: o.sizeMatched ?? 0,
      averagePriceMatched: matchedPrice(o),
      sizeRemaining: o.sizeRemaining ?? 0,
      sizeVoided: o.sizeVoided,
      status: o.status === "EXECUTABLE" || o.status === "PENDING" ? "EXECUTABLE" : "EXECUTION_COMPLETE",
      persistenceType: o.persistenceType,
      placedDate: o.placedDate,
      matchedDate: o.matchedDate,
      strategy: this.state.strategyNameForRef(o.customerStrategyRef),
      customerOrderRef: o.customerOrderRef,
    };
  }

  private settledView(o: ClearedOrderSummary): SettledBetView {
    const item = o.itemDescription;
    return {
      betId: o.betId ?? "",
      marketId: o.marketId ?? "",
      selectionId: formatSelectionId(o.selectionId ?? 0, o.handicap ?? 0),
      eventType: item?.eventTypeDesc,
      event: item?.eventDesc,
      market: item?.marketDesc,
      selection: item?.runnerDesc,
      marketStartTime: item?.marketStartTime,
      side: o.side ?? "BACK",
      priceMatched: o.priceMatched,
      sizeSettled: o.sizeSettled,
      outcome: o.betOutcome ?? "",
      profit: o.profit ?? 0,
      placedDate: o.placedDate,
      lastMatchedDate: o.lastMatchedDate,
      settledDate: o.settledDate,
      strategy: this.state.strategyNameForRef(o.customerStrategyRef),
    };
  }
}

function placedBase(p: Pending): Pick<PlacedBet, "selectionId" | "side" | "price" | "size" | "customerOrderRef"> {
  const i = p.instruction;
  return {
    selectionId: formatSelectionId(i.selectionId, i.handicap ?? 0),
    side: i.side,
    price: i.limitOrder.price,
    size: i.limitOrder.size,
    customerOrderRef: i.customerOrderRef,
  };
}

/**
 * When a whole request fails, every instruction just says ERROR_IN_ORDER and the reason
 * (MARKET_SUSPENDED, INSUFFICIENT_FUNDS...) is on the execution report: show both.
 */
function failureCode(instructionCode: string | undefined, report: { status?: string; errorCode?: string } | undefined): string {
  const parent = report?.errorCode && !GENERIC_REPORT_CODES.has(report.errorCode) ? report.errorCode : undefined;
  if (instructionCode === "ERROR_IN_ORDER" && parent) return `${parent} (ERROR_IN_ORDER)`;
  return instructionCode ?? report?.errorCode ?? report?.status ?? "FAILURE";
}

function errorCodeOf(error: unknown): string {
  return error instanceof BetfairApiError ? error.code : "ERROR";
}

/** Unrounded average matched price; undefined when nothing is matched (Betfair reports 0). */
function matchedPrice(o: { sizeMatched?: number; averagePriceMatched?: number }): number | undefined {
  return o.sizeMatched && o.averagePriceMatched ? o.averagePriceMatched : undefined;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** [undefined] (no market filter) or the distinct ids in groups Betfair accepts. */
function marketIdGroups(marketIds?: string[]): Array<string[] | undefined> {
  return marketIds ? chunks([...new Set(marketIds)], MARKET_IDS_PER_REQUEST) : [undefined];
}
