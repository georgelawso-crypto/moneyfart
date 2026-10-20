import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MarketCatalogue } from "./betfair/types.js";
import { emptyLedger, type PaperLedger } from "./exchange/paperTypes.js";
import type { BotState } from "./strategies/botTypes.js";
import { findTemplate, parameterProblems, parseParameters, resolveParameters } from "./strategies/templates.js";
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

/** Contents of DATA_DIR/state.lock. */
interface LockRecord {
  hostname: string;
  pid: number;
  token: string;
  startedAt: string;
}

/** Bounds on the AI-agent contexts kept (set_ai_agent_data_context_for_market). */
export interface ContextLimits {
  /** Context names kept per market; the least recently written is dropped first. */
  maxNamesPerMarket: number;
  /** Total serialized size (JSON characters) of every stored context; the least recently written markets are dropped first. */
  maxTotalBytes: number;
}

const MAX_CONTEXT_MARKETS = 2000;
/** Largest single stored context (JSON characters). */
export const MAX_CONTEXT_SIZE = 1_000_000;
const MAX_CONTEXT_NAME = 200;
const DEFAULT_CONTEXT_LIMITS: ContextLimits = { maxNamesPerMarket: 50, maxTotalBytes: 50_000_000 };
const MAX_ARCHIVE = 5000;
const ARCHIVE_DAYS = 90;

/** The DATA_DIR owner refreshes the lock file's mtime this often. */
const LOCK_HEARTBEAT_MS = 30_000;
/**
 * A lock whose mtime is older than this belongs to a process that is gone. PIDs are never
 * compared: containers sharing a volume all run the connector as PID 1.
 */
const LOCK_STALE_MS = 2 * 60_000;
/** A read-only process tries to take DATA_DIR over this often. */
export const LOCK_RETRY_MS = 30_000;
/** After replacing a stale lock, re-read it this much later: another process may have replaced it at the same moment. */
const TAKEOVER_SETTLE_MS = 200;

/**
 * v1 parameters that the v2 templates dropped, with their v1 defaults: a v1 setting that left
 * them at the default migrates without them (v1 saved every parameter, defaults included).
 */
const V1_DROPPED_DEFAULTS: Record<string, unknown> = {
  oddsoffsetticks: 0,
  minimumodds: 1.01,
  maximumodds: 1000,
  allowplacingbetinplay: true,
  exitpersistencetype: "Lapse",
};

const log = (message: string) => console.error(`[betfair-ai-trading] ${message}`);

/**
 * Durable connector state. Persisted to DATA_DIR/state.json (debounced, fsync + atomic rename)
 * when DATA_DIR is set. One process at a time owns DATA_DIR through DATA_DIR/state.lock; others
 * run read-only, retry the lock every LOCK_RETRY_MS and merge their changes when they get it.
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
  /** Set while another process holds the DATA_DIR lock: state is loaded but never saved, and bots do not run here. */
  readOnly = false;
  /** Why this process is read-only (for get_connector_status and tool results). */
  readOnlyReason?: string;

  private saveTimer?: NodeJS.Timeout;
  private dirty = false;
  private readonly lockPath?: string;
  /** Set while this process owns DATA_DIR. */
  private lock?: LockRecord;
  private heartbeatTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private readonly contextLimits: ContextLimits;
  /** Serialized size of each stored context, and their total. */
  private contextSizes = new WeakMap<StoredDataContext, number>();
  private contextBytes = 0;
  /** Custom settings as last loaded or saved: a read-only process's own edits are the ones that differ. */
  private savedStrategies = new Map<string, string>();
  /** Ids of the bots as last loaded or saved: one of them missing from state.json later was removed by its owner. */
  private savedBotIds = new Set<string>();

  constructor(
    private readonly file?: string,
    contextLimits: Partial<ContextLimits> = {},
  ) {
    this.contextLimits = { ...DEFAULT_CONTEXT_LIMITS, ...contextLimits };
    if (!file) return;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    this.lockPath = path.join(dir, "state.lock");
    if (!this.acquireLock()) this.lockedOut();
    const data = this.read(file);
    if (data) this.apply(data);
  }

  static forDataDir(dataDir: string | undefined): State {
    return new State(dataDir ? path.join(dataDir, "state.json") : undefined);
  }

  // ---------------------------------------------------------------- AI data contexts

  setDataContext(marketId: string, name: string, data: unknown) {
    if (name.length > MAX_CONTEXT_NAME) throw new Error(`Data context names are limited to ${MAX_CONTEXT_NAME} characters.`);
    const json = JSON.stringify(data) ?? "null";
    if (json.length > MAX_CONTEXT_SIZE) {
      throw new Error(`jsonData is larger than 1 MB (${json.length} characters of JSON); store a summary instead. Nothing was stored.`);
    }
    let contexts = this.dataContexts.get(marketId);
    if (contexts) this.dataContexts.delete(marketId);
    else contexts = new Map();
    const previous = contexts.get(name);
    if (previous) {
      this.contextBytes -= this.sizeOf(name, previous);
      contexts.delete(name); // re-insert: Map order = least recently written first
    }
    const stored: StoredDataContext = { data, updatedAt: new Date().toISOString() };
    this.contextSizes.set(stored, name.length + json.length);
    this.contextBytes += name.length + json.length;
    contexts.set(name, stored);
    this.dataContexts.set(marketId, contexts); // re-insert: Map order = least recently written first
    this.trimContexts(marketId, name);
    this.changed();
  }

  getDataContext(marketId: string, name: string): StoredDataContext | undefined {
    return this.dataContexts.get(marketId)?.get(name);
  }

  private sizeOf(name: string, stored: StoredDataContext): number {
    let size = this.contextSizes.get(stored);
    if (size === undefined) {
      size = name.length + (JSON.stringify(stored.data) ?? "null").length;
      this.contextSizes.set(stored, size);
    }
    return size;
  }

  private dropContexts(marketId: string, names?: string[]) {
    const contexts = this.dataContexts.get(marketId);
    if (!contexts) return;
    for (const name of names ?? [...contexts.keys()]) {
      const stored = contexts.get(name);
      if (!stored) continue;
      this.contextBytes -= this.sizeOf(name, stored);
      contexts.delete(name);
    }
    if (!contexts.size) this.dataContexts.delete(marketId);
  }

  /** Keep stored contexts within their limits, dropping the least recently written first (never the one just written). */
  private trimContexts(keepMarketId?: string, keepName?: string) {
    const { maxNamesPerMarket, maxTotalBytes } = this.contextLimits;
    for (const [marketId, contexts] of this.dataContexts) {
      const excess = contexts.size - maxNamesPerMarket;
      if (excess > 0) this.dropContexts(marketId, [...contexts.keys()].filter((name) => marketId !== keepMarketId || name !== keepName).slice(0, excess));
    }
    while (this.dataContexts.size > MAX_CONTEXT_MARKETS || this.contextBytes > maxTotalBytes) {
      const oldest = [...this.dataContexts.keys()].find((id) => id !== keepMarketId);
      if (oldest !== undefined) {
        this.dropContexts(oldest);
        continue;
      }
      // Only the market just written is left: drop its older contexts.
      const contexts = this.dataContexts.get(keepMarketId!);
      const older = [...(contexts?.keys() ?? [])].find((name) => name !== keepName);
      if (older === undefined) break;
      this.dropContexts(keepMarketId!, [older]);
    }
  }

  private recountContexts() {
    this.contextBytes = 0;
    for (const contexts of this.dataContexts.values()) for (const [name, stored] of contexts) this.contextBytes += this.sizeOf(name, stored);
    this.trimContexts();
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
    this.trimArchive();
    this.changed();
  }

  private trimArchive() {
    const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 86400_000).toISOString();
    for (const [id, m] of this.archive) {
      if (this.archive.size <= MAX_ARCHIVE && m.settledAt >= cutoff) break;
      this.archive.delete(id);
    }
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
    // A read-only process whose owner has just exited takes DATA_DIR over now (which saves), so its changes are not lost.
    if (this.dirty && this.readOnly) this.tryTakeOver();
    if (this.dirty) this.trySave();
  }

  private trySave() {
    try {
      this.saveNow();
    } catch (error) {
      log(`failed to save state: ${(error as Error).message}`);
      // Retry later instead of crashing the process.
      if (!this.saveTimer && !this.readOnly) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = undefined;
          this.trySave();
        }, 10_000);
        this.saveTimer.unref?.();
      }
    }
  }

  saveNow() {
    if (!this.file || !this.ownsDataDir()) return;
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
    const tmp = `${this.file}.${this.lock?.token ?? process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd); // the rename below must never publish a file whose data is not on disk yet
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    syncDirectory(path.dirname(this.file));
    this.dirty = false;
    this.savedStrategies = strategySnapshot(this.customStrategies);
    this.savedBotIds = new Set(this.bots.map((b) => b.id));
  }

  /** Release the DATA_DIR lock (call on shutdown after flush()). */
  release() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    this.dropLock();
  }

  private dropLock() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (!this.lock || !this.lockPath) return;
    try {
      // Only our own lock: after a takeover the file belongs to another process (maybe with the same PID).
      if (readLock(this.lockPath)?.token === this.lock.token) fs.unlinkSync(this.lockPath);
    } catch {
      // Already gone.
    }
    this.lock = undefined;
  }

  /**
   * True while this process may save state and run bots: no DATA_DIR, or DATA_DIR's lock still
   * holds this process's token. A process that finds another one's token switches to read-only.
   */
  ownsDataDir(): boolean {
    if (!this.file) return true;
    if (this.readOnly || !this.lock || !this.lockPath) return false;
    const holder = readLock(this.lockPath);
    if (holder?.token === this.lock.token) return true;
    if (!holder && !fs.existsSync(this.lockPath)) {
      try {
        // The lock file was deleted: put ours back unless another process got there first.
        fs.writeFileSync(this.lockPath, JSON.stringify(this.lock), { flag: "wx" });
        return true;
      } catch {
        // Another process created it.
      }
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.dropLock(); // the file holds another token, so it is left alone
    log("another connector process has taken DATA_DIR over: this process stops saving state and running bots.");
    this.lockedOut();
    return false;
  }

  /**
   * A read-only process takes DATA_DIR over once its owner is gone: it reloads state.json (the
   * owner's last save), merges in what it changed while read-only, and saves. Runs every
   * LOCK_RETRY_MS while read-only; returns whether this process now owns DATA_DIR.
   */
  tryTakeOver(): boolean {
    if (!this.readOnly) return true;
    if (!this.file) return false;
    let summary: string;
    try {
      if (!this.acquireLock()) return false;
      this.readOnly = false; // read() may now move or back up state.json as its owner
      summary = this.merge(this.read(this.file));
    } catch (error) {
      // Never save over a state.json this process could not merge with: stay read-only and retry later.
      this.dropLock();
      this.readOnly = true;
      log(`could not take DATA_DIR over: ${(error as Error).message}`);
      return false;
    }
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    this.readOnlyReason = undefined;
    log(`this process now owns ${path.dirname(this.file)}: ${summary}.`);
    this.dirty = true;
    this.trySave();
    return true;
  }

  private lockedOut() {
    const dir = path.dirname(this.file!);
    const holder = this.lockPath ? readLock(this.lockPath) : undefined;
    this.readOnly = true;
    this.readOnlyReason = `${dir} is in use by another connector process${holder ? ` (pid ${holder.pid} on ${holder.hostname}, since ${holder.startedAt})` : ""}`;
    log(`${this.readOnlyReason}; this process will not save state or run bots until it can take DATA_DIR over (retried every ${LOCK_RETRY_MS / 1000} s).`);
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => this.tryTakeOver(), LOCK_RETRY_MS);
      this.retryTimer.unref?.();
    }
  }

  /**
   * Create DATA_DIR/state.lock, or replace it when its owner stopped refreshing it. Creation is
   * atomic (O_EXCL); a stale lock is replaced by an atomic rename and re-read after a moment,
   * so two processes racing for it cannot both win.
   */
  private acquireLock(): boolean {
    const lockFile = this.lockPath!;
    const record: LockRecord = { hostname: os.hostname(), pid: process.pid, token: crypto.randomUUID(), startedAt: new Date().toISOString() };
    const text = JSON.stringify(record);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(lockFile, text, { flag: "wx" });
        return this.ownLock(record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const age = lockAge(lockFile);
      if (age === undefined) continue; // removed meanwhile
      if (age < LOCK_STALE_MS) return false;
      const tmp = `${lockFile}.${record.token}.tmp`;
      try {
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, lockFile);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      sleepSync(TAKEOVER_SETTLE_MS);
      return readLock(lockFile)?.token === record.token ? this.ownLock(record) : false;
    }
    return false;
  }

  private ownLock(record: LockRecord): true {
    this.lock = record;
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), LOCK_HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
    }
    return true;
  }

  private heartbeat() {
    if (!this.lockPath || !this.ownsDataDir()) return;
    try {
      const now = new Date();
      fs.utimesSync(this.lockPath, now, now);
    } catch (error) {
      log(`could not refresh ${this.lockPath}: ${(error as Error).message}`);
    }
  }

  /**
   * state.json as a v2 state, or undefined when there is none to use. Never destroys a file it
   * cannot use: an unreadable one is moved aside, an older or newer version is copied aside.
   */
  private read(file: string): PersistedState | undefined {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed)) throw new Error(`expected a JSON object, found ${Array.isArray(parsed) ? "an array" : String(parsed)}`);
      data = parsed;
    } catch (error) {
      if (this.readOnly) {
        log(`ERROR: ${file} is unreadable (${(error as Error).message}); starting with empty state in memory (the owning process keeps the file).`);
        return undefined;
      }
      const aside = path.join(path.dirname(file), `state.corrupt-${fileStamp()}.json`);
      fs.renameSync(file, aside);
      log(
        `ERROR: ${file} is unreadable (${(error as Error).message}). It was moved to ${aside} and the connector starts with EMPTY state ` +
          "(paper ledger, AI data contexts, custom strategy settings and bots). Restore what you need from that file.",
      );
      return undefined;
    }
    if (data.version === 2) return data as unknown as PersistedState;
    if (data.version === undefined) return this.migrateV1(file, data);
    const backup = this.readOnly ? undefined : backupCopy(file, `state.v${String(data.version).replace(/[^\w.-]/g, "_")}-backup`);
    log(
      `${file} was written by an unknown connector version (${JSON.stringify(data.version)})${backup ? `; it was copied to ${backup}` : ""}. ` +
        "This version starts with empty state and does not read it.",
    );
    this.changed(); // replace it now that the copy is safe, so the next start does not copy it again
    return undefined;
  }

  /** v1 (unversioned) state: AI data contexts and custom strategy settings carry over; the rest stays in the backup. */
  private migrateV1(file: string, v1: Record<string, unknown>): PersistedState {
    const backup = this.readOnly ? undefined : backupCopy(file, "state.v1-backup");
    const dataContexts: PersistedState["dataContexts"] = {};
    let contexts = 0;
    for (const [marketId, names] of Object.entries(isObject(v1.dataContexts) ? v1.dataContexts : {})) {
      if (!isObject(names)) continue;
      for (const [name, stored] of Object.entries(names)) {
        if (!isObject(stored) || !("data" in stored)) continue;
        (dataContexts[marketId] ??= {})[name] = { data: stored.data, updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : new Date(0).toISOString() };
        contexts++;
      }
    }
    const strategies: StrategySetting[] = [];
    const skipped: string[] = [];
    for (const raw of Array.isArray(v1.strategies) ? v1.strategies : []) {
      const migrated = migrateV1Strategy(raw);
      if (typeof migrated === "string") skipped.push(migrated);
      else strategies.push(migrated);
    }
    const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    log(
      `${file} was written by connector v1${backup ? ` and was copied to ${backup}` : ""}. Migrated ${contexts} AI data context(s) and ` +
        `${strategies.length} custom strategy setting(s)${skipped.length ? `; not migrated: ${skipped.join("; ")}` : ""}. ` +
        `Left in the backup only: ${count(v1.paperOrders)} v1 paper order(s), ${count(v1.paperSettlements)} paper settlement(s), ` +
        `${count(v1.monitored)} monitored market(s) and the active market.`,
    );
    this.changed(); // save the migrated state now that the copy is safe
    return { version: 2, monitored: [], dataContexts, strategies, strategyRefs: {}, paper: emptyLedger(), bots: [], archive: [] };
  }

  private apply(data: PersistedState) {
    for (const market of data.monitored ?? []) this.monitored.set(market.marketId, market);
    this.activeMarketId = data.activeMarketId;
    this.activeSelectionId = data.activeSelectionId;
    for (const [marketId, contexts] of Object.entries(data.dataContexts ?? {})) {
      this.dataContexts.set(marketId, new Map(Object.entries(contexts)));
    }
    this.recountContexts();
    for (const strategy of data.strategies ?? []) this.customStrategies.set(strategy.name.toLowerCase(), strategy);
    this.savedStrategies = strategySnapshot(this.customStrategies);
    this.strategyRefs = new Map(Object.entries(data.strategyRefs ?? {}));
    this.paper = data.paper ?? emptyLedger();
    this.bots = data.bots ?? [];
    this.savedBotIds = new Set(this.bots.map((b) => b.id));
    for (const market of data.archive ?? []) this.archive.set(market.marketId, market);
  }

  /**
   * Layer this process's changes onto the state the previous owner saved last. Collections are
   * refilled in place (services may hold references to them). Returns a summary for the log.
   */
  private merge(saved: PersistedState | undefined): string {
    if (!saved) return "no saved state to merge with; keeping this process's state";
    const monitored = new Map((saved.monitored ?? []).map((m) => [m.marketId, m]));
    for (const [id, market] of this.monitored) if (!monitored.has(id)) monitored.set(id, market);
    refill(this.monitored, monitored);
    if (this.activeMarketId === undefined) {
      this.activeMarketId = saved.activeMarketId;
      this.activeSelectionId = saved.activeSelectionId;
    }

    // AI data contexts: per market and name, the newest write wins.
    let contexts = 0;
    const merged = new Map(Object.entries(saved.dataContexts ?? {}).map(([marketId, names]) => [marketId, new Map(Object.entries(names))]));
    for (const [marketId, names] of this.dataContexts) {
      for (const [name, stored] of names) {
        const theirs = merged.get(marketId)?.get(name);
        if (theirs && (Date.parse(theirs.updatedAt) || 0) >= (Date.parse(stored.updatedAt) || 0)) continue;
        if (!merged.has(marketId)) merged.set(marketId, new Map());
        merged.get(marketId)!.set(name, stored);
        contexts++;
      }
    }
    refill(this.dataContexts, merged);
    this.recountContexts();

    // Custom settings: ours where this process changed them, theirs otherwise.
    let strategies = 0;
    const settings = new Map((saved.strategies ?? []).map((s) => [s.name.toLowerCase(), s]));
    for (const [key, setting] of this.customStrategies) {
      if (this.savedStrategies.get(key) === JSON.stringify(setting)) continue;
      settings.set(key, setting);
      strategies++;
    }
    refill(this.customStrategies, settings);

    const refs = new Map(Object.entries(saved.strategyRefs ?? {}));
    for (const [ref, name] of this.strategyRefs) if (!refs.has(ref)) refs.set(ref, name);
    refill(this.strategyRefs, refs);

    // Paper ledger: the owner's records win; orders and settlements only this process made are added.
    // An order this process settled stays settled when the owner's copy is not: this process's
    // settlement record for the market already counts it, and settling it again would count it twice.
    const ledger = saved.paper ?? emptyLedger();
    const ownOrders = new Map(this.paper.orders.map((o) => [o.betId, o]));
    const savedBets = new Set(ledger.orders.map((o) => o.betId));
    const orders = this.paper.orders.filter((o) => !savedBets.has(o.betId));
    const settledMarkets = new Set(ledger.settlements.map((s) => s.marketId));
    const savedOrders = ledger.orders.map((o) => {
      const own = ownOrders.get(o.betId);
      return !o.settlement && own?.settlement && !settledMarkets.has(o.marketId) ? own : o;
    });
    refillArray(this.paper.orders, [...savedOrders, ...orders]);
    refillArray(this.paper.settlements, [...ledger.settlements, ...this.paper.settlements.filter((s) => !settledMarkets.has(s.marketId))]);
    this.paper.betCounter = Math.max(this.paper.betCounter, ledger.betCounter ?? 0);
    if (ledger.markets || this.paper.markets) this.paper.markets = { ...this.paper.markets, ...ledger.markets };

    // Bots: the owner's copies win. A bot this process last loaded or saved that is missing now was
    // pruned by the owner after it ended; only bots started here since then are added.
    const savedBots = new Set((saved.bots ?? []).map((b) => b.id));
    refillArray(this.bots, [...(saved.bots ?? []), ...this.bots.filter((b) => !savedBots.has(b.id) && !this.savedBotIds.has(b.id))]);
    this.savedBotIds = savedBots;

    const archive = new Map((saved.archive ?? []).map((m) => [m.marketId, m]));
    for (const [id, market] of this.archive) if (!archive.has(id)) archive.set(id, market);
    refill(this.archive, archive);
    this.trimArchive();

    return `merged ${orders.length} paper order(s), ${contexts} AI data context(s) and ${strategies} strategy setting(s) made while read-only`;
  }
}

function hash(text: string, length: number): string {
  return BigInt(`0x${crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)}`).toString(36).slice(0, length);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLock(file: string): LockRecord | undefined {
  try {
    const record: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(record) && typeof record.token === "string" ? (record as unknown as LockRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** Milliseconds since the lock file was last written or refreshed; undefined when it does not exist. */
function lockAge(file: string): number | undefined {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Best effort: make a rename durable (directories cannot be opened for fsync on Windows). */
function syncDirectory(dir: string) {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Not supported by this file system.
  }
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Copy a state file next to itself as <name>.json (or <name>-<time>.json when that exists); returns the copy's path. */
function backupCopy(file: string, name: string): string {
  const dir = path.dirname(file);
  let target = path.join(dir, `${name}.json`);
  if (fs.existsSync(target)) target = path.join(dir, `${name}-${fileStamp()}.json`);
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  return target;
}

function strategySnapshot(settings: Map<string, StrategySetting>): Map<string, string> {
  return new Map([...settings].map(([key, setting]) => [key, JSON.stringify(setting)]));
}

function refill<K, V>(target: Map<K, V>, source: Map<K, V>) {
  const entries = [...source];
  target.clear();
  for (const [key, value] of entries) target.set(key, value);
}

function refillArray<T>(target: T[], items: T[]) {
  const copy = [...items];
  target.length = 0;
  for (const item of copy) target.push(item);
}

function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A v1 custom strategy setting in v2 form, or why it cannot be migrated. */
function migrateV1Strategy(raw: unknown): StrategySetting | string {
  if (!isObject(raw) || typeof raw.name !== "string" || !raw.name.trim()) return "a setting without a name";
  const name = raw.name.trim();
  const template = findTemplate(String(raw.template ?? ""));
  if (!template) return `"${name}" (template "${String(raw.template)}" does not exist any more)`;
  const known = new Set(template.parameters.flatMap((p) => [p.name, ...(p.aliases ?? [])]).map((n) => n.toLowerCase()));
  const parameters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(isObject(raw.parameters) ? raw.parameters : {})) {
    const lower = key.toLowerCase();
    if (!known.has(lower) && Object.hasOwn(V1_DROPPED_DEFAULTS, lower) && sameValue(V1_DROPPED_DEFAULTS[lower], value)) continue;
    parameters[key] = value;
  }
  try {
    const parsed = parseParameters(template, parameters);
    const problems = parameterProblems(template, resolveParameters(template, parsed));
    if (problems.length) return `"${name}" (${problems.join(" ")})`;
    const description = typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined;
    return { name, template: template.name, parameters: parsed, description };
  } catch (error) {
    return `"${name}" (${(error as Error).message})`;
  }
}
