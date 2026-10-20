import type { MarketBook, MarketCatalogue, PriceData, Runner, RunnerCatalog } from "../betfair/types.js";
import { assertMarketId, compact, formatSelectionId, localTime, marketStatusName, round, runnerStatusName, type SelectionRef } from "../format.js";
import type { MarketService } from "../markets.js";
import type { MarketRecording } from "../recorder.js";
import type { State, StoredDataContext } from "../state.js";
import { findProvider, findUnavailableProvider, finite, PROVIDERS, UNAVAILABLE_PROVIDERS, type BuildContext, type Provider } from "./providers.js";
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
/** Result lookups for feedback: SP_TRADED weighs 7, so 25 markets stay under Betfair's 200 per request. */
const RESULT_BATCH = 25;
/** A market still open at a result lookup is asked again after this long. */
const RESULT_RETRY_MS = 5 * 60_000;
const RESULT_PROJECTION = { priceData: ["SP_TRADED"] as PriceData[] };

type Step = { name: string; provider: Provider } | { name: string; stored: StoredDataContext } | { name: string; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A JSON array sent as text (clients that serialise array arguments), or undefined when the text is not one. */
function jsonArray(text: string): unknown[] | undefined {
  if (!text.startsWith("[") || !text.endsWith("]")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split, trim and de-duplicate (case-insensitively) the requested context names, keeping the first
 * spelling. Accepts arrays, comma-separated text and JSON arrays sent as text; a bracketed list
 * that is not valid JSON (e.g. "[A, 'B']") loses its brackets and the quotes around each name.
 */
export function normaliseNames(names: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (raw: unknown) => {
    if (Array.isArray(raw)) {
      for (const item of raw) add(item);
      return;
    }
    if (typeof raw !== "string") return;
    const text = raw.trim();
    const parsed = jsonArray(text);
    if (parsed) {
      add(parsed);
      return;
    }
    const list = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
    for (const part of list.split(",")) {
      const name = part.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      result.push(name);
    }
  };
  add(names);
  return result;
}

function hasOffers(book: MarketBook): boolean {
  return book.runners.some((r) => (r.ex?.availableToBack?.length ?? 0) > 0 || (r.ex?.availableToLay?.length ?? 0) > 0);
}

/** Data-context provider service producing BFExplorer's envelope (get_all_data_context_for_market). */
export class DataContextService implements DataContextApi {
  /** WIN market id -> PLACE market id. */
  private readonly placeMarkets = new Map<string, string>();
  /** marketId -> earliest time (ms) its result may be looked up again (Infinity once settled or purged). */
  private readonly resultLookups = new Map<string, number>();

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

    let catalogue: MarketCatalogue;
    try {
      catalogue = await this.markets.getCatalogue(id);
    } catch (error) {
      // Stored AI-agent contexts outlive Betfair's catalogue of a settled market: still return them.
      if (only || !steps.some((s) => "stored" in s)) throw error;
      return this.storedOnly(id, steps, errorMessage(error));
    }
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
      refreshResults: (marketIds) => this.refreshResults(marketIds),
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

  /** Envelope for a market Betfair no longer describes: stored contexts only, providers report why. */
  private storedOnly(marketId: string, steps: Step[], catalogueError: string): DataContextEnvelope {
    const data: Record<string, unknown> = {};
    const unavailable: Record<string, string> = {};
    for (const step of steps) {
      if ("stored" in step) data[step.name] = step.stored.data;
      else if ("reason" in step) unavailable[step.name] = step.reason;
      else unavailable[step.name] = `${catalogueError} Continue the analysis without it.`;
    }
    const envelope: DataContextEnvelope = { market: this.header(undefined, marketId, this.knownStatus(marketId)), selectionsData: [], data };
    if (Object.keys(unavailable).length) envelope.unavailableDataContexts = unavailable;
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

  /**
   * Stored contexts with this name for the last N settled (closed) markets, newest first, joined
   * with their results, as BFExplorer counts forLastResults. With includeOpen, markets that have
   * not settled are returned (and counted) too.
   */
  async feedback(dataContextName: string, forLastResults: number, options: { includeOpen?: boolean } = {}): Promise<FeedbackEntry[]> {
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
    if (options.includeOpen) {
      const latest = found.slice(0, limit);
      await this.refreshResults([...new Set(latest.map((f) => f.marketId))]);
      return latest.map(({ marketId, stored }) => this.feedbackEntry(marketId, stored));
    }
    // Look results up a batch at a time, newest first, until enough settled markets are found.
    const latest: typeof found = [];
    for (let i = 0; i < found.length && latest.length < limit; i += RESULT_BATCH) {
      const batch = found.slice(i, i + RESULT_BATCH);
      const now = Date.now();
      await this.refreshResults([...new Set(batch.filter((f) => !this.notStarted(f.marketId, now)).map((f) => f.marketId))]);
      for (const f of batch) if (latest.length < limit && this.state.archive.has(f.marketId)) latest.push(f);
    }
    return latest.map(({ marketId, stored }) => this.feedbackEntry(marketId, stored));
  }

  /** A market whose known start is still ahead cannot have settled: no result lookup needed. */
  private notStarted(marketId: string, now: number): boolean {
    if (this.state.archive.has(marketId)) return false;
    const start = Date.parse(this.markets.cachedCatalogue(marketId)?.marketStartTime ?? "");
    return Number.isFinite(start) && start > now;
  }

  private needsResult(marketId: string, now: number): boolean {
    if ((this.resultLookups.get(marketId) ?? 0) > now) return false;
    const settled = this.state.archive.get(marketId);
    // MarketService archives BSPs only from books fetched with SP; a poll without it leaves them empty.
    return !settled || settled.runners.every((r) => r.bsp === undefined);
  }

  /**
   * Best effort: results (with BSP) of markets that settled while the connector was not polling
   * them, read straight from the API so the recorder (and its live recordings) is untouched.
   */
  private async refreshResults(marketIds: string[]) {
    const now = Date.now();
    // An invalid id would make Betfair reject the whole batch.
    const ids = marketIds.filter((id) => /^\d\.\d+$/.test(id) && this.needsResult(id, now));
    for (let i = 0; i < ids.length; i += RESULT_BATCH) {
      const batch = ids.slice(i, i + RESULT_BATCH);
      try {
        const books = await this.markets.api.listMarketBook({ marketIds: batch, priceProjection: RESULT_PROJECTION });
        const returned = new Set(books.map((b) => b.marketId));
        const missing = batch.filter((id) => !returned.has(id));
        // Betfair leaves CLOSED markets out of a request that also holds OPEN ones.
        if (missing.length && books.some((b) => b.status !== "CLOSED")) {
          books.push(...(await this.markets.api.listMarketBook({ marketIds: missing, priceProjection: RESULT_PROJECTION })));
        }
        const byId = new Map(books.map((b) => [b.marketId, b]));
        for (const id of batch) {
          const book = byId.get(id);
          const settled = book?.status === "CLOSED" && book.runners.every((r) => r.status !== "ACTIVE");
          if (book && settled) this.archiveResult(book);
          this.resultLookups.set(id, !book || settled ? Infinity : now + RESULT_RETRY_MS);
        }
      } catch {
        // Results are optional: feedback still returns the stored contexts.
      }
    }
  }

  private archiveResult(book: MarketBook) {
    this.markets.archiveSettled(book);
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
