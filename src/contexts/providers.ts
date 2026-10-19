import type { MarketBook, MarketCatalogue, Runner, RunnerCatalog } from "../betfair/types.js";
import { compact, formatSelectionId, round, utcSeconds } from "../format.js";
import type { MarketService } from "../markets.js";
import type { MarketRecording, SelectionRecording } from "../recorder.js";
import type { SettledMarket, State } from "../state.js";
import { BFEXPLORER_ONLY_CONTEXTS } from "./bfexplorerOnly.js";
import {
  anchoredWindows,
  CANDLE_COUNT,
  CANDLE_WINDOW_MS,
  ladderVwap,
  METRIC_COUNT,
  METRIC_WINDOW_MS,
  recordedPoints,
  sideVolumes,
  sumSizes,
} from "./candles.js";
import { forecastPrice, genderName, metaNumber, metaNumberOrText, metaText, raceDistanceYards, weightLbs } from "./racing.js";

/** Everything a provider may read; built once per get_all_data_context_for_market call. */
export interface BuildContext {
  marketId: string;
  catalogue: MarketCatalogue;
  /** The one market book fetched for this call (undefined when Betfair returned none). */
  book?: MarketBook;
  /** Requested selections in sortPriority order. */
  runners: RunnerCatalog[];
  runner(rc: RunnerCatalog): Runner | undefined;
  recording?: MarketRecording;
  selection(rc: RunnerCatalog): SelectionRecording | undefined;
  /** Recorded trades carry traded volume (false with delayed application keys). */
  volumeData: boolean;
  /** Data-context time format: local time with offset (DISPLAY_TIMEZONE). */
  time(value: number | string): string;
  now: number;
  /** Add a sentence to the envelope's recording.note. */
  note(text: string): void;
  markets: MarketService;
  state: State;
  /** The PLACE market of this (WIN) market, cached per WIN market. */
  placeMarketId(): Promise<string | undefined>;
}

export interface ProviderOutput {
  /** Data keys per formatted selection id (only selections with data). */
  selections: Map<string, Record<string, unknown>>;
  /** Market-level data keys. */
  market?: Record<string, unknown>;
  /** Why nothing was produced (overrides the provider's default reason). */
  noData?: string;
}

export interface Provider {
  name: string;
  status: "available" | "partial";
  /** For partial providers: what is missing compared with BFExplorer. */
  reason?: string;
  description: string;
  dataKeys: string[];
  marketDataKeys?: string[];
  /** Book options this provider needs; the call fetches one book with the union. */
  allOffers?: boolean;
  sp?: boolean;
  /** Reads only the catalogue and state (still works when Betfair returns no book). */
  bookless?: boolean;
  /** Built from this connector's recording, so the envelope reports `recording`. */
  history?: boolean;
  /** Reason reported when the provider produced nothing for the requested selections. */
  noData: string;
  build(ctx: BuildContext): ProviderOutput | Promise<ProviderOutput>;
}

export const PRICE_HISTORY_MAX_ROWS = 300;
const PAST_RACES_MAX = 6;
const NOT_RECORDED =
  "No trades recorded for this market yet. History starts when the market is opened with open_market; open it and read this context again later. Continue the analysis without it.";

/** Non-empty compacted object, or undefined. */
export function present(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const compacted = compact(value);
  return Object.keys(compacted).length ? compacted : undefined;
}

function perSelection(ctx: BuildContext, build: (rc: RunnerCatalog) => Record<string, unknown> | undefined): ProviderOutput {
  const selections = new Map<string, Record<string, unknown>>();
  for (const rc of ctx.runners) {
    const data = present(build(rc));
    if (data) selections.set(formatSelectionId(rc.selectionId, rc.handicap), data);
  }
  return { selections };
}

/** The price get_active_market shows: last traded, else best back, else 1000. */
function marketToolPrice(runner: Runner): number {
  return runner.lastPriceTraded ?? runner.ex?.availableToBack?.[0]?.price ?? 1000;
}

/** Betfair sends "NaN"/"Infinity" for some SP projections. */
function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function isPrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function extremes(values: number[]): { min: number; max: number } | undefined {
  if (!values.length) return undefined;
  return values.reduce((acc, v) => ({ min: Math.min(acc.min, v), max: Math.max(acc.max, v) }), { min: values[0], max: values[0] });
}

// ------------------------------------------------------------------ recorded-price providers

const candleStick: Provider = {
  name: "MarketSelectionsCandleStickData",
  status: "available",
  description:
    "5-minute candles {time, high, open, close, low, volume} built like BFExplorer (each window opens at the first trade at least 300 s after the previous one, open = previous close, only windows with trades, last 12, in-play trades included) from the trades this connector recorded since open_market; plus vwaPrice (VWAP of the whole traded ladder, available immediately) and backLayRatio (share of back-initiated volume, 0.5 = neutral).",
  dataKeys: ["candleStickData", "vwaPrice", "backLayRatio"],
  history: true,
  noData: NOT_RECORDED,
  build(ctx) {
    return perSelection(ctx, (rc) => {
      const sel = ctx.selection(rc);
      const windows = anchoredWindows(recordedPoints(sel, ctx.volumeData), CANDLE_WINDOW_MS).slice(-CANDLE_COUNT);
      const { back, lay } = sideVolumes(sel?.trades);
      const classified = back.volume + lay.volume;
      return {
        candleStickData: windows.length
          ? windows.map((w) => ({ time: ctx.time(w.time), high: w.high, open: w.open, close: w.close, low: w.low, volume: round(w.volume) ?? 0 }))
          : undefined,
        vwaPrice: ctx.volumeData ? round(ladderVwap(ctx.runner(rc)?.ex?.tradedVolume)) : undefined,
        backLayRatio: ctx.volumeData && classified > 0 ? round(back.volume / classified) : undefined,
      };
    });
  },
};

const priceHistory: Provider = {
  name: "MarketSelectionsPriceHistoryData",
  status: "available",
  description:
    "timePriceVolumes [{time, price, volume}]: one row per trade this connector recorded since open_market (volume = amount matched in that trade, not cumulative), oldest first, at most the last 300 per selection.",
  dataKeys: ["timePriceVolumes"],
  history: true,
  noData: NOT_RECORDED,
  build(ctx) {
    let truncated = false;
    const output = perSelection(ctx, (rc) => {
      const points = recordedPoints(ctx.selection(rc), ctx.volumeData).sort((a, b) => a.t - b.t);
      if (points.length > PRICE_HISTORY_MAX_ROWS) truncated = true;
      const rows = points.slice(-PRICE_HISTORY_MAX_ROWS).map((p) => ({ time: ctx.time(p.t), price: p.price, volume: round(p.size) ?? 0 }));
      return { timePriceVolumes: rows.length ? rows : undefined };
    });
    if (truncated) ctx.note(`timePriceVolumes holds only the last ${PRICE_HISTORY_MAX_ROWS} recorded trades per selection; older trades are left out.`);
    return output;
  },
};

const tradedPrices: Provider = {
  name: "MarketSelectionsTradedPricesData",
  status: "available",
  description:
    "tradedPricesData {startPrice (price when monitoring began), endPrice (last traded), minPrice, maxPrice (observed window), tradedVolume (matched since monitoring began), backRatio, layRatio (shares of back-/lay-initiated volume, unrounded, sum to 1)}.",
  dataKeys: ["tradedPricesData"],
  history: true,
  noData: NOT_RECORDED,
  build(ctx) {
    return perSelection(ctx, (rc) => {
      const sel = ctx.selection(rc);
      const startPrice = sel?.startPrice;
      const endPrice = ctx.runner(rc)?.lastPriceTraded ?? sel?.lastPrice;
      const window = extremes([...recordedPoints(sel, ctx.volumeData).map((p) => p.price), startPrice, endPrice].filter(isPrice));
      if (!window) return undefined;
      const { back, lay } = sideVolumes(sel?.trades);
      const classified = back.volume + lay.volume;
      const ratios = ctx.volumeData && classified > 0;
      return {
        tradedPricesData: {
          startPrice,
          endPrice,
          minPrice: window.min,
          maxPrice: window.max,
          tradedVolume: ctx.volumeData ? (round(sumSizes(sel?.trades)) ?? 0) : undefined,
          backRatio: ratios ? back.volume / classified : undefined,
          layRatio: ratios ? lay.volume / classified : undefined,
        },
      };
    });
  },
};

const priceMetrics: Provider = {
  name: "MarketSelectionsPriceMetricData",
  status: "available",
  description:
    "priceMetricsData [{time, ohlc {open, high, low, close}, vwap {price, volume}}]: hourly windows anchored at trades (same rule as the candles with 3600 s), the last 2, oldest first, from trades recorded since open_market.",
  dataKeys: ["priceMetricsData"],
  history: true,
  noData: NOT_RECORDED,
  build(ctx) {
    return perSelection(ctx, (rc) => {
      const windows = anchoredWindows(recordedPoints(ctx.selection(rc), ctx.volumeData), METRIC_WINDOW_MS).slice(-METRIC_COUNT);
      return {
        priceMetricsData: windows.length
          ? windows.map((w) => ({
              time: ctx.time(w.time),
              ohlc: { open: w.open, high: w.high, low: w.low, close: w.close },
              vwap: ctx.volumeData && w.volume > 0 ? { price: round(w.notional / w.volume, 4), volume: round(w.volume) } : undefined,
            }))
          : undefined,
      };
    });
  },
};

// ------------------------------------------------------------------ book providers

const weightOfMoney: Provider = {
  name: "WeightOfMoneyData",
  status: "available",
  description:
    'averageBackTraded / averageLayTraded {price (VWAP), volume} of back- and lay-initiated trades recorded since open_market; offeredPrices [{betType, price, volume}] at full depth where betType "Back" rows are Betfair availableToBack levels (money offered by layers) and "Lay" rows are availableToLay levels (money from backers); tradedPrices [{price, volume}] = the complete traded ladder; weightOfMoneySummary {backersWaiting, layersWaiting, backingPressure, nearBookBackingPressure (top 5 levels)}.',
  dataKeys: ["averageBackTraded", "averageLayTraded", "offeredPrices", "tradedPrices", "weightOfMoneySummary"],
  allOffers: true,
  history: true,
  noData: "Betfair returned no offered or traded prices for this market. Continue the analysis without it.",
  build(ctx) {
    return perSelection(ctx, (rc) => {
      const runner = ctx.runner(rc);
      const toBack = runner?.ex?.availableToBack ?? [];
      const toLay = runner?.ex?.availableToLay ?? [];
      const traded = (runner?.ex?.tradedVolume ?? []).filter((l) => l.size > 0).sort((a, b) => a.price - b.price);
      const { back, lay } = sideVolumes(ctx.volumeData ? ctx.selection(rc)?.trades : undefined);
      const backers = sumSizes(toLay);
      const layers = sumSizes(toBack);
      const nearBackers = sumSizes(toLay.slice(0, 5));
      const nearLayers = sumSizes(toBack.slice(0, 5));
      const offered = [
        ...toBack.map((l) => ({ betType: "Back", price: l.price, volume: round(l.size) })),
        ...toLay.map((l) => ({ betType: "Lay", price: l.price, volume: round(l.size) })),
      ];
      return {
        averageBackTraded: back.volume > 0 ? { price: round(back.notional / back.volume, 4), volume: round(back.volume) } : undefined,
        averageLayTraded: lay.volume > 0 ? { price: round(lay.notional / lay.volume, 4), volume: round(lay.volume) } : undefined,
        offeredPrices: offered.length ? offered : undefined,
        tradedPrices: traded.length ? traded.map((l) => ({ price: l.price, volume: round(l.size) })) : undefined,
        weightOfMoneySummary:
          backers + layers > 0
            ? {
                backersWaiting: round(backers),
                layersWaiting: round(layers),
                backingPressure: round(backers / (backers + layers), 3),
                nearBookBackingPressure: nearBackers + nearLayers > 0 ? round(nearBackers / (nearBackers + nearLayers), 3) : undefined,
              }
            : undefined,
      };
    });
  },
};

const betfairSp: Provider = {
  name: "BetfairSpData",
  status: "available",
  description:
    "price (last traded, as get_active_market), betfairSP (actual SP, else the projected near price), industryStartingPrice (bookmakers' forecast price), eVforPriceOrBetfairSP (max(price, betfairSP) / industryStartingPrice - 1), plus nearPrice, farPrice, actualSP, betfairSPIsProjected, backStakeTaken, layLiabilityTaken.",
  dataKeys: [
    "price",
    "betfairSP",
    "industryStartingPrice",
    "eVforPriceOrBetfairSP",
    "nearPrice",
    "farPrice",
    "actualSP",
    "betfairSPIsProjected",
    "backStakeTaken",
    "layLiabilityTaken",
  ],
  sp: true,
  noData: "Betfair returned no prices for this market. Continue the analysis without it.",
  build(ctx) {
    return perSelection(ctx, (rc) => {
      const runner = ctx.runner(rc);
      if (!runner) return undefined;
      const sp = runner.sp;
      const actual = finite(sp?.actualSP);
      const near = finite(sp?.nearPrice);
      const betfairSP = actual ?? near;
      const forecast = forecastPrice(rc.metadata);
      // EV uses real prices only: the 1000 "no price" placeholder would look like huge value.
      const observed = runner.lastPriceTraded ?? runner.ex?.availableToBack?.[0]?.price;
      const best = Math.max(observed ?? 0, betfairSP ?? 0);
      return {
        price: marketToolPrice(runner),
        betfairSP: round(betfairSP),
        industryStartingPrice: round(forecast),
        eVforPriceOrBetfairSP: forecast !== undefined && best > 1 ? round(best / forecast - 1, 4) : undefined,
        nearPrice: round(near),
        farPrice: round(finite(sp?.farPrice)),
        actualSP: round(actual),
        betfairSPIsProjected: sp ? actual === undefined : undefined,
        backStakeTaken: sp ? round(sumSizes(sp.backStakeTaken)) : undefined,
        layLiabilityTaken: sp ? round(sumSizes(sp.layLiabilityTaken)) : undefined,
      };
    });
  },
};

// ------------------------------------------------------------------ racing providers

const NO_METADATA = "Betfair publishes no runner metadata (form, ratings, weights) for this market; it exists only for horse racing. Continue the analysis without it.";

const horsesForm: Provider = {
  name: "HorsesBaseBetfairFormData",
  status: "available",
  description:
    "Betfair runner metadata: forecastPrice (decimal), form, officialRating, weight (lbs, number), age, sex, jockey, jockeyClaim, trainer, owner, stallDraw, clothNumber, daysSinceLastRun, wearing, sire, dam, damsire, adjustedRating.",
  dataKeys: [
    "forecastPrice",
    "form",
    "officialRating",
    "weight",
    "age",
    "sex",
    "jockey",
    "jockeyClaim",
    "trainer",
    "owner",
    "stallDraw",
    "clothNumber",
    "daysSinceLastRun",
    "wearing",
    "sire",
    "dam",
    "damsire",
    "adjustedRating",
  ],
  bookless: true,
  noData: NO_METADATA,
  build(ctx) {
    return perSelection(ctx, (rc) => {
      const m = rc.metadata;
      if (!m) return undefined;
      return {
        forecastPrice: round(forecastPrice(m)),
        form: metaText(m.FORM),
        officialRating: metaNumber(m.OFFICIAL_RATING),
        weight: weightLbs(m),
        age: metaNumber(m.AGE),
        sex: genderName(m.SEX_TYPE),
        jockey: metaText(m.JOCKEY_NAME),
        jockeyClaim: metaNumber(m.JOCKEY_CLAIM),
        trainer: metaText(m.TRAINER_NAME),
        owner: metaText(m.OWNER_NAME),
        stallDraw: metaNumber(m.STALL_DRAW),
        clothNumber: metaNumberOrText(m.CLOTH_NUMBER_ALPHA ?? m.CLOTH_NUMBER),
        daysSinceLastRun: metaNumber(m.DAYS_SINCE_LAST_RUN),
        wearing: metaText(m.WEARING),
        sire: metaText(m.SIRE_NAME),
        dam: metaText(m.DAM_NAME),
        damsire: metaText(m.DAMSIRE_NAME),
        adjustedRating: metaNumber(m.ADJUSTED_RATING),
      };
    });
  },
};

const winToBePlaced: Provider = {
  name: "HorseRacingWinToBePlacedData",
  status: "available",
  description:
    "Win vs To Be Placed markets (connector-defined keys): winToBePlacedData {initialWinPrice, currentWinPrice, initialPlacePrice, currentPlacePrice, winTradedVolume, placeTradedVolume} per selection (initial = first price recorded since monitoring began; the PLACE market is monitored automatically) and market-level placeMarket {marketId, numberOfWinners, timeToRaceMinutes}.",
  dataKeys: ["winToBePlacedData"],
  marketDataKeys: ["placeMarket"],
  history: true,
  noData: "No data for the WIN and PLACE markets of this race. Continue the analysis without it.",
  async build(ctx) {
    const type = ctx.catalogue.description?.marketType;
    if (type && type !== "WIN") {
      return { selections: new Map(), noData: `Needs a horse racing WIN market with a PLACE market; ${ctx.marketId} is a ${type} market.` };
    }
    const placeId = await ctx.placeMarketId();
    if (!placeId) {
      return { selections: new Map(), noData: "No PLACE (To Be Placed) market was found for this race. Continue the analysis without it." };
    }
    let placeBook: MarketBook;
    if (ctx.state.monitored.has(placeId)) placeBook = await ctx.markets.getBook(placeId);
    else {
      placeBook = (await ctx.markets.openMarket(placeId, { companionOf: ctx.marketId })).book;
      ctx.note(
        `The PLACE market ${placeId} was not monitored, so its recording starts now: initialPlacePrice equals the current price until it has been monitored for a while.`,
      );
    }
    const placeRunners = new Map(placeBook.runners.map((r) => [formatSelectionId(r.selectionId, r.handicap), r]));
    const placeRecording = ctx.markets.recorder.get(placeId);
    const output = perSelection(ctx, (rc) => {
      const key = formatSelectionId(rc.selectionId, rc.handicap);
      const win = ctx.runner(rc);
      const place = placeRunners.get(key);
      return {
        winToBePlacedData: present({
          initialWinPrice: ctx.selection(rc)?.startPrice,
          currentWinPrice: win?.lastPriceTraded,
          initialPlacePrice: placeRecording?.selections.get(key)?.startPrice,
          currentPlacePrice: place?.lastPriceTraded,
          winTradedVolume: round(win?.totalMatched),
          placeTradedVolume: round(place?.totalMatched),
        }),
      };
    });
    const start = ctx.catalogue.marketStartTime ?? ctx.catalogue.description?.marketTime;
    output.market = {
      placeMarket: {
        marketId: placeId,
        numberOfWinners: placeBook.numberOfWinners,
        timeToRaceMinutes: start ? round((Date.parse(start) - ctx.now) / 60_000, 1) : undefined,
      },
    };
    return output;
  },
};

const RACE_INFO_REASON = "pastRaces only cover races this connector saw settle; no Racing Post/Timeform data";

/** Past WIN races per selection id from the settled-market archive, newest first. */
function pastRaces(archive: Map<string, SettledMarket>, excludeMarketId: string): Map<number, Array<{ at: string; race: Record<string, unknown> }>> {
  const bySelection = new Map<number, Array<{ at: string; race: Record<string, unknown> }>>();
  for (const market of archive.values()) {
    if (market.marketId === excludeMarketId || market.marketType?.toUpperCase() !== "WIN") continue;
    const ran = market.runners.filter((r) => !/^removed/i.test(r.status));
    const distance = raceDistanceYards(market.marketName);
    const date = market.startTime ? utcSeconds(market.startTime) : undefined;
    for (const runner of ran) {
      // Keys in BFExplorer's (alphabetical) order; unknown values are omitted, never invented.
      const race = compact({
        date,
        distance,
        inPlayMaxPrice: runner.inPlayMax,
        inPlayMinPrice: runner.inPlayMin,
        position: runner.status === "Winner" ? `1/${ran.length}` : undefined,
        price: round(runner.bsp),
      });
      const list = bySelection.get(runner.selectionId) ?? [];
      list.push({ at: market.startTime ?? market.settledAt, race });
      bySelection.set(runner.selectionId, list);
    }
  }
  const time = (iso: string) => Date.parse(iso) || 0;
  for (const list of bySelection.values()) list.sort((a, b) => time(b.at) - time(a.at));
  return bySelection;
}

const raceInfo: Provider = {
  name: "HorsesBetfairRaceInfoData",
  status: "partial",
  reason: RACE_INFO_REASON,
  description:
    'horseDetail {age, gender, pastRaces [{date (UTC), distance (yards), inPlayMaxPrice, inPlayMinPrice, position ("1/N" for winners only), price (BSP)}] newest first (up to 6), weight (lbs)} from Betfair runner metadata and the markets this connector saw settle.',
  dataKeys: ["horseDetail"],
  bookless: true,
  noData: NO_METADATA,
  build(ctx) {
    const past = pastRaces(ctx.state.archive, ctx.marketId);
    return perSelection(ctx, (rc) => {
      const m = rc.metadata;
      const races = past.get(rc.selectionId)?.slice(0, PAST_RACES_MAX).map((p) => p.race);
      return {
        horseDetail: present({
          age: metaNumber(m?.AGE),
          gender: genderName(m?.SEX_TYPE),
          pastRaces: races?.length ? races : undefined,
          weight: weightLbs(m),
        }),
      };
    });
  },
};

export const PROVIDERS: Provider[] = [
  candleStick,
  priceHistory,
  tradedPrices,
  priceMetrics,
  weightOfMoney,
  betfairSp,
  horsesForm,
  winToBePlaced,
  raceInfo,
];

const PROVIDER_BY_NAME = new Map(PROVIDERS.map((p) => [p.name.toLowerCase(), p]));

export function findProvider(name: string): Provider | undefined {
  return PROVIDER_BY_NAME.get(name.trim().toLowerCase());
}

/** BFExplorer providers missing from BFEXPLORER_ONLY_CONTEXTS (listed in BFExplorer's provider reference). */
const EXTRA_BFEXPLORER_ONLY: typeof BFEXPLORER_ONLY_CONTEXTS = {
  PlayingFootballMatchScoresData: { source: "live football scores" },
};

/** BFExplorer-only providers (third-party feeds), excluding the ones implemented here. */
export const UNAVAILABLE_PROVIDERS = Object.entries({ ...BFEXPLORER_ONLY_CONTEXTS, ...EXTRA_BFEXPLORER_ONLY })
  .filter(([name]) => !PROVIDER_BY_NAME.has(name.toLowerCase()))
  .map(([name, info]) => ({ name, ...info }));

const UNAVAILABLE_BY_NAME = new Map(UNAVAILABLE_PROVIDERS.map((p) => [p.name.toLowerCase(), p]));

export function findUnavailableProvider(name: string) {
  return UNAVAILABLE_BY_NAME.get(name.trim().toLowerCase());
}
