import type { MarketBook, MarketCatalogue, PriceData, PriceSize, Runner, RunnerCatalog } from "./betfair/types.js";
import { formatSelectionId, round, type MarketService, type SelectionRef, sameSelection } from "./markets.js";
import type { Snapshot, State } from "./state.js";

interface BuildInput {
  catalogue: MarketCatalogue;
  book: MarketBook;
  runnerCatalog: RunnerCatalog;
  runner?: Runner;
  history: Snapshot[];
}

interface DataContextProvider {
  name: string;
  description: string;
  priceData: PriceData[];
  build(input: BuildInput): Record<string, unknown> | undefined;
}

/** Providers that exist in BFExplorer but rely on third-party data feeds this connector does not have. */
export const BFEXPLORER_ONLY_CONTEXTS: Record<string, string> = {
  RacingpostDataForHorses: "Racing Post form and ratings",
  TimeformDataForHorses: "Timeform indicators",
  TimeformFullDataForHorses: "Timeform full data",
  AtTheRacesDataForHorses: "At The Races form and expert views",
  RacingTvDataForHorses: "Racing TV form",
  HorsesBetfairRaceInfoData: "Betfair race info",
  OlbgRaceTipsData: "OLBG tipster data",
  RacingStattoData: "RacingStatto statistics",
  FootballMatchScoreData: "live football scores",
  HorseRacingWinToBePlacedData: "win vs to-be-placed market comparison",
  AtTheRacesBookmakersOdds: "At The Races bookmaker odds",
  MarketSelectionsPriceMetricData: "BFExplorer price metrics",
  HorsesNigelsRaceCard: "Nigel's race card",
  HorsesNigelsRaceTissue: "Nigel's race tissue prices",
  HorsesNigelsRaceRadar: "Nigel's race radar",
  HorsesNigelsRaceTrainerHeatmap: "Nigel's trainer heatmap",
  HorsesNigelsRaceJockeyHeatmap: "Nigel's jockey heatmap",
};

const num = (value: string | null | undefined): number | undefined => {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const sum = (levels: PriceSize[] | undefined) => (levels ?? []).reduce((total, l) => total + l.size, 0);

function vwap(levels: PriceSize[] | undefined): number | undefined {
  const volume = sum(levels);
  if (!levels?.length || volume <= 0) return undefined;
  return levels.reduce((total, l) => total + l.price * l.size, 0) / volume;
}

function forecastPrice(meta: Record<string, string | null> | undefined): number | undefined {
  const numerator = num(meta?.FORECASTPRICE_NUMERATOR);
  const denominator = num(meta?.FORECASTPRICE_DENOMINATOR);
  if (numerator === undefined || !denominator) return undefined;
  return round(numerator / denominator + 1);
}

/** Trades recorded between snapshots, classified by where they printed relative to the previous best prices. */
function aggressorSplit(history: Snapshot[], key: string) {
  let backVolume = 0;
  let layVolume = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].s[key];
    const curr = history[i].s[key];
    if (!prev || !curr || prev[3] === null || curr[3] === null || curr[0] === null) continue;
    const traded = curr[3] - prev[3];
    if (traded <= 0) continue;
    const [, prevBack, prevLay] = prev;
    if (prevBack !== null && curr[0] >= prevBack) backVolume += traded;
    else if (prevLay !== null && curr[0] <= prevLay) layVolume += traded;
  }
  const total = backVolume + layVolume;
  return total > 0 ? { backRatio: round(backVolume / total, 3), layRatio: round(layVolume / total, 3), classifiedVolume: round(total) } : undefined;
}

function priceSeries(history: Snapshot[], key: string) {
  return history
    .map((snap) => ({ t: snap.t, tick: snap.s[key] }))
    .filter((p): p is { t: number; tick: NonNullable<typeof p.tick> } => Boolean(p.tick) && p.tick![0] !== null);
}

function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  const result: T[] = [];
  for (let i = 0; i < max - 1; i++) result.push(items[Math.floor(i * step)]);
  result.push(items[items.length - 1]);
  return result;
}

const PROVIDERS: DataContextProvider[] = [
  {
    name: "HorsesBaseBetfairFormData",
    description: "Betfair runner metadata: form figures, official rating, weight, age, jockey, trainer, draw, days since last run, headgear and forecast price.",
    priceData: [],
    build({ runnerCatalog }) {
      const m = runnerCatalog.metadata;
      if (!m) return undefined;
      return {
        form: m.FORM ?? undefined,
        officialRating: num(m.OFFICIAL_RATING),
        adjustedRating: num(m.ADJUSTED_RATING),
        age: num(m.AGE),
        weight: m.WEIGHT_VALUE ? `${m.WEIGHT_VALUE}${m.WEIGHT_UNITS ? ` ${m.WEIGHT_UNITS}` : ""}` : undefined,
        daysSinceLastRun: num(m.DAYS_SINCE_LAST_RUN),
        jockey: m.JOCKEY_NAME ?? undefined,
        jockeyClaim: num(m.JOCKEY_CLAIM),
        trainer: m.TRAINER_NAME ?? undefined,
        owner: m.OWNER_NAME ?? undefined,
        stallDraw: num(m.STALL_DRAW),
        clothNumber: m.CLOTH_NUMBER_ALPHA ?? m.CLOTH_NUMBER ?? undefined,
        wearing: m.WEARING ?? undefined,
        sex: m.SEX_TYPE ?? undefined,
        sire: m.SIRE_NAME ?? undefined,
        dam: m.DAM_NAME ?? undefined,
        damsire: m.DAMSIRE_NAME ?? undefined,
        forecastPrice: forecastPrice(m),
      };
    },
  },
  {
    name: "WeightOfMoneyData",
    description: "Full offered-price ladder and traded volumes: unmatched backers' vs layers' money, backing pressure, VWAP and traded-price distribution.",
    priceData: ["EX_ALL_OFFERS", "EX_TRADED"],
    build({ runner }) {
      if (!runner?.ex) return undefined;
      const toBack = runner.ex.availableToBack ?? [];
      const toLay = runner.ex.availableToLay ?? [];
      const nearBackers = sum(toLay.slice(0, 5));
      const nearLayers = sum(toBack.slice(0, 5));
      const backers = sum(toLay);
      const layers = sum(toBack);
      const traded = runner.ex.tradedVolume ?? [];
      const ltp = runner.lastPriceTraded;
      const shorter = ltp ? sum(traded.filter((l) => l.price <= ltp)) : undefined;
      const totalTraded = sum(traded);
      const offered = new Map<number, { price: number; availableToBack?: number; availableToLay?: number }>();
      for (const l of toBack.slice(0, 10)) offered.set(l.price, { price: l.price, availableToBack: round(l.size) });
      for (const l of toLay.slice(0, 10)) offered.set(l.price, { ...offered.get(l.price), price: l.price, availableToLay: round(l.size) });
      return {
        lastPriceTraded: ltp,
        backPrice: toBack[0]?.price,
        layPrice: toLay[0]?.price,
        unmatchedBackersMoney: round(backers),
        unmatchedLayersMoney: round(layers),
        backingPressure: backers + layers > 0 ? round(backers / (backers + layers), 3) : undefined,
        nearBookBackingPressure: nearBackers + nearLayers > 0 ? round(nearBackers / (nearBackers + nearLayers), 3) : undefined,
        offeredPrices: [...offered.values()].sort((a, b) => a.price - b.price),
        tradedVolume: round(totalTraded),
        volumeWeightedAveragePrice: round(vwap(traded)),
        tradedShareAtOrBelowLastPrice: shorter !== undefined && totalTraded > 0 ? round(shorter / totalTraded, 3) : undefined,
        tradedPrices: [...traded]
          .sort((a, b) => b.size - a.size)
          .slice(0, 20)
          .sort((a, b) => a.price - b.price)
          .map((l) => ({ price: l.price, volume: round(l.size) })),
      };
    },
  },
  {
    name: "MarketSelectionsTradedPricesData",
    description: "Traded price summary: start/end/min/max price, traded volume, VWAP and (when recorded) back/lay aggressor ratios.",
    priceData: ["EX_TRADED"],
    build({ runner, runnerCatalog, history }) {
      if (!runner) return undefined;
      const traded = (runner.ex?.tradedVolume ?? []).filter((l) => l.size > 0);
      const key = formatSelectionId(runnerCatalog.selectionId, runnerCatalog.handicap);
      const series = priceSeries(history, key);
      const startPrice = series[0]?.tick[0] ?? undefined;
      const endPrice = runner.lastPriceTraded;
      const prices = traded.map((l) => l.price);
      const split = aggressorSplit(history, key);
      return {
        startPrice,
        endPrice,
        minPrice: prices.length ? Math.min(...prices) : undefined,
        maxPrice: prices.length ? Math.max(...prices) : undefined,
        priceChangePercent: startPrice && endPrice ? round(((endPrice - startPrice) / startPrice) * 100) : undefined,
        tradedVolume: round(runner.totalMatched ?? sum(traded)),
        volumeWeightedAveragePrice: round(vwap(traded)),
        backRatio: split?.backRatio,
        layRatio: split?.layRatio,
        recordedMinutes: series.length > 1 ? round((series[series.length - 1].t - series[0].t) / 60000, 1) : 0,
      };
    },
  },
  {
    name: "BetfairSpData",
    description: "Betfair Starting Price: projected near/far SP, actual SP, SP stakes taken, forecast (industry) price and EV of the better of price or SP vs the forecast.",
    priceData: ["EX_BEST_OFFERS", "SP_AVAILABLE", "SP_TRADED"],
    build({ catalogue, runner, runnerCatalog }) {
      if (!runner) return undefined;
      const sp = runner.sp ?? {};
      const forecast = forecastPrice(runnerCatalog.metadata);
      const bsp = sp.actualSP ?? (Number.isFinite(sp.nearPrice) ? sp.nearPrice : undefined);
      const price = runner.ex?.availableToBack?.[0]?.price ?? runner.lastPriceTraded;
      const best = Math.max(price ?? 0, bsp ?? 0);
      return {
        bspMarket: catalogue.description?.bspMarket ?? false,
        nearPrice: round(sp.nearPrice),
        farPrice: round(sp.farPrice),
        actualSP: round(sp.actualSP),
        betfairSP: round(bsp),
        betfairSPIsProjected: sp.actualSP === undefined,
        backStakeTaken: round(sum(sp.backStakeTaken)),
        layLiabilityTaken: round(sum(sp.layLiabilityTaken)),
        industryStartingPrice: forecast,
        eVforPriceOrBetfairSP: forecast && best > 1 ? round(best / forecast - 1, 4) : undefined,
      };
    },
  },
  {
    name: "MarketSelectionsPriceHistoryData",
    description: "Price history recorded by this connector while the market is monitored (last traded, best back/lay, matched volume).",
    priceData: [],
    build({ runnerCatalog, history }) {
      const series = priceSeries(history, formatSelectionId(runnerCatalog.selectionId, runnerCatalog.handicap));
      return {
        points: downsample(series, 60).map(({ t, tick }) => ({
          time: new Date(t).toISOString(),
          price: tick[0],
          backPrice: tick[1],
          layPrice: tick[2],
          totalMatched: round(tick[3] ?? undefined),
        })),
      };
    },
  },
  {
    name: "MarketSelectionsCandleStickData",
    description: "OHLC candlesticks of last traded price with traded volume per candle, built from the connector's recorded price history.",
    priceData: [],
    build({ runnerCatalog, history }) {
      const series = priceSeries(history, formatSelectionId(runnerCatalog.selectionId, runnerCatalog.handicap));
      if (series.length < 2) return { intervalSeconds: 0, candles: [] };
      const span = series[series.length - 1].t - series[0].t;
      const intervalMs = Math.max(60_000, Math.ceil(span / 30 / 60_000) * 60_000);
      const candles: Array<{ time: string; open: number; high: number; low: number; close: number; volume?: number }> = [];
      let bucketStart = -1;
      let prevMatched: number | null = series[0].tick[3];
      for (const { t, tick } of series) {
        const price = tick[0]!;
        const bucket = Math.floor(t / intervalMs) * intervalMs;
        const traded = tick[3] !== null && prevMatched !== null ? Math.max(0, tick[3] - prevMatched) : 0;
        if (tick[3] !== null) prevMatched = tick[3];
        const last = candles[candles.length - 1];
        if (bucket !== bucketStart || !last) {
          bucketStart = bucket;
          candles.push({ time: new Date(bucket).toISOString(), open: price, high: price, low: price, close: price, volume: traded });
        } else {
          last.high = Math.max(last.high, price);
          last.low = Math.min(last.low, price);
          last.close = price;
          last.volume = (last.volume ?? 0) + traded;
        }
      }
      return {
        intervalSeconds: intervalMs / 1000,
        candles: candles.slice(-30).map((c) => ({ ...c, volume: round(c.volume) })),
      };
    },
  },
];

const PROVIDER_BY_NAME = new Map(PROVIDERS.map((p) => [p.name.toLowerCase(), p]));

export function listDataContextProviders(state: State, marketId?: string) {
  const stored = marketId ? [...(state.dataContexts.get(marketId)?.keys() ?? [])] : [];
  return {
    available: PROVIDERS.map((p) => ({ name: p.name, description: p.description })),
    aiAgentDataContexts: stored,
    notAvailable: Object.entries(BFEXPLORER_ONLY_CONTEXTS).map(([name, source]) => ({
      name,
      reason: `Requires ${source}, which only the BFExplorer desktop app provides.`,
    })),
    notes: [
      "Price history and candlestick contexts fill up while a market is monitored (OpenMarket). Open markets early for richer history.",
      "Any name stored with SetAIAgentDataContextForBetfairMarket can be read back with GetAllDataContextForMarket.",
    ],
  };
}

export class DataContextService {
  constructor(
    private readonly markets: MarketService,
    private readonly state: State,
  ) {}

  async getForMarket(marketId: string, names: string[], only?: SelectionRef) {
    const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (!unique.length) throw new Error("dataContextNames must contain at least one data context name.");
    const providers: DataContextProvider[] = [];
    const marketData: Record<string, unknown> = {};
    const unavailable: Record<string, string> = {};
    for (const name of unique) {
      const provider = PROVIDER_BY_NAME.get(name.toLowerCase());
      const stored = this.state.getDataContext(marketId, name);
      if (provider) providers.push(provider);
      else if (stored) marketData[name] = stored;
      else if (BFEXPLORER_ONLY_CONTEXTS[name]) unavailable[name] = `Not available in this connector: requires ${BFEXPLORER_ONLY_CONTEXTS[name]} (BFExplorer only). Continue the analysis without it.`;
      else unavailable[name] = `Unknown data context "${name}". Call GetAvailableDataContextProviders for the list.`;
    }

    const catalogue = await this.markets.getCatalogue(marketId);
    const priceData = new Set<PriceData>(providers.flatMap((p) => p.priceData));
    if (priceData.has("EX_ALL_OFFERS")) priceData.delete("EX_BEST_OFFERS");
    else priceData.add("EX_BEST_OFFERS");
    const book = await this.markets.getBook(marketId, [...priceData], 3);
    const view = this.markets.buildView(catalogue, book);
    const runners = new Map(book.runners.map((r) => [formatSelectionId(r.selectionId, r.handicap), r]));
    const history = this.state.history.get(catalogue.marketId) ?? [];

    const runnerCatalogs = (catalogue.runners ?? []).filter(
      (rc) => !only || sameSelection({ selectionId: rc.selectionId, handicap: rc.handicap }, only),
    );
    if (only && !runnerCatalogs.length) this.markets.findRunner(catalogue, only);

    const selectionsData = runnerCatalogs
      .sort((a, b) => a.sortPriority - b.sortPriority)
      .map((rc) => {
        const key = formatSelectionId(rc.selectionId, rc.handicap);
        const selection = view.selections.find((s) => s.selectionId === key)!;
        const entry: Record<string, unknown> = {
          selectionId: key,
          name: rc.runnerName,
          status: selection.status,
          price: selection.price,
          backPrice: selection.backPrice,
          layPrice: selection.layPrice,
        };
        for (const provider of providers) {
          const data = provider.build({ catalogue, book, runnerCatalog: rc, runner: runners.get(key), history });
          if (data) entry[provider.name] = data;
        }
        return entry;
      });

    return {
      market: view.market,
      selectionsData,
      ...(Object.keys(marketData).length ? { marketDataContexts: marketData } : {}),
      ...(Object.keys(unavailable).length ? { unavailableDataContexts: unavailable } : {}),
    };
  }
}
