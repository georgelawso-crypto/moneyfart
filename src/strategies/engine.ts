import { betSizeProblem, type CurrencyRules } from "../betfair/currency.js";
import { offsetTicks, roundToTick, type LadderType } from "../betfair/ticks.js";
import type { MarketBook, MarketCatalogue, PersistenceType } from "../betfair/types.js";
import type { Config } from "../config.js";
import { dutchStakes, positionOf } from "../exchange/math.js";
import type { CancelResult, Exchange, OrderView, PlacedBet, StrategyTag } from "../exchange/types.js";
import { assertMarketId, marketStatusName, parseSelectionId, round, runnerStatusName, sameSelection, selectionKey, type SelectionRef } from "../format.js";
import type { MarketService } from "../markets.js";
import type { State } from "../state.js";
import type { BotMeta, BotRunner } from "./bots.js";
import { BUILT_IN_SETTINGS } from "./builtins.js";
import {
  CLOSE,
  FILL_OR_KILL_MAX_MS,
  OPEN,
  ParameterError,
  TEMPLATE,
  TEMPLATES,
  findTemplate,
  groupValues,
  normaliseParameters,
  parameterProblems,
  parseParameters,
  resolveParameters,
  timeSpanMs,
  type Params,
} from "./templates.js";
import {
  OrderDesk,
  bestPrices,
  cancelSucceeded,
  closeOrder,
  describePosition,
  isFlat,
  isFlatAt,
  ladderOf,
  opposite,
  planEntry,
  runnerOf,
  sortedSelections,
  type Placement,
  type PlannedOrder,
} from "./trading.js";
import type { ExecutionResult, RejectedOrder, StrategySetting, TemplateSpec } from "./types.js";

export interface EngineDeps {
  markets: MarketService;
  exchange: Exchange;
  state: State;
  limits: Config["trading"];
  bots: BotRunner;
  /** Clock in epoch milliseconds (injectable for tests). */
  now?: () => number;
  /** Delay used while a fill-or-kill bet waits to match (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_SEQUENCE_DEPTH = 5;
const DEFAULT_MATCHING_TIMEOUT_MS = 5000;

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

/** Outcome bookkeeping of one execution. */
class Run {
  readonly problems: string[] = [];
  readonly skips: string[] = [];
  readonly rejected: RejectedOrder[] = [];
  readonly botIds: string[] = [];
  /** Successful actions: bets placed, bets cancelled. */
  done = 0;
  /** Bets whose outcome is unknown (request timed out). */
  uncertain = 0;
  /** Sequence Execution: message of the step that failed (status false even after earlier bets). */
  failedStep?: string;

  constructor(readonly result: ExecutionResult) {}

  note(message: string) {
    this.result.messages.push(message);
  }

  problem(message: string) {
    this.problems.push(message);
    this.note(message);
  }

  skip(message: string) {
    this.skips.push(message);
    this.note(message);
  }

  reject(order: PlannedOrder, reason: string) {
    this.rejected.push({
      selectionId: selectionKey(order),
      selectionName: order.selectionName,
      side: order.side,
      price: order.price,
      size: order.size,
      role: order.role,
      reason,
    });
  }

  placements(list: Placement[]) {
    for (const { order, bet, reason } of list) {
      const name = order.selectionName ?? selectionKey(order);
      const what = `${order.side} ${order.size} @ ${order.price}`;
      if (reason || !bet) {
        this.reject(order, reason ?? "not sent");
        this.problem(`${name}: ${what} not placed: ${reason}`);
        continue;
      }
      this.result.bets.push({ ...bet, selectionName: order.selectionName, role: order.role });
      if (bet.status === "SUCCESS") this.done++;
      else if (bet.status === "UNKNOWN") {
        this.uncertain++;
        this.note(`${name}: ${what}: outcome unknown (${bet.errorCode}). Check get_current_orders before retrying.`);
      } else this.problem(`${name}: ${what} failed (${bet.errorCode ?? bet.status}).`);
    }
  }

  cancels(results: CancelResult[], requested: string[]) {
    this.result.cancelled.push(...results);
    for (const r of results) {
      if (r.status === "SUCCESS") this.done++;
      else if (r.status === "BET_TAKEN_OR_LAPSED") this.note(`Bet ${r.betId} was already matched or lapsed; nothing to cancel.`);
      else this.problem(`Cancelling bet ${r.betId} failed (${r.status}).`);
    }
    for (const id of requested) if (!results.some((r) => r.betId === id)) this.problem(`No cancel report for bet ${id}; it may still be live.`);
  }

  finish(): ExecutionResult {
    const r = this.result;
    if (this.botIds.length) {
      r.botId = this.botIds[0];
      r.botIds = [...this.botIds];
    }
    if (this.rejected.length) r.rejected = this.rejected;
    const acted = this.done + this.botIds.length;
    if (this.failedStep !== undefined) {
      r.outcome = acted || this.uncertain ? "PartiallyExecuted" : "Failed";
      r.status = false;
      r.message = this.failedStep;
      return r;
    }
    if (!acted && !this.uncertain) r.outcome = this.problems.length ? "Failed" : "Skipped";
    else if (this.problems.length || this.uncertain) r.outcome = "PartiallyExecuted";
    else r.outcome = this.botIds.length ? "Started" : "Executed";
    r.status = r.outcome !== "Failed";
    if (r.outcome === "Failed") r.message = this.problems.join(" ");
    else if (r.outcome === "Skipped") r.message = this.skips.join(" ") || r.messages.join(" ") || "Nothing to do.";
    else if (r.outcome === "PartiallyExecuted") {
      const placed = r.bets.filter((b) => b.status === "SUCCESS").length;
      const cancelled = r.cancelled.filter((c) => c.status === "SUCCESS").length;
      const unknown = this.uncertain ? ` ${this.uncertain} bet(s) have an unknown outcome: check get_current_orders before retrying.` : "";
      r.message =
        `Partially executed: ${placed} bet(s) placed, ${cancelled} cancelled, ${this.botIds.length} bot(s) started; do not simply retry. ` +
        `${this.problems.join(" ")}${unknown}`.trim();
    } else if (r.outcome === "Started") r.message = `Started bot ${this.botIds.join(", ")} to manage the position; follow it with get_bots.`;
    return r;
  }
}

interface MarketContext {
  id: string;
  catalogue: MarketCatalogue;
  book: MarketBook;
  ladder: LadderType;
  rules: CurrencyRules;
  /** Scheduled start (epoch ms). */
  startMs?: number;
}

interface Exec {
  run: Run;
  setting: StrategySetting;
  template: TemplateSpec;
  values: Params;
  tag: StrategyTag;
  market: MarketContext;
}

interface Entry {
  ref: SelectionRef;
  name: string;
  bet: PlacedBet;
}

function blankResult(mode: "paper" | "live", strategyName: string, marketId: string): ExecutionResult {
  // Key order matters for readers: status first, then message.
  return {
    status: false,
    message: undefined,
    mode,
    strategyName,
    template: "",
    marketId,
    marketName: undefined,
    eventName: undefined,
    outcome: "Failed",
    messages: [],
    bets: [],
    cancelled: [],
    botId: undefined,
    botIds: undefined,
    rejected: undefined,
    parameters: {},
  };
}

function startOf(catalogue: MarketCatalogue): number | undefined {
  const start = catalogue.marketStartTime ?? catalogue.description?.marketTime;
  const ms = start ? Date.parse(start) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

const persistence = (keep: unknown): PersistenceType => (keep === true ? "PERSIST" : "LAPSE");

/** Strategy settings, templates and execution. */
export class StrategyEngine {
  private readonly desk: OrderDesk;

  constructor(protected readonly deps: EngineDeps) {
    this.desk = new OrderDesk(deps.exchange, deps.limits);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------- settings

  /** All settings: built-ins (minus those overridden) plus custom ones. */
  list(): StrategySetting[] {
    const custom = [...this.deps.state.customStrategies.values()];
    const overridden = new Set(custom.map((s) => s.name.toLowerCase()));
    return [...BUILT_IN_SETTINGS.filter((s) => !overridden.has(s.name.toLowerCase())), ...custom].map((s) => structuredClone(s));
  }

  /** Resolve a setting by name or alias (case-insensitive); throws with the available names. */
  get(name: string): StrategySetting {
    const wanted = String(name ?? "").trim().toLowerCase();
    const found =
      this.deps.state.customStrategies.get(wanted) ??
      BUILT_IN_SETTINGS.find((s) => s.name.toLowerCase() === wanted) ??
      BUILT_IN_SETTINGS.find((s) => s.aliases?.some((a) => a.toLowerCase() === wanted));
    if (!found) {
      throw new Error(`Strategy setting "${name}" not found. Available: ${this.list().map((s) => s.name).join(", ")}. Create one with create_strategy_settings.`);
    }
    return structuredClone(found);
  }

  templates(): TemplateSpec[] {
    return TEMPLATES.map((t) => structuredClone(t));
  }

  /** Resolve a template by name or alias (case-insensitive). */
  template(name: string): TemplateSpec {
    const found = findTemplate(name);
    if (!found) throw new Error(`Unknown strategy template "${name}". Available: ${TEMPLATES.map((t) => t.name).join(", ")}.`);
    return structuredClone(found);
  }

  /** BFExplorer create_strategy_settings: create-only; existing names are reported, not replaced. */
  create(items: Array<{ name: string; template: string; parameters?: Record<string, unknown> }>): Array<{ name: string; status: boolean; message?: string }> {
    const list: unknown[] = Array.isArray(items) ? items : [items];
    return list.map((raw) => {
      const item = (raw && typeof raw === "object" ? raw : {}) as { name?: unknown; template?: unknown; parameters?: unknown; description?: unknown };
      const name = typeof item.name === "string" ? item.name.trim() : String(item.name ?? "");
      try {
        if (name && this.exists(name)) {
          return {
            name,
            status: false,
            message: `A strategy setting named "${name}" already exists; create_strategy_settings never replaces settings (use save_strategy_settings with overwrite).`,
          };
        }
        const setting = this.build(item.name, item.template, item.parameters, item.description);
        this.deps.state.customStrategies.set(setting.name.toLowerCase(), setting);
        this.deps.state.changed();
        return { name: setting.name, status: true, message: `Created from template "${setting.template}".` };
      } catch (error) {
        return { name, status: false, message: (error as Error).message };
      }
    });
  }

  /** Create or (with overwrite) replace a custom setting. Built-in names require overwrite. */
  save(name: string, template: string, parameters: Record<string, unknown>, options: { description?: string; overwrite?: boolean } = {}): StrategySetting {
    const setting = this.build(name, template, parameters, options.description);
    const key = setting.name.toLowerCase();
    if (!options.overwrite) {
      if (this.isBuiltIn(setting.name)) {
        throw new Error(`"${setting.name}" is a built-in setting; pass overwrite: true to replace it with a custom one (deleting that restores the built-in).`);
      }
      if (this.deps.state.customStrategies.has(key)) throw new Error(`A custom setting named "${setting.name}" already exists; pass overwrite: true to replace it.`);
    }
    this.deps.state.customStrategies.set(key, setting);
    this.deps.state.changed();
    return structuredClone(setting);
  }

  /** Delete a custom setting (built-ins become visible again). */
  remove(name: string): boolean {
    const key = String(name ?? "").trim().toLowerCase();
    if (this.deps.state.customStrategies.delete(key)) {
      this.deps.state.changed();
      return true;
    }
    if (this.isBuiltIn(name)) throw new Error(`"${name}" is a built-in setting and cannot be deleted.`);
    return false;
  }

  private isBuiltIn(name: string): boolean {
    const wanted = String(name ?? "").trim().toLowerCase();
    return BUILT_IN_SETTINGS.some((s) => s.name.toLowerCase() === wanted || s.aliases?.some((a) => a.toLowerCase() === wanted));
  }

  private exists(name: string): boolean {
    return this.deps.state.customStrategies.has(name.trim().toLowerCase()) || this.isBuiltIn(name);
  }

  /** Validate a setting (unknown parameter names are rejected) and keep canonical names only. */
  private build(name: unknown, templateName: unknown, parameters: unknown, description?: unknown): StrategySetting {
    const settingName = typeof name === "string" ? name.trim() : "";
    if (!settingName) throw new Error("A strategy setting needs a name.");
    if (settingName.length > 100) throw new Error("Strategy setting names are limited to 100 characters.");
    const template = this.template(String(templateName ?? ""));
    let input = parameters;
    if (typeof input === "string") {
      try {
        input = input.trim() ? JSON.parse(input) : {};
      } catch (error) {
        throw new Error(`parameters must be a JSON object: ${(error as Error).message}`);
      }
    }
    const parsed = parseParameters(template, input as Record<string, unknown> | undefined);
    const problems = parameterProblems(template, resolveParameters(template, parsed));
    if (problems.length) throw new ParameterError(problems.join(" "));
    return {
      name: settingName,
      template: template.name,
      parameters: parsed,
      description: typeof description === "string" && description.trim() ? description.trim() : undefined,
    };
  }

  // ---------------------------------------------------------------- execution

  /**
   * Execute a setting on one or more selections. Parameter overrides accept BFExplorer's flat,
   * dotted ("OpenBetPosition.BetType") and nested forms; unknown keys reject the execution.
   */
  async execute(strategyName: string, marketId: string, selections: SelectionRef[], overrides: Record<string, unknown> = {}): Promise<ExecutionResult> {
    return (await this.executeIn(strategyName, marketId, selections, overrides, [])).result;
  }

  private async executeIn(strategyName: string, marketId: string, selections: SelectionRef[], overrides: Record<string, unknown>, stack: string[]): Promise<Run> {
    const run = new Run(blankResult(this.deps.exchange.mode, String(strategyName ?? ""), String(marketId ?? "")));
    try {
      await this.perform(run, strategyName, marketId, selections ?? [], overrides ?? {}, stack);
    } catch (error) {
      run.problem((error as Error).message);
    }
    run.finish();
    return run;
  }

  private async perform(run: Run, strategyName: string, marketId: string, selections: SelectionRef[], overrides: Record<string, unknown>, stack: string[]) {
    const r = run.result;
    const setting = this.get(strategyName);
    const template = this.template(setting.template);
    r.strategyName = setting.name;
    r.template = template.name;
    let values: Params;
    try {
      values = normaliseParameters(template, setting.parameters, overrides);
    } catch (error) {
      if (!(error instanceof ParameterError)) throw error;
      run.problem(`${error.message} Nothing was executed.`);
      return;
    }
    r.parameters = values;
    const id = assertMarketId(marketId);
    r.marketId = id;
    const targets = this.dedupe(run, selections);
    const catalogue = await this.deps.markets.getCatalogue(id);
    r.marketName = catalogue.marketName;
    r.eventName = catalogue.event?.name;
    for (const ref of targets) this.deps.markets.findRunner(catalogue, ref);

    if (template.name === TEMPLATE.sequence) return this.sequence(run, setting, values, id, catalogue, targets, stack);
    if (template.name === TEMPLATE.cancelBets) return this.cancelBets(run, values, id, catalogue, targets);

    const bettingType = catalogue.description?.bettingType ?? "ODDS";
    if (bettingType !== "ODDS") {
      run.problem(`${catalogue.marketName} is a ${bettingType} market; strategies only bet on fixed-odds (ODDS) markets. Nothing was executed.`);
      return;
    }
    const book = await this.deps.markets.getBook(id, { depth: 1 });
    if (book.status !== "OPEN") {
      run.problem(`The market is ${marketStatusName(book.status)}; no bets can be placed.`);
      return;
    }
    const market: MarketContext = { id, catalogue, book, ladder: ladderOf(catalogue), rules: await this.deps.exchange.currencyRules(), startMs: startOf(catalogue) };
    const reference = typeof values.StrategyReference === "string" && values.StrategyReference ? values.StrategyReference : this.deps.state.strategyRefFor(setting.name);
    const exec: Exec = { run, setting, template, values, tag: { name: setting.name, ref: reference }, market };
    switch (template.name) {
      case TEMPLATE.placeBet:
      case TEMPLATE.fillOrKill:
        return this.placeBets(exec, this.targets(exec, targets));
      case TEMPLATE.trade:
        return this.trade(exec, this.targets(exec, targets));
      case TEMPLATE.tickOffset:
        return this.tickOffset(exec, this.targets(exec, targets));
      case TEMPLATE.closeSelection:
        return this.closeSelection(exec, this.targets(exec, targets));
      case TEMPLATE.closeMarket:
        return this.closePositions(exec);
      case TEMPLATE.trailingStopLoss:
        return this.trailingStop(exec, this.targets(exec, targets));
      case TEMPLATE.dutching:
        return this.dutch(exec, targets);
      default:
        run.problem(`Template "${template.name}" cannot be executed.`);
    }
  }

  private nameOf(catalogue: MarketCatalogue, ref: SelectionRef): string {
    return catalogue.runners?.find((r) => sameSelection({ selectionId: r.selectionId, handicap: r.handicap }, ref))?.runnerName ?? selectionKey(ref);
  }

  private dedupe(run: Run, selections: SelectionRef[]): SelectionRef[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    const unique: SelectionRef[] = [];
    for (const ref of selections) {
      const key = selectionKey(ref);
      if (seen.has(key)) duplicates.add(key);
      else {
        seen.add(key);
        unique.push({ selectionId: ref.selectionId, handicap: ref.handicap });
      }
    }
    if (duplicates.size) run.note(`Duplicate selection${duplicates.size > 1 ? "s" : ""} ignored: ${[...duplicates].join(", ")}.`);
    return unique;
  }

  /** The given selections, or the Nth selection after sorting (ExecuteOnSelection). */
  private targets(exec: Exec, given: SelectionRef[]): SelectionRef[] {
    const { run, values, market } = exec;
    const n = Number(values.ExecuteOnSelection ?? 0);
    if (!n) {
      if (!given.length) run.problem("No selection given: pass a selectionId (or set ExecuteOnSelection).");
      return given;
    }
    const sorted = sortedSelections(market.catalogue, market.book, values.SortSelectionsBy);
    const pick = sorted[n - 1];
    if (!pick) {
      run.problem(`ExecuteOnSelection ${n}: the market has only ${sorted.length} active selection(s). Nothing was executed.`);
      return [];
    }
    run.note(`ExecuteOnSelection ${n} (${values.SortSelectionsBy}): ${pick.runnerName}.`);
    return [{ selectionId: pick.selectionId, handicap: pick.handicap }];
  }

  /** Epoch ms of a PlaceBetTimeSpan that is still in the future (undefined = place now). */
  private delayedUntil(exec: Exec, open: Params): number | undefined {
    const span = timeSpanMs(open.PlaceBetTimeSpan);
    if (span === undefined) return undefined;
    if (exec.market.startMs === undefined) throw new Error("PlaceBetTimeSpan needs the market start time, which Betfair did not provide.");
    const at = exec.market.startMs + span;
    return this.now() < at ? at : undefined;
  }

  private closeTime(exec: Exec, span: unknown): number | undefined {
    const ms = timeSpanMs(span);
    if (ms === undefined) return undefined;
    if (exec.market.startMs === undefined) throw new Error("ClosePositionTimeSpan needs the market start time, which Betfair did not provide.");
    return exec.market.startMs + ms;
  }

  private startBot(exec: Exec, ref: SelectionRef, meta: Pick<BotMeta, "kind" | "phase" | "scope"> & Partial<BotMeta>, message: string, betIds: string[] = []) {
    const name = this.nameOf(exec.market.catalogue, ref);
    const bot = this.deps.bots.start({
      strategyName: exec.setting.name,
      template: exec.template.name,
      marketId: exec.market.id,
      selection: ref,
      parameters: exec.values,
      betIds,
      meta: { ...meta, tag: exec.tag, ladder: exec.market.ladder, selectionName: name },
      message,
    });
    exec.run.botIds.push(bot.id);
    exec.run.note(`${name}: bot ${bot.id} started. ${message}`);
  }

  /** Plan and place one entry per selection (Place Bet parameter names). */
  private async placeEntries(exec: Exec, targets: SelectionRef[], open: Params): Promise<Entry[]> {
    const { run, market } = exec;
    const entries: Entry[] = [];
    let balance: number | undefined;
    for (const ref of targets) {
      const name = this.nameOf(market.catalogue, ref);
      if (open.StakeType === "BankrollPercentage" && balance === undefined) balance = (await this.deps.exchange.accountFunds()).availableToBetBalance;
      const plan = planEntry(open, { runner: runnerOf(market.book, ref), name, inPlay: Boolean(market.book.inplay), ladder: market.ladder, balance });
      if ("skip" in plan) {
        run.skip(plan.skip);
        continue;
      }
      if ("problem" in plan) {
        run.problem(plan.problem);
        continue;
      }
      const placements = await this.desk.place(market.id, [{ ...ref, ...plan, role: "entry", selectionName: name }], exec.tag, market.rules, market.ladder);
      run.placements(placements);
      if (placements[0].bet) entries.push({ ref, name, bet: placements[0].bet });
    }
    return entries;
  }

  // ---------------------------------------------------------------- templates

  /** Place Bet and Place Bet - Fill or Kill. */
  private async placeBets(exec: Exec, targets: SelectionRef[]) {
    const fillOrKill = exec.template.name === TEMPLATE.fillOrKill;
    const placeAt = this.delayedUntil(exec, exec.values);
    if (placeAt !== undefined) {
      for (const ref of targets) {
        this.startBot(
          exec,
          ref,
          { kind: fillOrKill ? "fillOrKill" : "place", phase: "waiting", scope: "own", placeAt },
          `Waiting to place the bet at ${new Date(placeAt).toISOString()} (PlaceBetTimeSpan ${exec.values.PlaceBetTimeSpan}).`,
        );
      }
      return;
    }
    const entries = await this.placeEntries(exec, targets, exec.values);
    if (fillOrKill) await this.fillOrKill(exec, entries);
  }

  /** Wait (polling about every second) for the bets to match, then cancel what is left. */
  private async fillOrKill(exec: Exec, entries: Entry[]) {
    const { run, market, values } = exec;
    const requested = timeSpanMs(values.BetMatchingTimeout) ?? DEFAULT_MATCHING_TIMEOUT_MS;
    const timeout = Math.min(Math.max(requested, 0), FILL_OR_KILL_MAX_MS);
    if (requested > FILL_OR_KILL_MAX_MS) run.note(`BetMatchingTimeout ${values.BetMatchingTimeout} is capped at 30 seconds.`);
    const update = (entry: Entry, order: OrderView) => {
      entry.bet.sizeMatched = order.sizeMatched;
      entry.bet.averagePriceMatched = order.averagePriceMatched ?? entry.bet.averagePriceMatched;
      const reported = run.result.bets.find((b) => b.betId === entry.bet.betId);
      if (reported) {
        reported.sizeMatched = entry.bet.sizeMatched;
        reported.averagePriceMatched = entry.bet.averagePriceMatched;
      }
    };
    let pending = entries.filter((e) => e.bet.status === "SUCCESS" && e.bet.betId && (e.bet.sizeMatched ?? 0) < e.bet.size - 1e-9);
    for (let left = timeout; pending.length && left > 0; ) {
      const step = Math.min(1000, left);
      left -= step;
      await this.sleep(step);
      const orders = await this.deps.exchange.currentOrders([market.id]);
      pending = pending.filter((entry) => {
        const order = orders.find((o) => o.betId === entry.bet.betId);
        if (order) update(entry, order);
        return Boolean(order && order.sizeRemaining > 0);
      });
    }
    if (!pending.length) {
      if (entries.some((e) => e.bet.status === "SUCCESS")) run.note("Fill or kill: nothing left unmatched.");
      return;
    }
    const ids = pending.map((e) => e.bet.betId!);
    const results = await this.deps.exchange.cancelOrders(market.id, ids);
    run.cancels(results, ids);
    const after = await this.deps.exchange.currentOrders([market.id]);
    for (const entry of pending) {
      const order = after.find((o) => o.betId === entry.bet.betId);
      if (order) update(entry, order);
      const result = results.find((x) => x.betId === entry.bet.betId);
      if (result && cancelSucceeded(result)) {
        run.note(
          `${entry.name}: fill or kill: ${round(entry.bet.sizeMatched ?? 0)} of ${entry.bet.size} matched within ${timeout / 1000} s; the unmatched ${round(result.sizeCancelled)} was cancelled.`,
        );
      }
    }
  }

  /** "Place Bet and Close Selection Bet Position": entry now (or later), then a managing bot. */
  private async trade(exec: Exec, targets: SelectionRef[]) {
    const { run, values, market } = exec;
    const open = groupValues(values, OPEN);
    const closeSpan = values[`${CLOSE}ClosePositionTimeSpan`];
    const closeAt = this.closeTime(exec, closeSpan);
    if (closeAt !== undefined && this.now() >= closeAt) {
      run.skip(`The close time (ClosePositionTimeSpan ${closeSpan} from the start) has already passed, so the trade was not opened.`);
      return;
    }
    const targetText = this.describeTargets(groupValues(values, CLOSE));
    const placeAt = this.delayedUntil(exec, open);
    if (placeAt !== undefined && closeAt !== undefined && placeAt >= closeAt) {
      run.problem(`OpenBetPosition.PlaceBetTimeSpan ${open.PlaceBetTimeSpan} is not before CloseBetPosition.ClosePositionTimeSpan ${closeSpan}: the trade would close before it opens. Nothing was executed.`);
      return;
    }
    if (placeAt !== undefined) {
      for (const ref of targets) {
        this.startBot(
          exec,
          ref,
          { kind: "trade", phase: "waiting", scope: "own", placeAt, closeAt },
          `Waiting to open the trade at ${new Date(placeAt).toISOString()}; then ${targetText}.`,
        );
      }
      return;
    }
    for (const { ref, name, bet } of await this.placeEntries(exec, targets, open)) {
      if (bet.status !== "SUCCESS" || !bet.betId) {
        if (bet.status === "UNKNOWN") run.note(`${name}: no bot was started because the entry's outcome is unknown; check get_current_orders and close manually if it exists.`);
        continue;
      }
      this.startBot(
        exec,
        ref,
        { kind: "trade", phase: "open", scope: "own", closeAt, placedInPlay: Boolean(market.book.inplay), entryBetIds: [bet.betId] },
        `Entry ${bet.side} ${bet.size} @ ${bet.price} (bet ${bet.betId}, matched ${round(bet.sizeMatched ?? 0)}); then ${targetText}.`,
        [bet.betId],
      );
    }
  }

  private describeTargets(close: Params): string {
    const parts: string[] = [];
    if (close.ClosePositionImmediately === true) parts.push("close as soon as matched");
    const unit = close.ProfitLossType === "Money" ? "" : close.ProfitLossType === "Percentage" ? "%" : " ticks";
    if (Number(close.Profit) > 0) parts.push(`profit target ${close.Profit}${unit}`);
    if (Number(close.Loss) > 0) parts.push(`stop-loss ${close.Loss}${unit}`);
    if (close.ClosePositionTimeSpan) parts.push(`close at ${close.ClosePositionTimeSpan} from the start`);
    const how = close.HedgingEnabled === false ? "offset the matched stake" : "green up";
    return parts.length ? `${how} on: ${parts.join(", ")}` : `no exit condition is set (${how} only when stopped with closePosition)`;
  }

  /** Tick Offset: entry plus a resting offset bet Profit ticks better for its matched part. */
  private async tickOffset(exec: Exec, targets: SelectionRef[]) {
    const { run, values, market } = exec;
    const ticks = Number(values.Profit);
    for (const { ref, name, bet } of await this.placeEntries(exec, targets, values)) {
      if (bet.status !== "SUCCESS") continue;
      const matched = bet.sizeMatched ?? 0;
      const average = bet.averagePriceMatched;
      if (matched < 0.01 || !average) {
        run.note(`${name}: the entry is not matched yet, so no offset bet was placed; use Close Selection Bet Position to exit later.`);
        continue;
      }
      const entryTick = roundToTick(average, "nearest", market.ladder);
      const exitPrice = offsetTicks(entryTick, bet.side === "BACK" ? -ticks : ticks, market.ladder);
      const better = bet.side === "BACK" ? exitPrice < average - 1e-9 : exitPrice > average + 1e-9;
      if (!better) {
        run.problem(`${name}: no price ${ticks} ticks better than ${round(average)} exists on the ladder; the entry has no offset bet.`);
        continue;
      }
      const offset: PlannedOrder = {
        ...ref,
        side: opposite(bet.side),
        price: exitPrice,
        size: round((matched * average) / exitPrice)!,
        persistenceType: persistence(values.AtInPlayKeepBet),
        reducesRisk: true,
        role: "offset",
        selectionName: name,
      };
      run.placements(await this.desk.place(market.id, [offset], exec.tag, market.rules, market.ladder));
      if (matched < bet.size - 1e-9) run.note(`${name}: only ${round(matched)} of ${bet.size} matched; the offset covers the matched part.`);
    }
  }

  private async closeSelection(exec: Exec, targets: SelectionRef[]) {
    if (!targets.length) return;
    const { run, values, market } = exec;
    if (values.ClosePositionImmediately !== false) return this.closePositions(exec, targets);
    const closeAt = this.closeTime(exec, values.ClosePositionTimeSpan);
    const orders = await this.deps.exchange.currentOrders([market.id]);
    for (const ref of targets) {
      const name = this.nameOf(market.catalogue, ref);
      const mine = orders.filter((o) => o.selectionId === selectionKey(ref));
      const position = positionOf(mine);
      if (isFlatAt(position, values.HedgingEnabled !== false, runnerOf(market.book, ref)) && !mine.some((o) => o.sizeRemaining > 0)) {
        run.skip(`${name}: no open position to manage (${mine.length ? `already flat: ${describePosition(position)}` : "no bets"}).`);
        continue;
      }
      this.startBot(
        exec,
        ref,
        { kind: "close", phase: "monitoring", scope: "selection", closeAt },
        `Managing the selection's position (${describePosition(position)}): ${this.describeTargets(values)}.`,
      );
    }
  }

  private async trailingStop(exec: Exec, targets: SelectionRef[]) {
    const { run, values, market } = exec;
    if (!targets.length) return;
    const orders = await this.deps.exchange.currentOrders([market.id]);
    for (const ref of targets) {
      const name = this.nameOf(market.catalogue, ref);
      const mine = orders.filter((o) => o.selectionId === selectionKey(ref));
      const position = positionOf(mine);
      const runner = runnerOf(market.book, ref);
      const flat = isFlatAt(position, values.HedgingEnabled !== false, runner);
      if (flat && !mine.some((o) => o.sizeRemaining > 0)) {
        run.skip(`${name}: no position to protect with a trailing stop.`);
        continue;
      }
      // The trail starts from the price the position could be closed at now.
      const long = position.ifWin > position.ifLose;
      const best = bestPrices(runner);
      const price = flat ? undefined : long ? best.lay : best.back;
      this.startBot(
        exec,
        ref,
        { kind: "trailing", phase: "monitoring", scope: "selection", trailSide: flat ? undefined : long ? "BACK" : "LAY", bestPrice: price },
        `Trailing stop ${values.Loss} ticks on the selection's position (${describePosition(position)})${price ? `, starting from the price ${price}` : ""}.`,
      );
    }
  }

  /**
   * Close Selection (immediate) and Close Market: cancel unmatched bets (every cancel must
   * succeed), re-read the orders, then hedge each matched position at the best opposite price.
   * A selection is not hedged while unmatched bets on the hedge side still rest.
   */
  private closePositions(exec: Exec, targets?: SelectionRef[]): Promise<void> {
    return this.deps.bots.exclusive(() => this.closeNow(exec, targets));
  }

  private async closeNow(exec: Exec, targets?: SelectionRef[]) {
    const { run, values, market } = exec;
    const hedging = values.HedgingEnabled !== false;
    const wanted = targets ? new Set(targets.map(selectionKey)) : undefined;
    let orders = await this.deps.exchange.currentOrders([market.id]);
    const blocked = new Map<string, string>();
    if (values.CancelUnmatchedBets !== false) {
      const resting = orders.filter((o) => (!wanted || wanted.has(o.selectionId)) && o.sizeRemaining > 0);
      if (resting.length) {
        const ids = resting.map((o) => o.betId);
        const results = await this.deps.exchange.cancelOrders(market.id, ids);
        run.cancels(results, ids);
        for (const o of resting) {
          const result = results.find((r) => r.betId === o.betId);
          if (!result || !cancelSucceeded(result)) blocked.set(o.selectionId, `cancelling unmatched bet ${o.betId} failed (${result?.status ?? "no result"})`);
        }
        orders = await this.deps.exchange.currentOrders([market.id]);
      }
    }
    const keys = wanted ? [...wanted] : [...new Set(orders.map((o) => o.selectionId))];
    const hedges: PlannedOrder[] = [];
    let needed = 0;
    let failed = 0;
    let belowMinimum = 0;
    for (const key of keys) {
      const ref = parseSelectionId(key);
      const name = this.nameOf(market.catalogue, ref);
      const mine = orders.filter((o) => o.selectionId === key);
      const position = positionOf(mine);
      const flat = () => {
        if (wanted) run.skip(`${name}: ${mine.some((o) => o.sizeMatched > 0) ? `already flat (${describePosition(position)})` : "no matched bets"}; nothing to close.`);
      };
      if (isFlat(position, hedging)) {
        flat();
        continue;
      }
      const fail = (why: string) => {
        failed++;
        run.problem(`${name}: ${why}; the position (${describePosition(position)}) was not closed.`);
      };
      const runner = runnerOf(market.book, ref);
      if (!runner || runner.status !== "ACTIVE") {
        run.note(`${name}: the selection is ${runnerStatusName(runner?.status) ?? "not in the market"}; Betfair voids a non-runner's bets, so there is nothing to close.`);
        continue;
      }
      needed++;
      if (blocked.has(key)) {
        fail(blocked.get(key)!);
        continue;
      }
      const best = bestPrices(runner);
      let order: ReturnType<typeof closeOrder>;
      try {
        order = closeOrder(position, hedging, best.back, best.lay);
      } catch (error) {
        fail(`the open position could not be priced (${(error as Error).message})`);
        continue;
      }
      if (!order) {
        needed--;
        flat(); // the hedge rounds to less than a cent
        continue;
      }
      if (order.note) run.note(`${name}: ${order.note}.`);
      const resting = mine.filter((o) => o.sizeRemaining > 0 && o.side === order.side);
      if (resting.length) {
        const remaining = round(sum(resting.map((o) => o.sizeRemaining)));
        fail(`unmatched ${order.side} bet(s) ${resting.map((o) => o.betId).join(", ")} (${remaining} unmatched) would over-hedge the position when matched; cancel them first (CancelUnmatchedBets true)`);
        continue;
      }
      const tooSmall = betSizeProblem(order.size, order.price, market.rules);
      if (tooSmall) {
        belowMinimum++;
        run.note(`${name}: the closing bet ${order.side} ${order.size} @ ${order.price} was not sent: ${tooSmall} The position (${describePosition(position)}) stays open.`);
        continue;
      }
      hedges.push({ ...ref, side: order.side, price: order.price, size: order.size, persistenceType: "LAPSE", reducesRisk: true, role: "hedge", selectionName: name });
    }
    let hedged = 0;
    if (hedges.length) {
      const placements = await this.desk.place(market.id, hedges, exec.tag, market.rules, market.ladder);
      run.placements(placements);
      hedged = placements.filter((p) => p.bet?.status === "SUCCESS").length;
      failed += placements.filter((p) => !p.bet || p.bet.status === "FAILURE").length;
    }
    if (!needed) {
      if (!wanted) run.skip("No open matched position in this market; nothing to close.");
    } else if (!wanted || wanted.size > 1) {
      const small = belowMinimum ? `, ${belowMinimum} below Betfair's minimum bet` : "";
      run.note(`${needed} position(s) needed a hedge: ${hedged} hedged, ${failed} failed${small}.`);
    }
  }

  /** Place Dutching Bets: all legs are checked first; one bad leg places nothing. */
  private async dutch(exec: Exec, given: SelectionRef[]) {
    const { run, values, market } = exec;
    let legs = given;
    const on = String(values.OnSelections ?? "").trim();
    if (on) {
      const sorted = sortedSelections(market.catalogue, market.book, values.SortSelectionsBy);
      const positions = on.split(",").map((s) => Number(s.trim()));
      const unique = [...new Set(positions)];
      if (unique.length < positions.length) run.note("Duplicate OnSelections positions ignored.");
      const missing = unique.filter((i) => !sorted[i - 1]);
      if (missing.length) {
        run.problem(`OnSelections ${missing.join(", ")}: the market has only ${sorted.length} active selection(s). No bet was placed.`);
        return;
      }
      legs = unique.map((i) => ({ selectionId: sorted[i - 1].selectionId, handicap: sorted[i - 1].handicap }));
      run.note(`OnSelections ${on} (${values.SortSelectionsBy}): ${legs.map((ref) => this.nameOf(market.catalogue, ref)).join(", ")}.`);
    }
    if (!legs.length) {
      run.problem("No selections to dutch: pass selectionIds or set OnSelections.");
      return;
    }
    const invalid: string[] = [];
    const prices: number[] = [];
    for (const ref of legs) {
      const name = this.nameOf(market.catalogue, ref);
      const runner = runnerOf(market.book, ref);
      const price = bestPrices(runner).back;
      if (!runner || runner.status !== "ACTIVE") invalid.push(`${name}: the selection is not active`);
      else if (!price) invalid.push(`${name}: no back price`);
      else if (price > Number(values.MaximumOdds) + 1e-9) invalid.push(`${name}: price ${price} is above MaximumOdds ${values.MaximumOdds}`);
      else prices.push(price);
    }
    if (invalid.length) {
      run.problem(`Dutch not placed (every leg must be valid): ${invalid.join("; ")}.`);
      return;
    }
    let stakes: number[];
    try {
      stakes = dutchStakes(prices, values.DutchingType === "TotalStake" ? "TotalStake" : "RequiredProfit", Number(values.TargetValue));
    } catch (error) {
      run.problem(`${(error as Error).message} No bet was placed.`);
      return;
    }
    const orders: PlannedOrder[] = legs.map((ref, i) => ({
      ...ref,
      side: "BACK",
      price: prices[i],
      size: stakes[i],
      persistenceType: persistence(values.AtInPlayKeepBet),
      role: "dutch",
      selectionName: this.nameOf(market.catalogue, ref),
    }));
    const problems: string[] = [];
    for (const order of orders) {
      const problem = this.desk.problem(order, market.rules, market.ladder);
      if (!problem) continue;
      run.reject(order, problem);
      problems.push(`${order.selectionName}: ${order.size} @ ${order.price}: ${problem}`);
    }
    const total = sum(stakes);
    if (total > this.deps.limits.maxLiability + 1e-9) {
      problems.push(`the total stake ${round(total)} (lost if none of them wins) exceeds MAX_LIABILITY ${this.deps.limits.maxLiability}`);
    }
    if (problems.length) {
      run.problem(`Dutch not placed (every leg must pass the checks): ${problems.join("; ")}.`);
      return;
    }
    run.placements(await this.desk.place(market.id, orders, exec.tag, market.rules, market.ladder));
    const worst = Math.min(...orders.map((o) => o.size * o.price)) - total;
    run.note(`Dutch on ${orders.length} selection(s): total stake ${round(total)}, profit at least ${round(worst)} if any of them wins.`);
  }

  private async cancelBets(run: Run, values: Params, marketId: string, catalogue: MarketCatalogue, targets: SelectionRef[]) {
    const marketScope = values.Scope === "Market";
    if (!marketScope && !targets.length) {
      run.problem("No selection given: pass a selectionId, or use Scope Market.");
      return;
    }
    const keys = new Set(targets.map(selectionKey));
    const orders = await this.deps.exchange.currentOrders([marketId]);
    const resting = orders.filter((o) => o.sizeRemaining > 0 && (marketScope || keys.has(o.selectionId)));
    if (!resting.length) {
      run.skip(marketScope ? "No unmatched bets in this market." : `No unmatched bets on ${targets.map((ref) => this.nameOf(catalogue, ref)).join(", ")}.`);
      return;
    }
    const ids = resting.map((o) => o.betId);
    run.cancels(await this.deps.exchange.cancelOrders(marketId, ids), ids);
  }

  /** Sequence Execution: every step is validated first, then run in order until one fails. */
  private async sequence(run: Run, setting: StrategySetting, values: Params, marketId: string, catalogue: MarketCatalogue, targets: SelectionRef[], stack: string[]) {
    const chain = [...stack, setting.name.toLowerCase()];
    if (chain.length > MAX_SEQUENCE_DEPTH) {
      run.problem(`Sequence Execution nested more than ${MAX_SEQUENCE_DEPTH} levels deep; nothing was executed.`);
      return;
    }
    let selections = targets;
    const n = Number(values.ExecuteOnSelection ?? 0);
    if (n) {
      const book = await this.deps.markets.getBook(marketId, { depth: 1 });
      const pick = sortedSelections(catalogue, book, values.SortSelectionsBy)[n - 1];
      if (!pick) {
        run.problem(`ExecuteOnSelection ${n}: the market does not have that many active selections. Nothing was executed.`);
        return;
      }
      selections = [{ selectionId: pick.selectionId, handicap: pick.handicap }];
      run.note(`ExecuteOnSelection ${n} (${values.SortSelectionsBy}): ${pick.runnerName}.`);
    }
    const steps: StrategySetting[] = [];
    for (const name of String(values.StrategyNames).split(";").map((s) => s.trim()).filter(Boolean)) {
      try {
        const step = this.get(name);
        if (chain.includes(step.name.toLowerCase())) throw new Error(`"${step.name}" would run itself recursively`);
        normaliseParameters(this.template(step.template), step.parameters);
        steps.push(step);
      } catch (error) {
        run.problem(`Step "${name}": ${(error as Error).message}`);
      }
    }
    if (run.problems.length) {
      run.problem("Nothing was executed.");
      return;
    }
    for (const [i, step] of steps.entries()) {
      const sub = await this.executeIn(step.name, marketId, selections, {}, chain);
      const r = sub.result;
      run.result.bets.push(...r.bets);
      run.result.cancelled.push(...r.cancelled);
      run.rejected.push(...sub.rejected);
      run.botIds.push(...sub.botIds);
      run.done += sub.done;
      run.uncertain += sub.uncertain;
      run.note(`${step.name}: ${r.outcome}.`);
      for (const message of r.messages) run.note(`${step.name}: ${message}`);
      if (!r.status) {
        const rest = steps.slice(i + 1).map((s) => s.name);
        if (rest.length) run.note(`Not executed: ${rest.join(", ")}.`);
        run.failedStep = `Step "${step.name}" failed: ${r.message}`;
        return;
      }
      run.problems.push(...sub.problems.map((p) => `${step.name}: ${p}`));
      run.skips.push(...sub.skips.map((s) => `${step.name}: ${s}`));
    }
  }
}
