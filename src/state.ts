import fs from "node:fs";
import path from "node:path";
import type { PersistenceType, Side } from "./betfair/types.js";
import type { StrategySetting } from "./strategies.js";

export interface MonitoredMarket {
  marketId: string;
  marketName: string;
  eventName: string;
  eventType: string;
  startTime?: string;
  openedAt: string;
  status?: string;
}

/** Per-selection price snapshot: [lastPriceTraded, bestBack, bestLay, totalMatched]. */
export type SelectionTick = [ltp: number | null, back: number | null, lay: number | null, matched: number | null];

export interface Snapshot {
  t: number;
  s: Record<string, SelectionTick>;
}

export interface StoredDataContext {
  data: unknown;
  updatedAt: string;
}

export interface PaperOrder {
  betId: string;
  marketId: string;
  selectionId: number;
  handicap: number;
  side: Side;
  price: number;
  size: number;
  sizeMatched: number;
  averagePriceMatched: number;
  sizeCancelled: number;
  sizeLapsed: number;
  persistenceType: PersistenceType;
  placedDate: string;
  matchedDate?: string;
  strategyName?: string;
  marketName?: string;
  eventName?: string;
  selectionName?: string;
  /** Filled in when the market closes. */
  settlement?: {
    outcome: "WON" | "LOST" | "VOID";
    profit: number;
    settledDate: string;
  };
}

export interface PaperMarketSettlement {
  marketId: string;
  marketName: string;
  eventName: string;
  grossProfit: number;
  commission: number;
  settledDate: string;
}

interface PersistedState {
  monitored: MonitoredMarket[];
  activeMarketId?: string;
  activeSelectionId?: string;
  dataContexts: Record<string, Record<string, StoredDataContext>>;
  strategies: StrategySetting[];
  paperOrders: PaperOrder[];
  paperSettlements: PaperMarketSettlement[];
  paperBetCounter: number;
}

export class State {
  monitored = new Map<string, MonitoredMarket>();
  activeMarketId?: string;
  activeSelectionId?: string;
  /** marketId -> data context name -> data (AI-agent written contexts). */
  dataContexts = new Map<string, Map<string, StoredDataContext>>();
  customStrategies = new Map<string, StrategySetting>();
  paperOrders: PaperOrder[] = [];
  paperSettlements: PaperMarketSettlement[] = [];
  history = new Map<string, Snapshot[]>();
  private paperBetCounter = 0;
  private saveTimer?: NodeJS.Timeout;

  constructor(
    private readonly file?: string,
    private readonly maxSnapshotsPerMarket = 720,
  ) {
    if (file) this.load(file);
  }

  static forDataDir(dataDir: string | undefined, maxSnapshotsPerMarket?: number): State {
    return new State(dataDir ? path.join(dataDir, "state.json") : undefined, maxSnapshotsPerMarket);
  }

  nextPaperBetId(): string {
    this.paperBetCounter += 1;
    return `P${Date.now().toString(36).toUpperCase()}${this.paperBetCounter}`;
  }

  setDataContext(marketId: string, name: string, data: unknown) {
    let contexts = this.dataContexts.get(marketId);
    if (!contexts) this.dataContexts.set(marketId, (contexts = new Map()));
    contexts.set(name, { data, updatedAt: new Date().toISOString() });
    this.changed();
  }

  getDataContext(marketId: string, name: string): StoredDataContext | undefined {
    return this.dataContexts.get(marketId)?.get(name);
  }

  recordSnapshot(marketId: string, snapshot: Snapshot) {
    let snapshots = this.history.get(marketId);
    if (!snapshots) this.history.set(marketId, (snapshots = []));
    const last = snapshots[snapshots.length - 1];
    // Skip duplicates when the same book was fetched twice within a second.
    if (last && snapshot.t - last.t < 1000) snapshots[snapshots.length - 1] = snapshot;
    else snapshots.push(snapshot);
    if (snapshots.length > this.maxSnapshotsPerMarket) snapshots.splice(0, snapshots.length - this.maxSnapshotsPerMarket);
  }

  /** Persist soon (debounced) when a data directory is configured. */
  changed() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, 250);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    const data: PersistedState = {
      monitored: [...this.monitored.values()],
      activeMarketId: this.activeMarketId,
      activeSelectionId: this.activeSelectionId,
      dataContexts: Object.fromEntries(
        [...this.dataContexts].map(([marketId, contexts]) => [marketId, Object.fromEntries(contexts)]),
      ),
      strategies: [...this.customStrategies.values()],
      paperOrders: this.paperOrders,
      paperSettlements: this.paperSettlements,
      paperBetCounter: this.paperBetCounter,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }

  private load(file: string) {
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedState>;
    for (const market of data.monitored ?? []) this.monitored.set(market.marketId, market);
    this.activeMarketId = data.activeMarketId;
    this.activeSelectionId = data.activeSelectionId;
    for (const [marketId, contexts] of Object.entries(data.dataContexts ?? {})) {
      this.dataContexts.set(marketId, new Map(Object.entries(contexts)));
    }
    for (const strategy of data.strategies ?? []) this.customStrategies.set(strategy.name.toLowerCase(), strategy);
    this.paperOrders = data.paperOrders ?? [];
    this.paperSettlements = data.paperSettlements ?? [];
    this.paperBetCounter = data.paperBetCounter ?? 0;
  }
}
