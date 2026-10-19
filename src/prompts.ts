import fs from "node:fs";
import path from "node:path";
import { BFEXPLORER_ONLY_CONTEXTS } from "./dataContexts.js";

export interface PromptEntry {
  id: string;
  category: string;
  title: string;
  type?: string;
  tags: string[];
  description: string;
  dataContexts: string[];
  /** Data contexts the prompt uses that only BFExplorer can provide. */
  missingDataContexts: string[];
  executesBets: boolean;
  body: string;
}

function parseFrontmatter(source: string): { meta: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[kv[1]] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      meta[kv[1]] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: source.slice(match[0].length) };
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
      .trim();
    if (!text || text.startsWith("#") || text.startsWith("```") || text.startsWith("|") || text.startsWith("---")) continue;
    const plain = text.replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
    if (plain.length > 20) return plain.length > 280 ? `${plain.slice(0, 277)}...` : plain;
  }
  return "";
}

const KNOWN_CONTEXT = /\b([A-Z][A-Za-z]+(?:Data|DataForHorses))\b/g;
const BET_TOOLS = /ExecuteBfexplorerStrategySettings|ExecuteStrategySettings|PlaceBet/;

export class PromptLibrary {
  readonly entries: PromptEntry[];
  private byId: Map<string, PromptEntry>;

  constructor(readonly dir: string) {
    this.entries = fs.existsSync(dir) ? this.load(dir) : [];
    this.byId = new Map(this.entries.map((e) => [e.id.toLowerCase(), e]));
  }

  private load(dir: string): PromptEntry[] {
    const entries: PromptEntry[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".md") && current !== dir) entries.push(this.parse(full, dir));
      }
    };
    walk(dir);
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  private parse(file: string, dir: string): PromptEntry {
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const id = path.relative(dir, file).replace(/\\/g, "/").replace(/\.md$/, "");
    const declared = Array.isArray(meta.data_contexts) ? meta.data_contexts : [];
    const referenced = [...body.matchAll(KNOWN_CONTEXT)].map((m) => m[1]);
    const dataContexts = [...new Set([...declared, ...referenced])].filter(
      (name) => declared.includes(name) || name in BFEXPLORER_ONLY_CONTEXTS || /^(MarketSelections|WeightOfMoney|BetfairSp|HorsesBase)/.test(name),
    );
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    return {
      id,
      category: id.split("/")[0],
      title: (typeof meta.title === "string" && meta.title) || heading || path.basename(id),
      type: typeof meta.type === "string" ? meta.type : undefined,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      description: firstParagraph(body) || heading || path.basename(id),
      dataContexts,
      missingDataContexts: dataContexts.filter((name) => name in BFEXPLORER_ONLY_CONTEXTS),
      executesBets: BET_TOOLS.test(body),
      body: body.trim(),
    };
  }

  get(id: string): PromptEntry | undefined {
    const key = id.trim().replace(/\.md$/, "").toLowerCase();
    return this.byId.get(key) ?? this.entries.find((e) => e.id.toLowerCase().endsWith(`/${key}`));
  }

  search(options: { query?: string; category?: string; onlyFullySupported?: boolean; limit?: number }) {
    const terms = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.entries
      .filter((e) => !options.category || e.category.toLowerCase() === options.category.toLowerCase())
      .filter((e) => !options.onlyFullySupported || e.missingDataContexts.length === 0)
      .map((e) => {
        const haystack = `${e.id} ${e.title} ${e.tags.join(" ")} ${e.dataContexts.join(" ")} ${e.description}`.toLowerCase();
        const score = terms.reduce((total, t) => total + (haystack.includes(t) ? (e.title.toLowerCase().includes(t) ? 2 : 1) : 0), 0);
        return { e, score };
      })
      .filter(({ score }) => !terms.length || score > 0)
      .sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
    return {
      total: scored.length,
      prompts: scored.slice(0, options.limit ?? 25).map(({ e }) => summary(e)),
    };
  }
}

export function summary(e: PromptEntry) {
  return {
    id: e.id,
    title: e.title,
    category: e.category,
    type: e.type,
    description: e.description,
    dataContexts: e.dataContexts,
    compatibility: e.missingDataContexts.length ? "partial" : "full",
    ...(e.missingDataContexts.length ? { missingDataContexts: e.missingDataContexts } : {}),
    executesBets: e.executesBets,
  };
}

/** Text handed to the model when a library prompt is used through this connector. */
export function renderPrompt(e: PromptEntry, mode: "paper" | "live", marketId?: string): string {
  const notes = [
    `You are running the BetfairAiTrading prompt "${e.title}" through the Betfair AI Trading connector (${mode === "paper" ? "PAPER trading: bets are simulated against the live order book" : "LIVE trading: bets use real money"}).`,
    marketId
      ? `Work on market ${marketId}: call OpenMarket with this marketId first so it becomes the active market.`
      : "If GetActiveMarket reports no active market, use FindMarkets and OpenMarket to choose one first (ask the user if the choice is unclear).",
    "Tool results are JSON rather than TOON; field names follow BFExplorer's conventions.",
  ];
  if (e.missingDataContexts.length) {
    notes.push(
      `These data contexts are BFExplorer-only and will come back as unavailable: ${e.missingDataContexts.join(", ")}. Say so, and base the analysis on the data that is available instead of inventing values.`,
    );
  }
  if (e.executesBets && mode === "live") {
    notes.push("This prompt places real-money bets. Confirm with the user before the first execution unless they have explicitly asked for autonomous execution.");
  }
  return `${notes.map((n) => `> ${n}`).join("\n")}\n\n${e.body}`;
}
