// Output conventions reverse-engineered from recorded BFExplorer MCP responses.

// ------------------------------------------------------------------ identifiers

export interface SelectionRef {
  selectionId: number;
  handicap: number;
}

/**
 * BFExplorer (2026) emits bare selection ids such as "98427997". The older
 * "<id>_<handicap>" form is kept only for non-zero handicaps (Asian handicap lines).
 */
export function formatSelectionId(selectionId: number, handicap = 0): string {
  return handicap ? `${selectionId}_${handicap.toFixed(2)}` : String(selectionId);
}

/** Accepts "98427997", "98427997_0.00", "98427997_-1.50" and numbers. */
export function parseSelectionId(value: string | number): SelectionRef {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return { selectionId: value, handicap: 0 };
  const match = /^\s*(\d+)(?:_(-?\d+(?:\.\d+)?))?\s*$/.exec(String(value));
  if (!match) {
    throw new Error(`Invalid selectionId ${JSON.stringify(value)}. Use the id from get_active_market/get_market, e.g. "98427997".`);
  }
  return { selectionId: Number(match[1]), handicap: match[2] ? Number(match[2]) : 0 };
}

export function selectionKey(ref: SelectionRef): string {
  return formatSelectionId(ref.selectionId, ref.handicap);
}

export function sameSelection(a: SelectionRef, b: SelectionRef): boolean {
  return a.selectionId === b.selectionId && Math.abs(a.handicap - b.handicap) < 1e-9;
}

const MARKET_ID = /^\d\.\d+$/;

export function assertMarketId(marketId: string): string {
  const id = String(marketId ?? "").trim();
  if (!MARKET_ID.test(id)) throw new Error(`Invalid marketId ${JSON.stringify(marketId)}. Betfair market ids look like "1.234567890".`);
  return id;
}

// ------------------------------------------------------------------ numbers

/** Round for display/output; returns undefined for missing or non-finite values. */
export function round(value: number | undefined | null, digits = 2): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  const rounded = Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

// ------------------------------------------------------------------ statuses

const MARKET_STATUS: Record<string, string> = { INACTIVE: "Inactive", OPEN: "Open", SUSPENDED: "Suspended", CLOSED: "Closed" };
const RUNNER_STATUS: Record<string, string> = {
  ACTIVE: "Active",
  WINNER: "Winner",
  PLACED: "Placed",
  LOSER: "Loser",
  REMOVED_VACANT: "RemovedVacant",
  REMOVED: "Removed",
  HIDDEN: "Hidden",
};

export function marketStatusName(status?: string): string | undefined {
  return status ? (MARKET_STATUS[status] ?? status) : undefined;
}

export function runnerStatusName(status?: string): string | undefined {
  return status ? (RUNNER_STATUS[status] ?? status) : undefined;
}

// ------------------------------------------------------------------ times

function toDate(value: string | number | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date ${JSON.stringify(value)}`);
  return date;
}

/** "2026-09-16T12:45:00Z": UTC to the second, as in BFExplorer's market TOON. */
export function utcSeconds(value: string | number | Date): string {
  return toDate(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * "2026-10-06T20:00:00+02:00": local time with offset, to the second. BFExplorer's
 * data contexts use the host's local zone; we use DISPLAY_TIMEZONE.
 */
export function localTime(value: string | number | Date, timeZone: string): string {
  const parts = Object.fromEntries(zoneFormatter(timeZone).formatToParts(toDate(value)).map((p) => [p.type, p.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : String(parts.timeZoneName).replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/**
 * Parse a .NET TimeSpan string ("-0:05:00", "00:00:05", "1.02:03:04") or a number of
 * seconds into milliseconds. Returns undefined for null/empty.
 */
export function parseTimeSpan(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  const match = /^\s*([+-])?(?:(\d+)\.)?(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,7}))?)?\s*$/.exec(String(value));
  if (!match) throw new Error(`Invalid TimeSpan ${JSON.stringify(value)}; use e.g. "-0:05:00" (5 minutes before the off) or "00:00:05".`);
  const [, sign, days, hours, minutes, seconds, fraction] = match;
  const ms =
    ((Number(days ?? 0) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 +
    Number(seconds ?? 0) * 1000 +
    (fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0);
  return sign === "-" ? -ms : ms;
}

// ------------------------------------------------------------------ TOON

/**
 * Minimal TOON (Token-Oriented Object Notation) encoder that reproduces BFExplorer's
 * output: 2-space indentation, tabular arrays for uniform objects, and BFExplorer's
 * quoting rule (any string with whitespace is quoted, in addition to the TOON spec rules).
 */
export function toToon(value: unknown, rootKey?: string): string {
  const lines: string[] = [];
  if (rootKey !== undefined) encodeEntry(rootKey, value, 0, lines);
  else if (Array.isArray(value)) encodeArray(undefined, value, 0, lines);
  else if (isPlainObject(value)) for (const [k, v] of entries(value)) encodeEntry(k, v, 0, lines);
  else lines.push(primitive(value));
  return lines.join("\n");
}

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function entries(value: Obj): Array<[string, unknown]> {
  return Object.entries(value).filter(([, v]) => v !== undefined);
}

function isPrimitive(value: unknown): boolean {
  return value === null || value instanceof Date || ["string", "number", "boolean"].includes(typeof value);
}

const NUMERIC_LIKE = /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

function quoteString(text: string): string {
  const needsQuotes =
    text === "" ||
    /\s/.test(text) ||
    NUMERIC_LIKE.test(text) ||
    text === "true" ||
    text === "false" ||
    text === "null" ||
    /[:"\\[\]{},]/.test(text) ||
    /[\u0000-\u001f]/.test(text) ||
    text.startsWith("-") ||
    text.startsWith("#");
  if (!needsQuotes) return text;
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

function primitive(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return quoteString(value.toISOString());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "boolean") return String(value);
  return quoteString(String(value));
}

function key(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : JSON.stringify(name);
}

function pad(depth: number): string {
  return "  ".repeat(depth);
}

function encodeEntry(name: string, value: unknown, depth: number, lines: string[]) {
  if (Array.isArray(value)) encodeArray(name, value, depth, lines);
  else if (isPlainObject(value)) {
    lines.push(`${pad(depth)}${key(name)}:`);
    for (const [k, v] of entries(value)) encodeEntry(k, v, depth + 1, lines);
  } else lines.push(`${pad(depth)}${key(name)}: ${primitive(value)}`);
}

function tabularFields(items: unknown[]): string[] | undefined {
  if (!items.length || !items.every(isPlainObject)) return undefined;
  const fields = entries(items[0] as Obj).map(([k]) => k);
  if (!fields.length) return undefined;
  for (const item of items as Obj[]) {
    const keys = entries(item).map(([k]) => k);
    if (keys.length !== fields.length || !fields.every((f) => f in item && item[f] !== undefined)) return undefined;
    if (!fields.every((f) => isPrimitive(item[f]))) return undefined;
  }
  return fields;
}

function encodeArray(name: string | undefined, items: unknown[], depth: number, lines: string[]) {
  const label = name === undefined ? "" : key(name);
  if (!items.length) {
    lines.push(`${pad(depth)}${label}: []`);
    return;
  }
  if (items.every(isPrimitive)) {
    lines.push(`${pad(depth)}${label}[${items.length}]: ${items.map(primitive).join(",")}`);
    return;
  }
  const fields = tabularFields(items);
  if (fields) {
    lines.push(`${pad(depth)}${label}[${items.length}]{${fields.map(key).join(",")}}:`);
    for (const item of items as Obj[]) lines.push(`${pad(depth + 1)}${fields.map((f) => primitive(item[f])).join(",")}`);
    return;
  }
  lines.push(`${pad(depth)}${label}[${items.length}]:`);
  for (const item of items) {
    if (isPlainObject(item)) {
      const fieldsOf = entries(item);
      if (!fieldsOf.length) {
        lines.push(`${pad(depth + 1)}-`);
        continue;
      }
      const sub: string[] = [];
      for (const [k, v] of fieldsOf) encodeEntry(k, v, depth + 2, sub);
      sub[0] = `${pad(depth + 1)}- ${sub[0].trimStart()}`;
      lines.push(...sub);
    } else if (Array.isArray(item)) {
      const sub: string[] = [];
      encodeArray(undefined, item, depth + 2, sub);
      sub[0] = `${pad(depth + 1)}- ${sub[0].trimStart()}`;
      lines.push(...sub);
    } else lines.push(`${pad(depth + 1)}- ${primitive(item)}`);
  }
}

/** Remove undefined/null fields recursively (System.Text.Json WhenWritingNull) and empty `data` objects. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (isPlainObject(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      const c = compact(v);
      if (k === "data" && isPlainObject(c) && !Object.keys(c).length) continue;
      out[k] = c;
    }
    return out as T;
  }
  return value;
}
