import type { MarketBook, MarketCatalogue, Runner, RunnerCatalog } from "../betfair/types.js";
import { assertMarketId, compact, formatSelectionId, localTime, marketStatusName, round, type SelectionRef } from "../format.js";
import type { MarketService } from "../markets.js";
import type { MarketRecording } from "../recorder.js";
import type { State, StoredDataContext } from "../state.js";
import { findProvider, findUnavailableProvider, PROVIDERS, UNAVAILABLE_PROVIDERS, type BuildContext, type Provider } from "./providers.js";
import type { DataContextApi, DataContextEnvelope, DataContextMarket, FeedbackEntry, ProviderInfo } from "./types.js";

export interface ContextOptions {
  /** IANA zone for data-context times (DISPLAY_TIMEZONE). */
  timeZone: string;
}

const AI_CONTEXT_DESCRIPTION = "AI-agent data stored with set_ai_agent_data_context_for_market";
/** Below this much recorded history (12 five-minute candles) the envelope says how little there is. */
const SHORT_HISTORY_MINUTES = 60;
const MAX_FEEDBACK = 1000;
const DEFAULT_FEEDBACK = 100;
const MAX_CACHED_PLACE_MARKETS = 1000;

type Step = { name: string; provider: Provider } | { name: string; stored: StoredDataContext } | { name: string; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Split, trim and de-duplicate (case-insensitively) the requested context names, keeping the first spelling. */
function normaliseNames(names: string[] | string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ([] as unknown[]).concat(names)) {
    if (typeof raw !== "string") continue;
    for (const part of raw.split(",")) {
      const name = part.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      result.push(name);
    }
  }
  return result;
}

function hasOffers(book: MarketBook): boolean {
  return book.runners.some((r) => (r.ex?.availableToBack?.length ?? 0) > 0 || (r.ex?.availableToLay?.length ?? 0) > 0);
}

/** Data-context provider service producing BFExplorer's envelope (get_all_data_context_for_market). */
export class DataContextService implements DataContextApi {
  /** WIN market id -> PLACE market id. */
  private readonly placeMarkets = new Map<string, string>();

  constructor(
    protected readonly markets: MarketService,
    protected readonly state: State,
    protected readonly options: ContextOptions,
  ) {}

  private time(value: number | string): string {
    return localTime(value, this.options.timeZone);
  }

  /** A stored AI-agent context by name (exact name first, then case-insensitively). */
  private storedContext(marketId: string, name: string): StoredDataContext | undefined {
    const contexts = this.state.dataContexts.get(marketId);
    if (!contexts) return undefined;
    const exact = contexts.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    for (const [key, value] of contexts) if (key.toLowerCase() === lower) return value;
    return undefined;
  }

  private resolve(marketId: string, name: string): Step {
    const provider = findProvider(name);
    if (provider) return { name, provider };
    const stored = this.storedContext(marketId, name);
    if (stored) return { name, stored };
    const bfexplorerOnly = findUnavailableProvider(name);
    if (bfexplorerOnly) {
      return { name, reason: `Not available in this connector: requires ${bfexplorerOnly.source} (BFExplorer only). Continue the analysis without it.` };
    }
    return { name, reason: `Unknown data context "${name}". Call get_available_data_context_providers for the list.` };
  }

  private async placeMarketId(catalogue: MarketCatalogue): Promise<string | undefined> {
    const cached = this.placeMarkets.get(catalogue.marketId);
    if (cached) return cached;
    const place = await this.markets.findSiblingMarket(catalogue, "PLACE");
    if (!place) return undefined;
    this.placeMarkets.set(catalogue.marketId, place.marketId);
    if (this.placeMarkets.size > MAX_CACHED_PLACE_MARKETS) this.placeMarkets.delete(this.placeMarkets.keys().next().value as string);
    return place.marketId;
  }

  private header(catalogue: MarketCatalogue | undefined, marketId: string, status: string | undefined): DataContextMarket {
    const start = catalogue?.marketStartTime ?? catalogue?.description?.marketTime;
    return compact({
      marketId,
      startTime: start ? this.time(start) : undefined,
      eventType: catalogue?.eventType?.name || undefined,
      eventName: catalogue?.event?.venue || catalogue?.event?.name || undefined,
      marketName: catalogue?.marketName ?? marketId,
      status,
    });
  }

  /** Status when Betfair returned no book: settled markets are closed, else the last monitored status. */
  private knownStatus(marketId: string): string | undefined {
    return this.state.archive.has(marketId) ? "Closed" : this.state.monitored.get(marketId)?.status;
  }

  async getForMarket(marketId: string, names: string[], only?: SelectionRef): Promise<DataContextEnvelope> {
    const id = assertMarketId(marketId);
    const requested = normaliseNames(names);
    if (!requested.length) throw new Error("dataContextNames must contain at least one data context name.");
    const steps = requested.map((name) => this.resolve(id, name));
    const providers = steps.flatMap((s) => ("provider" in s ? [s.provider] : []));

    const catalogue = await this.markets.getCatalogue(id);
    const runners = only
      ? [this.markets.findRunner(catalogue, only)]
      : (catalogue.runners ?? []).slice().sort((a, b) => a.sortPriority - b.sortPriority);

    const notes: string[] = [];
    const wantsAllOffers = providers.some((p) => p.allOffers);
    const wantsSp = providers.some((p) => p.sp);
    let book: MarketBook | undefined;
    let bookError: string | undefined;
    try {
      book = await this.markets.getBook(id, { depth: 3, allOffers: wantsAllOffers, sp: wantsSp });
      // Delayed application keys get no EX_ALL_OFFERS: fall back to the best three levels.
      if (wantsAllOffers && book.status === "OPEN" && !hasOffers(book)) {
        const fallback = await this.markets.getBook(id, { depth: 3, sp: wantsSp });
        if (hasOffers(fallback)) {
          book = fallback;
          notes.push(
            "Full-depth offers (EX_ALL_OFFERS) came back empty, as they do for delayed application keys: offeredPrices shows only the best 3 levels per side.",
          );
        }
      }
    } catch (error) {
      bookError = errorMessage(error);
    }

    const recording = this.markets.recorder.get(id);
    const volumeData = Boolean(recording?.volumeData && !recording.delayed);
    const bookRunners = new Map((book?.runners ?? []).map((r) => [formatSelectionId(r.selectionId, r.handicap), r]));
    const providerNotes: string[] = [];
    const ctx: BuildContext = {
      marketId: id,
      catalogue,
      book,
      runners,
      runner: (rc: RunnerCatalog): Runner | undefined => bookRunners.get(formatSelectionId(rc.selectionId, rc.handicap)),
      recording,
      selection: (rc: RunnerCatalog) => recording?.selections.get(formatSelectionId(rc.selectionId, rc.handicap)),
      volumeData,
      time: (value) => this.time(value),
      now: Date.now(),
      note: (text) => {
        if (!providerNotes.includes(text)) providerNotes.push(text);
      },
      markets: this.markets,
      state: this.state,
      placeMarketId: () => this.placeMarketId(catalogue),
    };

    const selectionData = new Map(runners.map((rc) => [formatSelectionId(rc.selectionId, rc.handicap), {} as Record<string, unknown>]));
    const marketData: Record<string, unknown> = {};
    const unavailable: Record<string, string> = {};
    const partial: Record<string, string> = {};
    for (const step of steps) {
      if ("reason" in step) {
        unavailable[step.name] = step.reason;
        continue;
      }
      if ("stored" in step) {
        marketData[step.name] = step.stored.data;
        continue;
      }
      const { provider } = step;
      if (!book && !provider.bookless) {
        unavailable[step.name] = `Betfair returned no market book for ${id} (${bookError}). Continue the analysis without it.`;
        continue;
      }
      try {
        const output = await provider.build(ctx);
        const market = output.market ? compact(output.market) : {};
        if (!output.selections.size && !Object.keys(market).length) {
          unavailable[step.name] = output.noData ?? provider.noData;
          continue;
        }
        for (const [key, data] of output.selections) Object.assign(selectionData.get(key) ?? {}, data);
        Object.assign(marketData, market);
        if (provider.status === "partial" && provider.reason) partial[step.name] = provider.reason;
      } catch (error) {
        unavailable[step.name] = `${provider.name} failed: ${errorMessage(error)}. Continue the analysis without it.`;
      }
    }

    const envelope: DataContextEnvelope = {
      market: this.header(catalogue, catalogue.marketId, book ? marketStatusName(book.status) : this.knownStatus(id)),
      selectionsData: runners.map((rc) => {
        const key = formatSelectionId(rc.selectionId, rc.handicap);
        return compact({ selectionId: key, name: rc.runnerName, data: selectionData.get(key) });
      }),
    };
    // Stored AI-agent JSON is passed through verbatim (no compact()).
    if (Object.keys(marketData).length) envelope.data = marketData;
    if (Object.keys(unavailable).length) envelope.unavailableDataContexts = unavailable;
    if (Object.keys(partial).length) envelope.partialDataContexts = partial;
    if (providers.some((p) => p.history)) envelope.recording = this.recordingInfo(id, recording, volumeData, [...notes, ...providerNotes]);
    return envelope;
  }

  private recordingInfo(marketId: string, rec: MarketRecording | undefined, volumeData: boolean, extraNotes: string[]): DataContextEnvelope["recording"] {
    const notes: string[] = [];
    const monitored = this.state.monitored.has(marketId);
    const minutes = rec ? (round((rec.lastAt - rec.startedAt) / 60_000, 1) ?? 0) : 0;
    if (!rec) notes.push("Nothing has been recorded for this market: open it with open_market so the connector records its trades.");
    else if (!monitored) {
      notes.push(
        `This market is not monitored, so trades are only recorded when it is read (${minutes} minutes so far): open it with open_market for a continuous history.`,
      );
    } else if (minutes < SHORT_HISTORY_MINUTES) {
      notes.push(`History starts when the market was opened with open_market; only ${minutes} minutes recorded so far.`);
    }
    if (rec && !volumeData) {
      notes.push(
        rec.delayed
          ? "Delayed application key: no traded volume, so volumes/VWAP/ratios are unavailable."
          : "Betfair returned no traded volume for this market, so volumes/VWAP/ratios are unavailable.",
      );
    }
    notes.push(...extraNotes);
    return compact({
      since: rec ? this.time(rec.startedAt) : undefined,
      minutes,
      volumeDataAvailable: volumeData,
      note: notes.length ? notes.join(" ") : undefined,
    });
  }

  providers(marketId?: string): ProviderInfo[] {
    const stored = marketId ? [...(this.state.dataContexts.get(marketId)?.keys() ?? [])] : [];
    const storedNames = new Set(stored.map((name) => name.toLowerCase()));
    const list: ProviderInfo[] = PROVIDERS.map((p) => ({
      name: p.name,
      status: p.status,
      description: p.description,
      dataKeys: [...p.dataKeys],
      ...(p.marketDataKeys ? { marketDataKeys: [...p.marketDataKeys] } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
    }));
    for (const p of UNAVAILABLE_PROVIDERS) {
      if (storedNames.has(p.name.toLowerCase())) continue; // a stored AI-agent context of that name is served instead
      list.push({
        name: p.name,
        status: "unavailable",
        description: `BFExplorer provider built on ${p.source}.`,
        dataKeys: [...(p.dataKeys ?? [])],
        ...(p.marketDataKeys ? { marketDataKeys: [...p.marketDataKeys] } : {}),
        reason: `Requires ${p.source}, which only the BFExplorer desktop app provides.`,
      });
    }
    for (const name of stored) {
      if (findProvider(name)) continue; // implemented providers take precedence when requested
      list.push({ name, status: "available", description: AI_CONTEXT_DESCRIPTION, dataKeys: [], marketDataKeys: [name] });
    }
    return list;
  }

  async feedback(dataContextName: string, forLastResults: number): Promise<FeedbackEntry[]> {
    const wanted = String(dataContextName ?? "").trim().toLowerCase();
    if (!wanted) throw new Error("dataContextName is required.");
    const requested = Number.isFinite(forLastResults) ? Math.floor(forLastResults) : DEFAULT_FEEDBACK;
    const limit = Math.min(Math.max(requested, 1), MAX_FEEDBACK);
    const found: Array<{ marketId: string; stored: StoredDataContext }> = [];
    for (const [marketId, contexts] of this.state.dataContexts) {
      for (const [name, stored] of contexts) if (name.toLowerCase() === wanted) found.push({ marketId, stored });
    }
    const storedAt = (s: StoredDataContext) => Date.parse(s.updatedAt) || 0;
    found.sort((a, b) => storedAt(b.stored) - storedAt(a.stored));
    return found.slice(0, limit).map(({ marketId, stored }) => this.feedbackEntry(marketId, stored));
  }

  private feedbackEntry(marketId: string, stored: StoredDataContext): FeedbackEntry {
    const settled = this.state.archive.get(marketId);
    const catalogue = this.markets.cachedCatalogue(marketId);
    let storedAt = stored.updatedAt;
    try {
      storedAt = this.time(stored.updatedAt);
    } catch {
      // Keep the stored text when it is not a valid date.
    }
    const entry: FeedbackEntry = {
      market: { ...this.header(catalogue, marketId, this.knownStatus(marketId)), settled: Boolean(settled) },
      data: stored.data,
      storedAt,
    };
    if (settled) {
      const runners = settled.runners
        .map((r, i) => ({ r, order: r.sortPriority ?? Number.MAX_SAFE_INTEGER, i }))
        .sort((a, b) => a.order - b.order || a.i - b.i)
        .map(({ r }) =>
          compact({
            selectionId: formatSelectionId(r.selectionId, r.handicap),
            name: r.name,
            status: r.status,
            isWinner: r.status === "Winner",
            bsp: round(r.bsp),
          }),
        );
      entry.result = { runners };
    }
    return entry;
  }
}
