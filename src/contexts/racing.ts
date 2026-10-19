// Betfair RUNNER_METADATA helpers and race-distance parsing for the horse-racing contexts.

type Metadata = Record<string, string | null> | undefined;

const POUNDS_PER_KG = 2.2046226218;
const YARDS_PER_MILE = 1760;
const YARDS_PER_FURLONG = 220;

/** Non-empty metadata text, or undefined. */
export function metaText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Numeric metadata value, or undefined when missing or not a number. */
export function metaNumber(value: string | null | undefined): number | undefined {
  const text = metaText(value);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** A number when the value is numeric, otherwise the text (e.g. cloth numbers such as "1A"). */
export function metaNumberOrText(value: string | null | undefined): number | string | undefined {
  return metaNumber(value) ?? metaText(value);
}

/** Bookmakers' forecast as decimal odds (FORECASTPRICE_NUMERATOR/DENOMINATOR + 1), unrounded. */
export function forecastPrice(meta: Metadata): number | undefined {
  const numerator = metaNumber(meta?.FORECASTPRICE_NUMERATOR);
  const denominator = metaNumber(meta?.FORECASTPRICE_DENOMINATOR);
  if (numerator === undefined || numerator <= 0 || !denominator || denominator <= 0) return undefined;
  return numerator / denominator + 1;
}

/** Weight carried in whole pounds (BFExplorer's horseDetail.weight); converts kilograms and "st-lb". */
export function weightLbs(meta: Metadata): number | undefined {
  const text = metaText(meta?.WEIGHT_VALUE);
  if (text === undefined) return undefined;
  const stones = /^(\d+)-(\d+)$/.exec(text);
  const value = stones ? Number(stones[1]) * 14 + Number(stones[2]) : Number(text);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const kilograms = /^k/i.test(metaText(meta?.WEIGHT_UNITS) ?? "");
  return kilograms ? Math.round(value * POUNDS_PER_KG) : value;
}

const SEX_NAMES: Record<string, string> = { c: "Colt", f: "Filly", g: "Gelding", h: "Horse", m: "Mare", r: "Rig" };

/** SEX_TYPE code to BFExplorer's gender word ("g" -> "Gelding"); full words pass through. */
export function genderName(value: string | null | undefined): string | undefined {
  const text = metaText(value);
  if (text === undefined) return undefined;
  return text.length === 1 ? (SEX_NAMES[text.toLowerCase()] ?? text) : text;
}

const DISTANCE_TOKEN = /^(?:(\d)m)?(?:(\d{1,2})?(½)?f)?(?:(\d{1,3})y)?$/i;

/**
 * Race distance in yards from a Betfair market name: "2m4f Hcap Chs" = 4400, "1m2f110y" = 2310,
 * "5f Nursery" = 1100, "2m½f" = 3630. Undefined when no distance token is found.
 */
export function raceDistanceYards(marketName: string | undefined): number | undefined {
  for (const token of (marketName ?? "").split(/\s+/)) {
    const match = DISTANCE_TOKEN.exec(token);
    if (!match) continue;
    const [, miles, furlongs, half, yards] = match;
    const hasFurlongs = furlongs !== undefined || half !== undefined;
    if (miles === undefined && !hasFurlongs) continue;
    if (/f/i.test(token) && !hasFurlongs) continue; // a bare "f"
    const total =
      Number(miles ?? 0) * YARDS_PER_MILE +
      Number(furlongs ?? 0) * YARDS_PER_FURLONG +
      (half ? YARDS_PER_FURLONG / 2 : 0) +
      Number(yards ?? 0);
    if (total > 0) return total;
  }
  return undefined;
}
