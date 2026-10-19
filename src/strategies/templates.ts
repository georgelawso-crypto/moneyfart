// BFExplorer strategy templates (names and parameters as BFExplorer spells them) and the
// parameter normalisation shared by settings and executions.

import { parseTimeSpan } from "../format.js";
import type { ParameterSpec, TemplateSpec } from "./types.js";

export type ParamValue = number | boolean | string | null;
export type Params = Record<string, ParamValue>;

export const TEMPLATE = {
  placeBet: "Place Bet",
  fillOrKill: "Place Bet - Fill or Kill",
  trade: "Place Bet and Close Selection Bet Position",
  closeSelection: "Close Selection Bet Position",
  closeMarket: "Close Market Bet Position",
  tickOffset: "Tick Offset",
  trailingStopLoss: "Trailing Stop Loss",
  dutching: "Place Dutching Bets",
  cancelBets: "Cancel Bets",
  sequence: "Sequence Execution",
} as const;

/** Parameter groups of "Place Bet and Close Selection Bet Position", addressed with dotted keys. */
export const OPEN = "OpenBetPosition.";
export const CLOSE = "CloseBetPosition.";

export const FILL_OR_KILL_MAX_MS = 30_000;

// ------------------------------------------------------------------ parameter specs

const SELECTION: ParameterSpec[] = [
  {
    name: "SortSelectionsBy",
    type: "enum",
    values: ["DoNotSort", "LastPriceTraded", "TotalMatched"],
    default: "DoNotSort",
    description: "Order used by ExecuteOnSelection/OnSelections: LastPriceTraded ascending (favourite first), TotalMatched descending, DoNotSort = Betfair's runner order.",
  },
  {
    name: "ExecuteOnSelection",
    type: "number",
    integer: true,
    default: 0,
    description: "0 = the given selection(s); N = the Nth active selection of the market after SortSelectionsBy.",
  },
];

const REFERENCE: ParameterSpec = {
  name: "StrategyReference",
  type: "string",
  default: "",
  description: "Betfair customerStrategyRef (at most 15 characters); empty = a stable reference derived from the setting name.",
};

const KEEP_BET: ParameterSpec = {
  name: "AtInPlayKeepBet",
  type: "boolean",
  default: false,
  aliases: ["PersistenceType"],
  valueAliases: { persist: true, keep: true, lapse: false },
  description: "Keep unmatched money when the market turns in-play (Betfair PERSIST); false = LAPSE. PersistenceType Lapse/Persist is accepted too.",
};

const BET: ParameterSpec[] = [
  { name: "BetType", type: "enum", values: ["Back", "Lay"], default: "Back", description: "Back or lay the selection." },
  { name: "Stake", type: "number", default: null, required: true, description: "Amount in account currency, read according to StakeType." },
  {
    name: "StakeType",
    type: "enum",
    values: ["Stake", "Liability", "Payout", "BankrollPercentage"],
    default: "Stake",
    description:
      "Stake = backer's stake (also for lays); Liability = money at risk (back stake / lay liability); Payout = stake x price target (size = Stake / price); BankrollPercentage = percent of the available balance used as back stake / lay liability.",
  },
  { name: "Odds", type: "number", default: 0, description: "Limit price; 0 = the best price available. Rounded onto the ladder in the bettor's favour." },
];

const PLACE_BET: ParameterSpec[] = [
  ...BET,
  {
    name: "PriceImprovement",
    type: "number",
    integer: true,
    default: 0,
    min: -128,
    max: 127,
    aliases: ["OddsOffsetTicks", "OddsImprovement"],
    description:
      "Ticks to move the price (BFExplorer's signed tick count): positive = better (higher for a back, lower for a lay), may stay unmatched; negative = worse, so the bet matches more easily. Clamped to the ladder ends.",
  },
  {
    name: "OfferMyBet",
    type: "boolean",
    default: false,
    description: "Offer liquidity at the opposite best price (back at the best lay price, lay at the best back price) instead of taking the best price.",
  },
  { name: "MinimumOdds", type: "number", default: 1.01, description: "Do not bet below this price (when PlaceBetInAllowedOddsRange is true)." },
  { name: "MaximumOdds", type: "number", default: 1000, description: "Do not bet above this price (when PlaceBetInAllowedOddsRange is true)." },
  { name: "PlaceBetInAllowedOddsRange", type: "boolean", default: true, description: "Check MinimumOdds/MaximumOdds; false disables the check." },
  {
    name: "MinimumOddsDifference",
    type: "number",
    integer: true,
    default: 0,
    description: "Bet only when the best back and best lay prices are at least this many ticks apart; 0 = off.",
  },
  {
    name: "MaximumOddsDifference",
    type: "number",
    integer: true,
    default: 0,
    description: "Bet only when the best back and best lay prices are at most this many ticks apart; 0 = off.",
  },
  { name: "AllowPlacingBetInPlay", type: "boolean", default: true, description: "Allow placing the bet while the market is in-play." },
  KEEP_BET,
  {
    name: "PlaceBetTimeSpan",
    type: "timespan",
    default: null,
    description: 'Place the bet at this time relative to the market start, e.g. "-0:05:00" = 5 minutes before the off; empty = now. A bot waits until then.',
  },
];

function closeParameters(immediate: boolean): ParameterSpec[] {
  return [
    { name: "ProfitLossType", type: "enum", values: ["Money", "Ticks", "Percentage"], default: "Ticks", description: "Unit of Profit and Loss." },
    {
      name: "Profit",
      type: "number",
      default: 0,
      description:
        "Close when this profit is reached: Money = locked-in profit in account currency, Ticks = ticks moved in our favour from the entry price, Percentage = locked-in profit / opening risk x 100. 0 = no profit target.",
    },
    { name: "Loss", type: "number", default: 0, description: "Close when this loss is reached (same unit as Profit); 0 = no stop-loss." },
    {
      name: "HedgingEnabled",
      type: "boolean",
      default: true,
      description: "true = close with an equal-profit green-up; false = offset the matched stake only (the result then sits on the selection winning).",
    },
    {
      name: "ClosePositionTimeSpan",
      type: "timespan",
      default: null,
      description: 'Close regardless of profit at this time relative to the market start, e.g. "-0:00:05" = 5 seconds before the off; empty = no time exit.',
    },
    {
      name: "BetMatchingTimeout",
      type: "timespan",
      default: "00:00:05",
      description: "Cancel and re-price an unmatched closing bet after this long.",
    },
    {
      name: "CheckingLastPriceTraded",
      type: "boolean",
      default: false,
      description: "Evaluate the targets with the last traded price instead of the best price the position can be closed at.",
    },
    {
      name: "ClosePositionImmediately",
      type: "boolean",
      default: immediate,
      description: immediate
        ? "Not given: close now when no Profit/Loss/ClosePositionTimeSpan target is set, otherwise start a bot that closes on the targets. true = close now (any targets are ignored); false = always start a bot that closes on the targets."
        : "Close as soon as the entry is matched. Only applies when no Profit, Loss or ClosePositionTimeSpan target is set: with a target, the targets decide when to close.",
    },
  ];
}

const CANCEL_UNMATCHED: ParameterSpec = {
  name: "CancelUnmatchedBets",
  type: "boolean",
  default: true,
  description: "Cancel unmatched bets first. Resting bets on the hedge side always block the hedge (they would over-hedge when matched).",
};

function grouped(prefix: string, specs: ParameterSpec[]): ParameterSpec[] {
  return specs.map((s) => ({ ...s, name: prefix + s.name, aliases: s.aliases?.map((a) => prefix + a) }));
}

/** Selection parameters at the top level of the open/close template also accept the OpenBetPosition. prefix. */
const TOP_LEVEL_OF_TRADE = [...SELECTION, REFERENCE].map((s) => ({ ...s, aliases: [...(s.aliases ?? []), OPEN + s.name] }));

// ------------------------------------------------------------------ templates

export const TEMPLATES: TemplateSpec[] = [
  {
    name: TEMPLATE.placeBet,
    category: "Betting",
    description: "Place one back or lay bet on the selection, optionally at a later time (PlaceBetTimeSpan).",
    parameters: [...PLACE_BET, ...SELECTION, REFERENCE],
  },
  {
    name: TEMPLATE.fillOrKill,
    aliases: ["Fill or Kill"],
    category: "Betting",
    description: "Place a bet, wait up to BetMatchingTimeout (at most 30 s) for it to match, then cancel whatever is unmatched.",
    parameters: [
      ...PLACE_BET,
      { name: "BetMatchingTimeout", type: "timespan", default: "00:00:05", description: "How long to wait for the bet to match (capped at 30 seconds)." },
      ...SELECTION,
      REFERENCE,
    ],
  },
  {
    name: TEMPLATE.trade,
    aliases: ["Place Bet and Close Position"],
    category: "Trading",
    description:
      "Trade: place the OpenBetPosition bet, then a bot closes the position (green-up) on the CloseBetPosition targets: profit/loss in Money, Ticks or Percentage of the opening risk, a time before the off, or (ClosePositionImmediately, only when no target is set) as soon as the entry is matched. Dotted keys such as OpenBetPosition.BetType and CloseBetPosition.Profit; plain names are accepted too.",
    parameters: [...grouped(OPEN, PLACE_BET), ...grouped(CLOSE, closeParameters(false)), ...TOP_LEVEL_OF_TRADE],
  },
  {
    name: TEMPLATE.closeSelection,
    category: "Position",
    description:
      "Close (green up) the selection's whole matched position: immediately (default without targets), or by a bot on the Profit/Loss/ClosePositionTimeSpan targets when any is given (unless ClosePositionImmediately is true) or ClosePositionImmediately is false.",
    parameters: [CANCEL_UNMATCHED, ...closeParameters(true), ...SELECTION, REFERENCE],
  },
  {
    name: TEMPLATE.closeMarket,
    category: "Position",
    description: "Close (green up) the matched position of every selection in the market now.",
    parameters: [CANCEL_UNMATCHED, closeParameters(true).find((p) => p.name === "HedgingEnabled")!, REFERENCE],
  },
  {
    name: TEMPLATE.tickOffset,
    category: "Trading",
    description: "Place the entry bet, then for its matched part a resting opposite bet Profit ticks better, sized for an equal profit whichever way the race goes.",
    parameters: [
      ...BET,
      { name: "Profit", type: "number", integer: true, default: null, required: true, aliases: ["ProfitTicks"], description: "Profit target in ticks." },
      KEEP_BET,
      ...SELECTION,
      REFERENCE,
    ],
  },
  {
    name: TEMPLATE.trailingStopLoss,
    category: "Trading",
    description:
      "Bot on the selection's existing position: tracks the best price reached in our favour and closes the position when the price moves Loss ticks back against us from that best.",
    parameters: [
      { name: "Loss", type: "number", integer: true, default: null, required: true, description: "Trailing distance in ticks." },
      closeParameters(true).find((p) => p.name === "HedgingEnabled")!,
      closeParameters(true).find((p) => p.name === "BetMatchingTimeout")!,
      ...SELECTION,
      REFERENCE,
    ],
  },
  {
    name: TEMPLATE.dutching,
    aliases: ["Dutching", "Place Dutching Bet"],
    category: "Dutching",
    description:
      "Back several selections so that the same profit results whichever of them wins (RequiredProfit), or split a total stake for equal returns (TotalStake). All-or-nothing: if any leg fails a check, nothing is placed.",
    parameters: [
      { name: "BetType", type: "enum", values: ["Back", "Lay"], default: "Back", description: "Back only (lay dutching is not supported)." },
      {
        name: "DutchingType",
        type: "enum",
        values: ["RequiredProfit", "TotalStake"],
        valueAliases: { profit: "RequiredProfit", stake: "TotalStake" },
        default: "RequiredProfit",
        description: "RequiredProfit = TargetValue is the profit if any selected runner wins; TotalStake = TargetValue is the total stake.",
      },
      { name: "TargetValue", type: "number", default: null, required: true, aliases: ["Amount"], description: "Required profit or total stake in account currency." },
      { name: "MaximumOdds", type: "number", default: 1000, description: "Refuse the dutch when a leg is priced above this." },
      KEEP_BET,
      {
        name: "OnSelections",
        type: "string",
        default: "",
        description: 'Positions of the selections to dutch after SortSelectionsBy, e.g. "1,2,4"; empty = the given selections.',
      },
      SELECTION[0],
      REFERENCE,
    ],
  },
  {
    name: TEMPLATE.cancelBets,
    category: "Control",
    description: "Cancel unmatched bets on the selection(s) or in the whole market.",
    parameters: [{ name: "Scope", type: "enum", values: ["Selection", "Market"], default: "Selection", description: "What to cancel." }],
  },
  {
    name: TEMPLATE.sequence,
    category: "Control",
    description: "Execute other strategy settings one after another on the same selection(s); stops at the first step that fails.",
    parameters: [
      { name: "StrategyNames", type: "string", default: "", required: true, description: 'Setting names separated by semicolons, e.g. "Bet 10 Euro;Trailing Stop Loss 3 Ticks".' },
      ...SELECTION,
    ],
  },
];

export function findTemplate(name: string): TemplateSpec | undefined {
  const wanted = String(name ?? "").trim().toLowerCase();
  return TEMPLATES.find((t) => t.name.toLowerCase() === wanted || t.aliases?.some((a) => a.toLowerCase() === wanted));
}

// ------------------------------------------------------------------ normalisation

export class ParameterError extends Error {}

interface Lookup {
  exact: Map<string, ParameterSpec>;
  /** Plain names of grouped parameters (null when the name exists in both groups). */
  plain: Map<string, ParameterSpec | null>;
  /** Prefixes stripped from keys of templates without groups. */
  strip: string[];
}

const lookups = new Map<string, Lookup>();

function lookupFor(template: TemplateSpec): Lookup {
  let lookup = lookups.get(template.name);
  if (lookup) return lookup;
  lookup = { exact: new Map(), plain: new Map(), strip: [] };
  const groupedTemplate = template.parameters.some((p) => p.name.startsWith(OPEN) || p.name.startsWith(CLOSE));
  for (const spec of template.parameters) {
    for (const name of [spec.name, ...(spec.aliases ?? [])]) lookup.exact.set(name.toLowerCase(), spec);
  }
  if (groupedTemplate) {
    for (const spec of template.parameters) {
      for (const name of [spec.name, ...(spec.aliases ?? [])]) {
        const dot = name.indexOf(".");
        if (dot < 0) continue;
        const plain = name.slice(dot + 1).toLowerCase();
        if (lookup.exact.has(plain)) continue;
        const existing = lookup.plain.get(plain);
        lookup.plain.set(plain, existing === undefined || existing === spec ? spec : null);
      }
    }
  } else {
    lookup.strip.push(OPEN.toLowerCase());
    if (template.name === TEMPLATE.closeSelection) lookup.strip.push(CLOSE.toLowerCase());
  }
  lookups.set(template.name, lookup);
  return lookup;
}

function findSpec(lookup: Lookup, key: string): ParameterSpec | null | undefined {
  const k = key.trim().toLowerCase();
  const exact = lookup.exact.get(k);
  if (exact) return exact;
  if (lookup.plain.has(k)) return lookup.plain.get(k);
  for (const prefix of lookup.strip) {
    if (k.startsWith(prefix)) return lookup.exact.get(k.slice(prefix.length));
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** {"OpenBetPosition":{"Stake":2}} -> [["OpenBetPosition.Stake", 2]]. */
export function flattenParameters(input: Record<string, unknown>, prefix = "", out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  for (const [key, value] of Object.entries(input)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) flattenParameters(value, name, out);
    else out.push([name, value]);
  }
  return out;
}

const TRUE_WORDS = new Set(["true", "1", "yes"]);
const FALSE_WORDS = new Set(["false", "0", "no"]);
const SECONDS = /^[+-]?\d+(?:\.\d+)?$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** .NET TimeSpan "c" format: [-][d.]hh:mm:ss[.fff]. */
export function formatTimeSpan(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let rest = Math.round(Math.abs(ms));
  const days = Math.floor(rest / 86_400_000);
  rest -= days * 86_400_000;
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / 60_000);
  rest -= minutes * 60_000;
  const seconds = Math.floor(rest / 1000);
  const millis = rest - seconds * 1000;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${sign}${days ? `${days}.` : ""}${two(hours)}:${two(minutes)}:${two(seconds)}${millis ? `.${String(millis).padStart(3, "0")}` : ""}`;
}

/** Milliseconds of a normalised TimeSpan value; undefined when unset. */
export function timeSpanMs(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return parseTimeSpan(value);
}

function parseValue(spec: ParameterSpec, raw: unknown): ParamValue {
  const fail = (expected: string) => new ParameterError(`Parameter ${spec.name} must be ${expected}, got ${JSON.stringify(raw) ?? String(raw)}.`);
  switch (spec.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && DECIMAL.test(raw.trim()) ? Number(raw.trim()) : NaN;
      const min = spec.min ?? 0;
      if (!Number.isFinite(n) || n < min || (spec.max !== undefined && n > spec.max)) {
        throw fail(spec.min === undefined && spec.max === undefined ? "a non-negative number" : `a number from ${min} to ${spec.max ?? "any"}`);
      }
      if (spec.integer && !Number.isInteger(n)) throw fail("a whole number");
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === 1 || raw === 0) return raw === 1;
      if (typeof raw === "string") {
        const word = raw.trim().toLowerCase();
        if (TRUE_WORDS.has(word)) return true;
        if (FALSE_WORDS.has(word)) return false;
        const alias = spec.valueAliases?.[word];
        if (typeof alias === "boolean") return alias;
      }
      throw fail("true or false");
    }
    case "enum": {
      if (typeof raw === "string") {
        const word = raw.trim().toLowerCase();
        const match = spec.values!.find((v) => v.toLowerCase() === word);
        if (match) return match;
        const alias = spec.valueAliases?.[word];
        if (typeof alias === "string") return alias;
      }
      throw fail(`one of ${spec.values!.join(", ")}`);
    }
    case "timespan": {
      if (raw === null || raw === "") return null;
      if (typeof raw !== "number" && typeof raw !== "string") throw fail('a TimeSpan such as "-0:05:00" or a number of seconds');
      const text = typeof raw === "string" ? raw.trim() : raw;
      try {
        const ms = typeof text === "string" && SECONDS.test(text) ? Number(text) * 1000 : parseTimeSpan(text)!;
        return formatTimeSpan(ms);
      } catch {
        throw fail('a TimeSpan such as "-0:05:00" or a number of seconds');
      }
    }
    case "string": {
      if (raw === null) return "";
      if (Array.isArray(raw) && raw.every((x) => typeof x === "string" || typeof x === "number")) {
        return raw.map((x) => String(x).trim()).join(spec.name === "StrategyNames" ? ";" : ",");
      }
      if (typeof raw === "string" || typeof raw === "number") return String(raw).trim();
      throw fail("text");
    }
  }
}

/**
 * Validate parameters against a template: flatten nested objects into dotted keys, match names
 * case-insensitively (aliases, plain names on the open/close template, a stripped
 * OpenBetPosition. prefix elsewhere) and parse values strictly. Returns canonical names only.
 * Throws ParameterError naming every unknown key and listing the valid ones.
 */
export function parseParameters(template: TemplateSpec, input: Record<string, unknown> | undefined | null): Params {
  if (input !== undefined && input !== null && !isPlainObject(input)) {
    throw new ParameterError(`Parameters must be a JSON object such as {"Stake":5}, got ${JSON.stringify(input)}.`);
  }
  const lookup = lookupFor(template);
  const values: Params = {};
  const sources = new Map<string, string>();
  const unknown: string[] = [];
  const errors: string[] = [];
  for (const [key, raw] of flattenParameters(input ?? {})) {
    const spec = findSpec(lookup, key);
    if (spec === null) {
      errors.push(`Parameter "${key}" is ambiguous; use the dotted ${OPEN}/${CLOSE} name.`);
      continue;
    }
    if (!spec) {
      unknown.push(key);
      continue;
    }
    let value: ParamValue;
    try {
      value = parseValue(spec, raw);
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }
    const previous = sources.get(spec.name);
    if (previous !== undefined && values[spec.name] !== value) {
      errors.push(`Parameter ${spec.name} is given twice ("${previous}" and "${key}") with different values.`);
      continue;
    }
    values[spec.name] = value;
    sources.set(spec.name, key);
  }
  if (unknown.length) {
    errors.unshift(
      `Unknown parameter${unknown.length > 1 ? "s" : ""} for template "${template.name}": ${unknown.join(", ")}. ` +
        `Valid parameters: ${template.parameters.map((p) => p.name).join(", ")}.`,
    );
  }
  if (errors.length) throw new ParameterError(errors.join(" "));
  return values;
}

/** Template defaults overlaid with each layer of (already parsed) values. */
export function resolveParameters(template: TemplateSpec, ...layers: Params[]): Params {
  const values: Params = Object.fromEntries(template.parameters.map((p) => [p.name, p.default]));
  for (const layer of layers) Object.assign(values, layer);
  return values;
}

/**
 * A Profit, Loss or ClosePositionTimeSpan target is set (close values without group prefix). With one,
 * ClosePositionImmediately no longer means "close as soon as matched": the targets decide.
 */
export function hasCloseTargets(close: Params): boolean {
  return Number(close.Profit ?? 0) > 0 || Number(close.Loss ?? 0) > 0 || timeSpanMs(close.ClosePositionTimeSpan) !== undefined;
}

/** Values of one parameter group with the prefix removed (plus the ungrouped top-level values). */
export function groupValues(values: Params, prefix: string): Params {
  const out: Params = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
    else if (!key.startsWith(OPEN) && !key.startsWith(CLOSE)) out[key] = value;
  }
  return out;
}

/** Checks that need the complete values: required parameters and cross-parameter rules. */
export function parameterProblems(template: TemplateSpec, values: Params): string[] {
  const problems: string[] = [];
  for (const spec of template.parameters) {
    const value = values[spec.name];
    if (spec.required && (value === null || value === undefined || value === "")) problems.push(`Parameter ${spec.name} is required.`);
  }
  const prefix = template.name === TEMPLATE.trade ? OPEN : "";
  const num = (name: string) => (typeof values[name] === "number" ? (values[name] as number) : undefined);
  const stake = num(`${prefix}Stake`);
  if (stake !== undefined && stake <= 0) problems.push(`Parameter ${prefix}Stake must be greater than 0.`);
  if (stake !== undefined && values[`${prefix}StakeType`] === "BankrollPercentage" && stake > 100) {
    problems.push(`Parameter ${prefix}Stake is a percentage of the balance with StakeType BankrollPercentage and cannot exceed 100.`);
  }
  const min = num(`${prefix}MinimumOdds`);
  const max = num(`${prefix}MaximumOdds`);
  if (values[`${prefix}PlaceBetInAllowedOddsRange`] !== false && min !== undefined && max !== undefined && min > max) {
    problems.push(`${prefix}MinimumOdds ${min} is above ${prefix}MaximumOdds ${max}.`);
  }
  const minDiff = num(`${prefix}MinimumOddsDifference`);
  const maxDiff = num(`${prefix}MaximumOddsDifference`);
  if (minDiff && maxDiff && minDiff > maxDiff) problems.push(`${prefix}MinimumOddsDifference ${minDiff} is above ${prefix}MaximumOddsDifference ${maxDiff}.`);
  for (const spec of template.parameters) {
    if (spec.type === "timespan" && spec.name.endsWith("BetMatchingTimeout") && (timeSpanMs(values[spec.name]) ?? 0) < 0) {
      problems.push(`Parameter ${spec.name} cannot be negative.`);
    }
  }
  const reference = values.StrategyReference;
  if (typeof reference === "string" && reference.length > 15) {
    problems.push(`StrategyReference "${reference}" is longer than Betfair's 15 characters.`);
  }
  if (template.name === TEMPLATE.tickOffset && num("Profit") !== undefined && num("Profit")! < 1) problems.push("Parameter Profit (ticks) must be at least 1.");
  if (template.name === TEMPLATE.trailingStopLoss && num("Loss") !== undefined && num("Loss")! < 1) problems.push("Parameter Loss (ticks) must be at least 1.");
  if (template.name === TEMPLATE.dutching) {
    if (values.BetType === "Lay") problems.push("Place Dutching Bets supports BetType Back only; lay dutching is not implemented.");
    if (num("TargetValue") !== undefined && num("TargetValue")! <= 0) problems.push("Parameter TargetValue must be greater than 0.");
    const on = values.OnSelections;
    if (typeof on === "string" && on && !/^\s*[1-9]\d*(\s*,\s*[1-9]\d*)*\s*$/.test(on)) {
      problems.push(`Parameter OnSelections must list selection positions such as "1,2,4", got "${on}".`);
    }
  }
  if (template.name === TEMPLATE.sequence && typeof values.StrategyNames === "string" && !values.StrategyNames.split(";").some((s) => s.trim())) {
    problems.push("Parameter StrategyNames must name at least one strategy setting.");
  }
  return problems;
}

/** Parse, resolve and check: the full parameter set a setting runs with. Throws ParameterError. */
export function normaliseParameters(template: TemplateSpec, ...inputs: Array<Record<string, unknown> | undefined>): Params {
  const values = resolveParameters(template, ...inputs.map((input) => parseParameters(template, input)));
  const problems = parameterProblems(template, values);
  if (problems.length) throw new ParameterError(problems.join(" "));
  return values;
}
