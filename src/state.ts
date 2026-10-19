import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MarketCatalogue } from "./betfair/types.js";
import { emptyLedger, type PaperLedger } from "./exchange/paperTypes.js";
import type { BotState } from "./strategies/botTypes.js";
import type { StrategySetting } from "./strategies/types.js";

export interface MonitoredMarket {
  marketId: string;
  openedAt: string;
  /** Market status name ("Open", "Suspended", "Closed"...) from the latest book. */
  status?: string;
  inPlay?: boolean;
  /** Catalogue snapshot: Betfair stops returning catalogues once a market closes. */
  catalogue: MarketCatalogue;
  /** Set for markets monitored on behalf of another (e.g. the PLACE market of a WIN market). */
  companionOf?: string;
}

export interface StoredDataContext {
  data: unknown;
  updatedAt: string;
}

export interface SettledRunner {
  selectionId: number;
  handicap: number;
  name: string;
  /** Runner status name: Winner, Loser, Placed, Removed... */
  status: string;
  sortPriority?: number;
  /** Actual Betfair Starting Price when known. */
  bsp?: number;
  /** Lowest / highest traded price seen in-play by this connector. */
  inPlayMin?: number;
  inPlayMax?: number;
  lastPriceTraded?: number;
}

/** Results of markets this connector saw settle (feeds race history, feedback and closed-market reads). */
export interface SettledMarket {
  marketId: string;
  marketName: string;
  eventId?: string;
  eventName?: string;
  venue?: string;
  countryCode?: string;
  eventType?: string;
  marketType?: string;
  startTime?: string;
  settledAt: string;
  numberOfWinners?: number;
  runners: SettledRunner[];
}

interface PersistedState {
  version: 2;
  monitored: MonitoredMarket[];
  activeMarketId?: string;
  activeSelectionId?: string;
  dataContexts: Record<string, Record<string, StoredDataContext>>;
  strategies: StrategySetting[];
  strategyRefs: Record<string, string>;
  paper: PaperLedger;
  bots: BotState[];
  archive: SettledMarket[];
}

const MAX_CONTEXT_MARKETS = 2000;
const MAX_ARCHIVE = 5000;
const ARCHIVE_DAYS = 90;

/**
 * Durable connector state. Persisted to DATA_DIR/state.json (debounced, atomic rename)
 * when DATA_DIR is set; one process at a time owns DATA_DIR (others run read-only).
 */
export class State {
  monitored = new Map<string, MonitoredMarket>();
  activeMarketId?: string;
  activeSelectionId?: string;
  /** marketId -> data context name -> stored JSON (AI-agent written contexts). */
  dataContexts = new Map<string, Map<string, StoredDataContext>>();
  customStrategies = new Map<string, StrategySetting>();
  /** customerStrategyRef (<= 15 chars) -> strategy setting name. */
  strategyRefs = new Map<string, string>();
  paper: PaperLedger = emptyLedger();
  bots: BotState[] = [];
  archive = new Map<string, SettledMarket>();
  /** Set when another process holds the DATA_DIR lock: state is loaded but never saved. */
  readOnly = false;

  private saveTimer?: NodeJS.Timeout;
  private dirty = false;
  private lockFile?: string;

  constructor(private readonly file?: string) {
    if (!file) return;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    this.readOnly = !this.acquireLock(path.join(dir, "state.lock"));
    if (this.readOnly) {
      console.error(`[betfair-ai-trading] ${dir} is in use by another connector process; this process will not save state.`);
    }
    this.load(file);
  }

  static forDataDir(dataDir: string | undefined): State {
    return new State(dataDir ? path.join(dataDir, "state.json") : undefined);
  }

  // ---------------------------------------------------------------- AI data contexts

  setDataContext(marketId: string, name: string, data: unknown) {
    let contexts = this.dataContexts.get(marketId);
    if (contexts) this.dataContexts.delete(marketId);
    else contexts = new Map();
    contexts.set(name, { data, updatedAt: new Date().toISOString() });
    this.dataContexts.set(marketId, contexts); // re-insert: Map order = least recently written first
    while (this.dataContexts.size > MAX_CONTEXT_MARKETS) {
      this.dataContexts.delete(this.dataContexts.keys().next().value as string);
    }
    this.changed();
  }

  getDataContext(marketId: string, name: string): StoredDataContext | undefined {
    return this.dataContexts.get(marketId)?.get(name);
  }

  // ---------------------------------------------------------------- strategy refs

  /**
   * Betfair's customerStrategyRef holds 15 characters. Names that fit are used as-is;
   * longer names get a readable prefix plus a short hash, so distinct strategies never merge.
   */
  strategyRefFor(name: string): string {
    for (const [ref, existing] of this.strategyRefs) if (existing === name) return ref;
    let ref = name.length <= 15 ? name : `${name.slice(0, 10).trimEnd()}~${hash(name, 4)}`;
    for (let i = 0; this.strategyRefs.has(ref) && this.strategyRefs.get(ref) !== name; i++) {
      ref = `${name.slice(0, 10).trimEnd()}~${hash(`${name}#${i}`, 4)}`;
    }
    this.strategyRefs.set(ref, name);
    this.changed();
    return ref;
  }

  strategyNameForRef(ref?: string): string | undefined {
    return ref ? (this.strategyRefs.get(ref) ?? ref) : undefined;
  }

  // ---------------------------------------------------------------- archive

  archiveMarket(market: SettledMarket) {
    this.archive.delete(market.marketId);
    this.archive.set(market.marketId, market);
    const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 86400_000).toISOString();
    for (const [id, m] of this.archive) {
      if (this.archive.size <= MAX_ARCHIVE && m.settledAt >= cutoff) break;
      this.archive.delete(id);
    }
    this.changed();
  }

  // ---------------------------------------------------------------- persistence

  /** Persist soon (debounced) when a data directory is configured. */
  changed() {
    this.dirty = true;
    if (!this.file || this.readOnly || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.trySave();
    }, 250);
    this.saveTimer.unref?.();
  }

  /** Save now if anything changed since the last save (safe to call from an exit handler). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.dirty) this.trySave();
  }

  private trySave() {
    try {
      this.saveNow();
    } catch (error) {
      console.error(`[betfair-ai-trading] failed to save state: ${(error as Error).message}`);
      // Retry later instead of crashing the process.
      if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = undefined;
          this.trySave();
        }, 10_000);
        this.saveTimer.unref?.();
      }
    }
  }

  saveNow() {
    if (!this.file || this.readOnly) return;
    const data: PersistedState = {
      version: 2,
      monitored: [...this.monitored.values()],
      activeMarketId: this.activeMarketId,
      activeSelectionId: this.activeSelectionId,
      dataContexts: Object.fromEntries([...this.dataContexts].map(([marketId, contexts]) => [marketId, Object.fromEntries(contexts)])),
      strategies: [...this.customStrategies.values()],
      strategyRefs: Object.fromEntries(this.strategyRefs),
      paper: this.paper,
      bots: this.bots,
      archive: [...this.archive.values()],
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  /** Release the DATA_DIR lock (call on shutdown after flush()). */
  release() {
    if (!this.lockFile) return;
    try {
      if (fs.readFileSync(this.lockFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(this.lockFile);
    } catch {
      // Already gone.
    }
    this.lockFile = undefined;
  }

  private acquireLock(lockFile: string): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
        this.lockFile = lockFile;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
        if (pid && pid !== process.pid && processAlive(pid)) return false;
        fs.rmSync(lockFile, { force: true }); // Stale lock from a dead process.
      }
    }
    return false;
  }

  private load(file: string) {
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedState> & Record<string, unknown>;
    if (data.version !== 2) {
      console.error(`[betfair-ai-trading] ignoring ${file}: written by an older connector version.`);
      return;
    }
    for (const market of data.monitored ?? []) this.monitored.set(market.marketId, market);
    this.activeMarketId = data.activeMarketId;
    this.activeSelectionId = data.activeSelectionId;
    for (const [marketId, contexts] of Object.entries(data.dataContexts ?? {})) {
      this.dataContexts.set(marketId, new Map(Object.entries(contexts)));
    }
    for (const strategy of data.strategies ?? []) this.customStrategies.set(strategy.name.toLowerCase(), strategy);
    this.strategyRefs = new Map(Object.entries(data.strategyRefs ?? {}));
    this.paper = data.paper ?? emptyLedger();
    this.bots = data.bots ?? [];
    for (const market of data.archive ?? []) this.archive.set(market.marketId, market);
  }
}

function hash(text: string, length: number): string {
  return BigInt(`0x${crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)}`).toString(36).slice(0, length);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
