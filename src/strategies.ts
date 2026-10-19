import type { Config } from "./config.js";
import type { MarketBook, MarketCatalogue, PersistenceType, Runner, Side } from "./betfair/types.js";
import { isValidPrice, offsetTicks, roundForSide, roundToTick } from "./betfair/ticks.js";
import { betOutcomeProfit, type Exchange, type OrderRequest, type OrderView, type PlacedBet } from "./exchange.js";
import { formatSelectionId, round, type MarketService, type SelectionRef } from "./markets.js";
import type { State } from "./state.js";

export type TemplateName =
  | "Place Bet"
  | "Tick Offset"
  | "Close Selection Bet Position"
  | "Close Market Bet Position"
  | "Cancel Bets"
  | "Dutching";

export interface StrategySetting {
  name: string;
  template: TemplateName;
  parameters: Record<string, unknown>;
  description?: string;
  builtIn?: boolean;
}

interface ParameterSpec {
  name: string;
  type: "number" | "boolean" | "enum";
  default: number | boolean | string;
  values?: string[];
  description: string;
}

const PLACE_BET_PARAMETERS: ParameterSpec[] = [
  { name: "BetType", type: "enum", values: ["Back", "Lay"], default: "Back", description: "Back or lay the selection." },
  { name: "Stake", type: "number", default: 10, description: "Amount in account currency, interpreted according to StakeType." },
  {
    name: "StakeType",
    type: "enum",
    values: ["Stake", "Liability", "BankrollPercentage"],
    default: "Stake",
    description: "Stake = backer's stake; Liability = maximum loss; BankrollPercentage = percent of available balance used as stake (back) or liability (lay).",
  },
  { name: "Odds", type: "number", default: 0, description: "Limit price. 0 = take the best price currently available." },
  { name: "OddsOffsetTicks", type: "number", default: 0, description: "Ask for a better price by this many ticks (offer the bet instead of taking)." },
  { name: "MinimumOdds", type: "number", default: 1.01, description: "Skip if the bet price is below this." },
  { name: "MaximumOdds", type: "number", default: 1000, description: "Skip if the bet price is above this." },
  { name: "PersistenceType", type: "enum", values: ["Lapse", "Persist"], default: "Lapse", description: "What happens to unmatched money when the market turns in-play." },
  { name: "AllowPlacingBetInPlay", type: "boolean", default: true, description: "Allow placing the bet when the market is in-play." },
];

export const TEMPLATES: Record<TemplateName, { description: string; parameters: ParameterSpec[] }> = {
  "Place Bet": {
    description: "Place a single back or lay bet on the selection.",
    parameters: PLACE_BET_PARAMETERS,
  },
  "Tick Offset": {
    description:
      "Trade: place the entry bet, then for the matched part immediately place an opposite (offset) bet ProfitTicks better, sized to green up for equal profit.",
    parameters: [
      ...PLACE_BET_PARAMETERS,
      { name: "ProfitTicks", type: "number", default: 2, description: "Ticks of price movement targeted by the offset bet." },
      { name: "ExitPersistenceType", type: "enum", values: ["Lapse", "Persist"], default: "Lapse", description: "Persistence of the offset bet." },
    ],
  },
  "Close Selection Bet Position": {
    description: "Cancel unmatched bets on the selection and hedge (green up) the matched position at the best available price.",
    parameters: [
      { name: "CancelUnmatchedBets", type: "boolean", default: true, description: "Cancel unmatched bets on the selection first." },
    ],
  },
  "Close Market Bet Position": {
    description: "Cancel unmatched bets in the market and hedge every selection's matched position at the best available prices.",
    parameters: [
      { name: "CancelUnmatchedBets", type: "boolean", default: true, description: "Cancel unmatched bets in the market first." },
    ],
  },
  "Cancel Bets": {
    description: "Cancel unmatched bets on the selection or the whole market.",
    parameters: [{ name: "Scope", type: "enum", values: ["Selection", "Market"], default: "Selection", description: "What to cancel." }],
  },
  Dutching: {
    description: "Back several selections so that the same profit (or a fixed total stake) results whichever of them wins. Use with ExecuteBfexplorerStrategySettingsOnSelections.",
    parameters: [
      { name: "DutchingType", type: "enum", values: ["Profit", "Stake"], default: "Profit", description: "Profit = target profit if any selection wins; Stake = total stake to split." },
      { name: "Amount", type: "number", default: 10, description: "Target profit or total stake in account currency." },
      { name: "MaximumOdds", type: "number", default: 1000, description: "Skip selections priced above this." },
      { name: "PersistenceType", type: "enum", values: ["Lapse", "Persist"], default: "Lapse", description: "Persistence of the dutch bets." },
    ],
  },
};

export const BUILT_IN_STRATEGIES: StrategySetting[] = [
  { name: "Bet 10 Euro", template: "Place Bet", parameters: { BetType: "Back", Stake: 10 }, description: "Back the selection for 10 at the best available price." },
  { name: "Lay 10 Euro", template: "Place Bet", parameters: { BetType: "Lay", Stake: 10 }, description: "Lay the selection for a backer's stake of 10 at the best available price." },
  { name: "Bet 2 Euro", template: "Place Bet", parameters: { BetType: "Back", Stake: 2 }, description: "Back the selection for 2 at the best available price." },
  { name: "Lay 2 Euro", template: "Place Bet", parameters: { BetType: "Lay", Stake: 2 }, description: "Lay the selection for a backer's stake of 2 at the best available price." },
  { name: "Back Trade", template: "Tick Offset", parameters: { BetType: "Back", Stake: 10, ProfitTicks: 2 }, description: "Back 10 and offset with a lay 2 ticks lower." },
  { name: "Lay Trade", template: "Tick Offset", parameters: { BetType: "Lay", Stake: 10, ProfitTicks: 2 }, description: "Lay 10 and offset with a back 2 ticks higher." },
  { name: "Close Selection Bet Position", template: "Close Selection Bet Position", parameters: {}, description: "Green up the selection." },
  { name: "Close Market Bet Position", template: "Close Market Bet Position", parameters: {}, description: "Green up every selection in the market." },
  { name: "Cancel Selection Bets", template: "Cancel Bets", parameters: { Scope: "Selection" }, description: "Cancel unmatched bets on the selection." },
  { name: "Cancel Market Bets", template: "Cancel Bets", parameters: { Scope: "Market" }, description: "Cancel unmatched bets in the market." },
  { name: "Dutch to profit 10 Euro", template: "Dutching", parameters: { DutchingType: "Profit", Amount: 10 }, description: "Dutch the given selections to win 10 whichever wins." },
  { name: "Dutch 10 Euro stake", template: "Dutching", parameters: { DutchingType: "Stake", Amount: 10 }, description: "Split a total stake of 10 across the given selections for equal profit." },
].map((s) => ({ ...s, template: s.template as TemplateName, builtIn: true }));

/** Validate and normalise parameters against the template (case-insensitive names). */
export function normaliseParameters(template: TemplateName, input: Record<string, unknown>) {
  const specs = TEMPLATES[template].parameters;
  const values: Record<string, number | boolean | string> = Object.fromEntries(specs.map((p) => [p.name, p.default]));
  const unknown: string[] = [];
  for (const [rawKey, raw] of Object.entries(input)) {
    const spec = specs.find((p) => p.name.toLowerCase() === rawKey.toLowerCase());
    if (!spec) {
      unknown.push(rawKey);
      continue;
    }
    if (spec.type === "number") {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Parameter ${spec.name} must be a non-negative number, got ${JSON.stringify(raw)}.`);
      values[spec.name] = n;
    } else if (spec.type === "boolean") {
      values[spec.name] = raw === true || String(raw).toLowerCase() === "true";
    } else {
      const match = spec.values!.find((v) => v.toLowerCase() === String(raw).toLowerCase());
      if (!match) throw new Error(`Parameter ${spec.name} must be one of ${spec.values!.join(", ")}, got ${JSON.stringify(raw)}.`);
      values[spec.name] = match;
    }
  }
  return { values, unknown };
}

export interface ExecutionResult {
  mode: "paper" | "live";
  strategyName: string;
  template: TemplateName;
  marketId: string;
  marketName: string;
  eventName?: string;
  status: "Executed" | "PartiallyExecuted" | "Skipped" | "Failed";
  messages: string[];
  bets: Array<PlacedBet & { selectionName?: string; role?: string }>;
  cancelled: Array<{ betId: string; sizeCancelled: number; status: string }>;
  parameters: Record<string, unknown>;
  ignoredParameters?: string[];
}

const persistence = (value: unknown): PersistenceType => (value === "Persist" ? "PERSIST" : "LAPSE");
const floor2 = (value: number) => Math.floor(value * 100 + 1e-6) / 100;

interface Position {
  ifWin: number;
  ifLose: number;
}

export function selectionPositions(orders: OrderView[]): Map<string, Position> {
  const positions = new Map<string, Position>();
  for (const o of orders) {
    if (!o.sizeMatched || !o.averagePriceMatched) continue;
    const p = positions.get(o.selectionId) ?? { ifWin: 0, ifLose: 0 };
    p.ifWin += betOutcomeProfit(o.side, o.averagePriceMatched, o.sizeMatched, true);
    p.ifLose += betOutcomeProfit(o.side, o.averagePriceMatched, o.sizeMatched, false);
    positions.set(o.selectionId, p);
  }
  return positions;
}

/** Stake (and side) that equalises profit whether the selection wins or loses, at the given hedge prices. */
export function hedgeOrder(position: Position, backPrice?: number, layPrice?: number): { side: Side; price: number; size: number } | undefined {
  const diff = position.ifWin - position.ifLose;
  if (Math.abs(diff) < 0.01) return undefined;
  if (diff > 0) {
    if (!layPrice) throw new Error("No lay price available to hedge the position.");
    return { side: "LAY", price: layPrice, size: round(diff / layPrice)! };
  }
  if (!backPrice) throw new Error("No back price available to hedge the position.");
  return { side: "BACK", price: backPrice, size: round(-diff / backPrice)! };
}

/** Stakes for dutching across selections at the given prices. */
export function dutchStakes(prices: number[], type: "Profit" | "Stake", amount: number): number[] {
  const book = prices.reduce((total, p) => total + 1 / p, 0);
  if (type === "Stake") return prices.map((p) => floor2((amount / p) / book));
  if (book >= 1) {
    throw new Error(`These selections' prices sum to a ${(book * 100).toFixed(1)}% book, so no dutch can guarantee a profit.`);
  }
  const totalStake = (amount * book) / (1 - book);
  return prices.map((p) => floor2((amount + totalStake) / p));
}

export class StrategyEngine {
  constructor(
    private readonly markets: MarketService,
    private readonly exchange: Exchange,
    private readonly state: State,
    private readonly limits: Config["trading"],
  ) {}

  list(): StrategySetting[] {
    const custom = [...this.state.customStrategies.values()];
    const overridden = new Set(custom.map((s) => s.name.toLowerCase()));
    return [...BUILT_IN_STRATEGIES.filter((s) => !overridden.has(s.name.toLowerCase())), ...custom];
  }

  get(name: string): StrategySetting {
    const wanted = name.trim().toLowerCase();
    const found = this.state.customStrategies.get(wanted) ?? BUILT_IN_STRATEGIES.find((s) => s.name.toLowerCase() === wanted);
    if (!found) {
      throw new Error(`Strategy "${name}" not found. Available: ${this.list().map((s) => s.name).join(", ")}. Create one with SaveBfexplorerStrategySettings.`);
    }
    return found;
  }

  save(name: string, template: string, parameters: Record<string, unknown>, description?: string): StrategySetting {
    const templateName = (Object.keys(TEMPLATES) as TemplateName[]).find((t) => t.toLowerCase() === template.trim().toLowerCase());
    if (!templateName) throw new Error(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(", ")}.`);
    const { values, unknown } = normaliseParameters(templateName, parameters);
    if (unknown.length) throw new Error(`Unknown parameters for ${templateName}: ${unknown.join(", ")}.`);
    const setting: StrategySetting = { name: name.trim(), template: templateName, parameters: values, description };
    this.state.customStrategies.set(setting.name.toLowerCase(), setting);
    this.state.changed();
    return setting;
  }

  async execute(strategyName: string, marketId: string, selections: SelectionRef[], overrides: Record<string, unknown> = {}): Promise<ExecutionResult> {
    const strategy = this.get(strategyName);
    const { values, unknown } = normaliseParameters(strategy.template, { ...strategy.parameters, ...overrides });
    const catalogue = await this.markets.getCatalogue(marketId);
    for (const ref of selections) this.markets.findRunner(catalogue, ref);
    const result: ExecutionResult = {
      mode: this.exchange.mode,
      strategyName: strategy.name,
      template: strategy.template,
      marketId: catalogue.marketId,
      marketName: catalogue.marketName,
      eventName: catalogue.event?.name,
      status: "Executed",
      messages: [],
      bets: [],
      cancelled: [],
      parameters: values,
      ...(unknown.length ? { ignoredParameters: unknown } : {}),
    };
    const book = await this.markets.getBook(catalogue.marketId, ["EX_BEST_OFFERS"], 3);
    if (book.status !== "OPEN") {
      return { ...result, status: "Failed", messages: [`Market is ${book.status.toLowerCase()}; no bets can be placed.`] };
    }

    switch (strategy.template) {
      case "Place Bet":
      case "Tick Offset":
        for (const ref of selections) await this.placeBet(strategy, values, catalogue, book, ref, result);
        break;
      case "Close Selection Bet Position":
        await this.closePositions(strategy, values, catalogue, book, selections, result);
        break;
      case "Close Market Bet Position":
        await this.closePositions(strategy, values, catalogue, book, undefined, result);
        break;
      case "Cancel Bets":
        await this.cancel(values, catalogue.marketId, values.Scope === "Market" ? undefined : selections, result);
        break;
      case "Dutching":
        await this.dutch(strategy, values, catalogue, book, selections, result);
        break;
    }

    const failed = result.bets.filter((b) => b.status !== "SUCCESS").length;
    if (result.status === "Executed") {
      if (failed && failed === result.bets.length) result.status = "Failed";
      else if (failed) result.status = "PartiallyExecuted";
      else if (!result.bets.length && !result.cancelled.length) result.status = "Skipped";
    }
    return result;
  }

  private runnerOf(book: MarketBook, ref: SelectionRef): Runner | undefined {
    return book.runners.find((r) => r.selectionId === ref.selectionId && r.handicap === ref.handicap);
  }

  private nameOf(catalogue: MarketCatalogue, ref: SelectionRef) {
    return catalogue.runners?.find((r) => r.selectionId === ref.selectionId && r.handicap === ref.handicap)?.runnerName;
  }

  /** Enforce MAX_STAKE / MAX_LIABILITY on bets that add risk. */
  private checkLimits(order: OrderRequest): string | undefined {
    const liability = order.side === "BACK" ? order.size : order.size * (order.price - 1);
    if (order.side === "BACK" && order.size > this.limits.maxStake) {
      return `Stake ${order.size} exceeds MAX_STAKE ${this.limits.maxStake}.`;
    }
    if (liability > this.limits.maxLiability) {
      return `Liability ${round(liability)} exceeds MAX_LIABILITY ${this.limits.maxLiability}.`;
    }
    if (order.size < 0.01) return "Stake rounds to zero.";
    return undefined;
  }

  private async submit(
    marketId: string,
    strategyName: string,
    catalogue: MarketCatalogue,
    orders: Array<OrderRequest & { role?: string; reducesRisk?: boolean }>,
    result: ExecutionResult,
  ): Promise<PlacedBet[]> {
    const allowed: typeof orders = [];
    for (const order of orders) {
      const ref = { selectionId: order.selectionId, handicap: order.handicap };
      const problem = order.reducesRisk ? (order.size < 0.01 ? "Stake rounds to zero." : undefined) : this.checkLimits(order);
      if (problem) {
        result.messages.push(`${this.nameOf(catalogue, ref)}: ${problem} Bet not placed.`);
        result.status = "Failed";
        continue;
      }
      allowed.push(order);
    }
    if (!allowed.length) return [];
    const placed = await this.exchange.placeOrders(marketId, allowed, strategyName);
    placed.forEach((bet, i) => {
      result.bets.push({
        ...bet,
        selectionName: this.nameOf(catalogue, { selectionId: allowed[i].selectionId, handicap: allowed[i].handicap }),
        role: allowed[i].role,
      });
    });
    return placed;
  }

  private async placeBet(
    strategy: StrategySetting,
    p: Record<string, number | boolean | string>,
    catalogue: MarketCatalogue,
    book: MarketBook,
    ref: SelectionRef,
    result: ExecutionResult,
  ) {
    const name = this.nameOf(catalogue, ref);
    const runner = this.runnerOf(book, ref);
    if (!runner || runner.status !== "ACTIVE") {
      result.messages.push(`${name}: selection is not active.`);
      return;
    }
    if (book.inplay && p.AllowPlacingBetInPlay === false) {
      result.messages.push(`${name}: market is in-play and AllowPlacingBetInPlay is false.`);
      return;
    }
    const side: Side = p.BetType === "Lay" ? "LAY" : "BACK";
    const best = side === "BACK" ? runner.ex?.availableToBack?.[0]?.price : runner.ex?.availableToLay?.[0]?.price;
    let price = Number(p.Odds) > 0 ? roundForSide(Number(p.Odds), side) : best;
    if (!price) {
      result.messages.push(`${name}: no ${side === "BACK" ? "back" : "lay"} price available.`);
      return;
    }
    const offset = Math.trunc(Number(p.OddsOffsetTicks));
    if (offset) price = offsetTicks(price, side === "BACK" ? offset : -offset);
    if (price < Number(p.MinimumOdds) || price > Number(p.MaximumOdds)) {
      result.messages.push(`${name}: price ${price} is outside the allowed range ${p.MinimumOdds}-${p.MaximumOdds}; no bet placed.`);
      return;
    }

    const amount = Number(p.Stake);
    let size: number;
    if (p.StakeType === "Liability") size = side === "BACK" ? amount : amount / (price - 1);
    else if (p.StakeType === "BankrollPercentage") {
      const funds = await this.exchange.accountFunds();
      const budget = (funds.availableToBetBalance * amount) / 100;
      size = side === "BACK" ? budget : budget / (price - 1);
    } else size = amount;
    size = floor2(size);

    const [entry] = await this.submit(
      catalogue.marketId,
      strategy.name,
      catalogue,
      [{ ...ref, side, price, size, persistenceType: persistence(p.PersistenceType), role: strategy.template === "Tick Offset" ? "entry" : undefined }],
      result,
    );
    if (strategy.template !== "Tick Offset" || !entry || entry.status !== "SUCCESS") return;

    const matched = entry.sizeMatched ?? 0;
    if (matched <= 0 || !entry.averagePriceMatched) {
      result.messages.push(`${name}: entry bet is unmatched, so no offset bet was placed yet. Re-run "Close Selection Bet Position" later to exit.`);
      return;
    }
    const entryPrice = roundToTick(entry.averagePriceMatched);
    const ticks = Math.max(1, Math.trunc(Number(p.ProfitTicks)));
    const exitSide: Side = side === "BACK" ? "LAY" : "BACK";
    const exitPrice = offsetTicks(entryPrice, side === "BACK" ? -ticks : ticks);
    if (!isValidPrice(exitPrice) || exitPrice === entryPrice) {
      result.messages.push(`${name}: cannot offset ${ticks} ticks from ${entryPrice}.`);
      return;
    }
    await this.submit(
      catalogue.marketId,
      strategy.name,
      catalogue,
      [{
        ...ref,
        side: exitSide,
        price: exitPrice,
        size: round((matched * entry.averagePriceMatched) / exitPrice)!,
        persistenceType: persistence(p.ExitPersistenceType),
        role: "offset",
        reducesRisk: true,
      }],
      result,
    );
    if (matched < size) result.messages.push(`${name}: only ${matched} of ${size} matched; the offset covers the matched part.`);
  }

  private async cancel(p: Record<string, unknown>, marketId: string, selections: SelectionRef[] | undefined, result: ExecutionResult) {
    let betIds: string[] | undefined;
    if (selections) {
      const keys = new Set(selections.map((s) => formatSelectionId(s.selectionId, s.handicap)));
      const orders = await this.exchange.currentOrders([marketId]);
      betIds = orders.filter((o) => keys.has(o.selectionId) && o.sizeRemaining > 0).map((o) => o.betId);
      if (!betIds.length) return;
    }
    result.cancelled.push(...(await this.exchange.cancelOrders(marketId, betIds)));
  }

  private async closePositions(
    strategy: StrategySetting,
    p: Record<string, unknown>,
    catalogue: MarketCatalogue,
    book: MarketBook,
    selections: SelectionRef[] | undefined,
    result: ExecutionResult,
  ) {
    if (p.CancelUnmatchedBets !== false) await this.cancel(p, catalogue.marketId, selections, result);
    const orders = await this.exchange.currentOrders([catalogue.marketId]);
    const positions = selectionPositions(orders);
    const wanted = selections ? new Set(selections.map((s) => formatSelectionId(s.selectionId, s.handicap))) : undefined;
    const hedges: Array<OrderRequest & { role: string; reducesRisk: boolean }> = [];
    for (const [selectionId, position] of positions) {
      if (wanted && !wanted.has(selectionId)) continue;
      const [id, handicap] = selectionId.split("_").map(Number);
      const runner = this.runnerOf(book, { selectionId: id, handicap });
      try {
        const hedge = hedgeOrder(position, runner?.ex?.availableToBack?.[0]?.price, runner?.ex?.availableToLay?.[0]?.price);
        if (hedge) hedges.push({ selectionId: id, handicap, ...hedge, persistenceType: "LAPSE", role: "hedge", reducesRisk: true });
      } catch (error) {
        result.messages.push(`${this.nameOf(catalogue, { selectionId: id, handicap })}: ${(error as Error).message}`);
      }
    }
    if (!hedges.length) {
      result.messages.push("No open matched position to close.");
      return;
    }
    await this.submit(catalogue.marketId, strategy.name, catalogue, hedges, result);
  }

  private async dutch(
    strategy: StrategySetting,
    p: Record<string, number | boolean | string>,
    catalogue: MarketCatalogue,
    book: MarketBook,
    selections: SelectionRef[],
    result: ExecutionResult,
  ) {
    const legs = selections
      .map((ref) => ({ ref, price: this.runnerOf(book, ref)?.ex?.availableToBack?.[0]?.price }))
      .filter((leg): leg is { ref: SelectionRef; price: number } => {
        if (!leg.price) result.messages.push(`${this.nameOf(catalogue, leg.ref)}: no back price; left out of the dutch.`);
        else if (leg.price > Number(p.MaximumOdds)) result.messages.push(`${this.nameOf(catalogue, leg.ref)}: price ${leg.price} above MaximumOdds; left out.`);
        else return true;
        return false;
      });
    if (!legs.length) return;
    const stakes = dutchStakes(legs.map((l) => l.price), p.DutchingType === "Stake" ? "Stake" : "Profit", Number(p.Amount));
    await this.submit(
      catalogue.marketId,
      strategy.name,
      catalogue,
      legs.map((leg, i) => ({ ...leg.ref, side: "BACK", price: leg.price, size: stakes[i], persistenceType: persistence(p.PersistenceType), role: "dutch" })),
      result,
    );
  }
}
