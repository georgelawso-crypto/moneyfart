import fs from "node:fs";
import path from "node:path";
import type { ToolNaming } from "./config.js";
import { BFEXPLORER_ONLY_CONTEXTS } from "./contexts/bfexplorerOnly.js";
import { assertMarketId } from "./format.js";

// ---------------------------------------------------------------- tool names

/** BFExplorer's 25 MCP tools under their current snake_case wire names, in BFExplorer's order. */
export const BFEXPLORER_TOOL_NAMES = [
  "get_monitored_markets",
  "get_data_context",
  "create_strategy_settings",
  "get_strategy_setting",
  "execute_strategy_settings_on_selections",
  "set_ai_agent_data_context_for_market",
  "execute_strategy_settings",
  "execute_strategy_settings_with_parameters",
  "get_all_data_context_for_market",
  "open_market",
  "get_all_strategy_templates",
  "get_my_favourite_bet_event_markets",
  "execute_application_command",
  "get_active_market",
  "get_all_strategy_settings",
  "get_market",
  "get_available_data_context_providers",
  "activate_market_selection",
  "get_data_context_for_market_selection",
  "get_all_bet_results",
  "get_strategy_template",
  "get_ai_agent_data_context_feedback",
  "get_application_commands",
  "get_my_favourite_bet_events",
  "execute_console_script",
] as const;

export type BfexplorerToolName = (typeof BFEXPLORER_TOOL_NAMES)[number];

/** The PascalCase name each tool is registered under with TOOL_NAMES=legacy (the spelling most library prompts use). */
export const PRIMARY_LEGACY_NAMES: Record<BfexplorerToolName, string> = {
  get_monitored_markets: "GetBetfairMonitoredMarkets",
  get_data_context: "GetDataContext",
  create_strategy_settings: "CreateStrategySettings",
  get_strategy_setting: "GetBfexplorerStrategySetting",
  execute_strategy_settings_on_selections: "ExecuteBfexplorerStrategySettingsOnSelections",
  set_ai_agent_data_context_for_market: "SetAIAgentDataContextForBetfairMarket",
  execute_strategy_settings: "ExecuteBfexplorerStrategySettings",
  execute_strategy_settings_with_parameters: "ExecuteBfexplorerStrategySettingsWithParameters",
  get_all_data_context_for_market: "GetAllDataContextForMarket",
  open_market: "OpenMarket",
  get_all_strategy_templates: "GetAllBfexplorerStrategyTemplates",
  get_my_favourite_bet_event_markets: "GetMyFavouriteBetEventMarkets",
  execute_application_command: "ExecuteApplicationAction",
  get_active_market: "GetActiveMarket",
  get_all_strategy_settings: "GetAllBfexplorerStrategySettings",
  get_market: "GetMarket",
  get_available_data_context_providers: "GetAvailableDataContextProviders",
  activate_market_selection: "ActivateBetfairMarketSelection",
  get_data_context_for_market_selection: "GetDataContextForMarketSelection",
  get_all_bet_results: "GetAllBetResults",
  get_strategy_template: "GetStrategyTemplate",
  get_ai_agent_data_context_feedback: "GetAIAgentDataContextFeedback",
  get_application_commands: "GetApplicationActions",
  get_my_favourite_bet_events: "GetMyFavouriteBetEvents",
  execute_console_script: "ExecuteConsoleScript",
};

/** Connector-only tools the prompt notes mention, with their legacy names. */
const CONNECTOR_LEGACY_NAMES: Record<string, string> = { find_markets: "FindMarkets" };

const VARIANT_NAMES: Record<string, BfexplorerToolName> = {
  GetActiveMarket: "get_active_market",
  GetActiveBetfairMarket: "get_active_market",
  GetAllDataContextForMarket: "get_all_data_context_for_market",
  GetAllDataContextForBetfairMarket: "get_all_data_context_for_market",
  GetDataContextForMarket: "get_all_data_context_for_market",
  GetDataContextForMarketSelection: "get_data_context_for_market_selection",
  ExecuteBfexplorerStrategySettings: "execute_strategy_settings",
  ExecuteStrategySettings: "execute_strategy_settings",
  execute_bfexplorer_strategy_settings: "execute_strategy_settings",
  ExecuteBfexplorerStrategySettingsWithParameters: "execute_strategy_settings_with_parameters",
  ExecuteStrategySettingsWithParameters: "execute_strategy_settings_with_parameters",
  ExecuteBfexplorerStrategySettingsOnSelections: "execute_strategy_settings_on_selections",
  ExecuteStrategySettingsOnSelections: "execute_strategy_settings_on_selections",
  SetAIAgentDataContextForBetfairMarket: "set_ai_agent_data_context_for_market",
  SetAIAgentDataContextForMarket: "set_ai_agent_data_context_for_market",
  ActivateBetfairMarketSelection: "activate_market_selection",
  ActivateMarketSelection: "activate_market_selection",
  GetBetfairMonitoredMarkets: "get_monitored_markets",
  GetMonitoredMarkets: "get_monitored_markets",
  GetAllBfexplorerStrategySettings: "get_all_strategy_settings",
  GetAllStrategySettings: "get_all_strategy_settings",
  GetAllBfexplorerStrategyTemplates: "get_all_strategy_templates",
  GetAllStrategyTemplates: "get_all_strategy_templates",
  GetBfexplorerStrategyTemplates: "get_all_strategy_templates",
  GetStrategyTemplates: "get_all_strategy_templates",
  GetBfexplorerStrategySetting: "get_strategy_setting",
  GetStrategySetting: "get_strategy_setting",
  GetStrategyTemplate: "get_strategy_template",
  CreateStrategySettings: "create_strategy_settings",
  GetAIAgentDataContextFeedback: "get_ai_agent_data_context_feedback",
  // Shortened in the upstream tool list (docs/Automation/UnderstandingAvailableTools.md).
  getAiAgentDataContextFeed: "get_ai_agent_data_context_feedback",
  GetAvailableDataContextProviders: "get_available_data_context_providers",
  GetAllBetResults: "get_all_bet_results",
  OpenMarket: "open_market",
  GetMarket: "get_market",
  GetDataContext: "get_data_context",
  GetApplicationActions: "get_application_commands",
  GetApplicationCommands: "get_application_commands",
  ExecuteApplicationAction: "execute_application_command",
  ExecuteApplicationCommand: "execute_application_command",
  GetMyFavouriteBetEvents: "get_my_favourite_bet_events",
  GetMyFavouriteBetEventMarkets: "get_my_favourite_bet_event_markets",
  ExecuteConsoleScript: "execute_console_script",
};

const camelCase = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Every older, PascalCase, variant and camelCase (as Claude/Cherry Studio render them) spelling of the
 * BFExplorer tools seen in the prompts and docs, mapped to the current snake_case tool name.
 */
export const LEGACY_TOOL_NAMES: Record<string, string> = (() => {
  const names: Record<string, string> = { ...VARIANT_NAMES };
  for (const snake of BFEXPLORER_TOOL_NAMES) names[camelCase(snake)] ??= snake;
  for (const [name, snake] of Object.entries(VARIANT_NAMES)) if (/^[A-Z]/.test(name)) names[lowerFirst(name)] ??= snake;
  return names;
})();

const TOOL_PREFIX = /^(?:mcp_+)?bfexplorerapp_+/i;
const normaliseToolName = (name: string) => name.trim().replace(TOOL_PREFIX, "").replace(/[_-]/g, "").toLowerCase();

const TOOL_INDEX = new Map<string, BfexplorerToolName>([
  ...Object.entries(LEGACY_TOOL_NAMES).map(([name, snake]) => [normaliseToolName(name), snake as BfexplorerToolName] as const),
  ...BFEXPLORER_TOOL_NAMES.map((snake) => [normaliseToolName(snake), snake] as const),
]);

/**
 * The snake_case BFExplorer tool a name refers to, in any era or client spelling
 * (GetActiveBetfairMarket, getActiveMarket, BfexplorerApp__get_active_market, mcp_bfexplorerapp_get_active_market...).
 * Undefined for anything that is not a BFExplorer tool (e.g. PlaceBet, a strategy word).
 */
export function canonicalToolName(name: string): string | undefined {
  return TOOL_INDEX.get(normaliseToolName(name));
}

/** The name the server registers a tool under for a TOOL_NAMES setting ("both" registers snake and primary legacy). */
export function actualToolName(snake: string, naming: ToolNaming): string {
  if (naming !== "legacy") return snake;
  return PRIMARY_LEGACY_NAMES[snake as BfexplorerToolName] ?? CONNECTOR_LEGACY_NAMES[snake] ?? snake;
}

function isRegisteredSpelling(spelling: string, snake: string, naming: ToolNaming): boolean {
  const legacy = PRIMARY_LEGACY_NAMES[snake as BfexplorerToolName];
  if (naming === "snake") return spelling === snake;
  if (naming === "legacy") return spelling === legacy;
  return spelling === snake || spelling === legacy;
}

const EXECUTE_TOOLS: ReadonlySet<string> = new Set(["execute_strategy_settings", "execute_strategy_settings_with_parameters", "execute_strategy_settings_on_selections"]);
const AI_CONTEXT_TOOLS: ReadonlySet<string> = new Set(["set_ai_agent_data_context_for_market", "get_ai_agent_data_context_feedback"]);

// ---------------------------------------------------------------- data contexts

/** Contexts this connector reproduces from Betfair data. */
const BETFAIR_CONTEXTS = [
  "MarketSelectionsCandleStickData",
  "MarketSelectionsPriceHistoryData",
  "MarketSelectionsTradedPricesData",
  "MarketSelectionsPriceMetricData",
  "WeightOfMoneyData",
  "BetfairSpData",
  "HorsesBaseBetfairFormData",
  "HorsesBetfairRaceInfoData",
  "HorseRacingWinToBePlacedData",
];
const KNOWN_CONTEXTS = new Map([...BETFAIR_CONTEXTS, ...Object.keys(BFEXPLORER_ONLY_CONTEXTS)].map((name) => [name.toLowerCase(), name]));
/** BFExplorer's provider naming families, for providers not listed by name. */
const PROVIDER_NAME = /^(?:(?:MarketSelections|WeightOfMoney|BetfairSp|HorsesBase)\w*Data|\w+DataForHorses|HorsesNigels[A-Z]\w*|\w+BookmakersOdds|Db[A-Z]\w*Results)$/;
/** Names prompts give the JSON they store with set_ai_agent_data_context_for_market (HorseRacingR4_Analysis, ...EVAnalysisResults). */
const AI_CONTEXT_NAME = /(?:Analysis|Results|DecisionData)$/;

function providerName(token: string): string | undefined {
  return KNOWN_CONTEXTS.get(token.toLowerCase()) ?? (PROVIDER_NAME.test(token) ? token : undefined);
}

const isBfexplorerOnly = (name: string) => Object.keys(BFEXPLORER_ONLY_CONTEXTS).some((n) => n.toLowerCase() === name.toLowerCase());

// ---------------------------------------------------------------- prompt entries

export type ProviderStatus = "available" | "partial" | "unavailable" | "unknown";

export interface PromptCapabilities {
  /** snake_case BFExplorer tools the server implements (default: all but execute_console_script). */
  implementedTools?: string[];
  /** Status of a data-context provider by request name (default: BFExplorer-only names unavailable, else available). */
  providerStatus?: (name: string) => ProviderStatus;
}

export interface PromptEntry {
  id: string;
  category: string;
  title: string;
  type?: string;
  tags: string[];
  description: string;
  /** Canonical snake_case BFExplorer tools referenced in the body or the frontmatter mcp_tools. */
  tools: string[];
  /** Tool spellings exactly as they appear in the body, mapped to the snake_case tool (first occurrence order). */
  toolSpellings: Record<string, string>;
  dataContexts: string[];
  /** AI-agent contexts the prompt stores or reads back itself (never counted as missing). */
  storedDataContexts: string[];
  /** Referenced tools the server does not implement. */
  missingTools: string[];
  /** Data contexts that will come back as unavailable. */
  missingDataContexts: string[];
  /** Data contexts this connector only partly reproduces. */
  partialDataContexts: string[];
  compatibility: "full" | "partial";
  /** True when the prompt can place bets (any execute_strategy_settings* tool, or an instruction to execute a betting strategy). */
  executesBets: boolean;
  body: string;
}

/** Recorded runs and logs shipped among the prompts; they are not prompts. */
export const EXCLUDED_PROMPTS = ["HorseRacing/HorsesBetfairRaceInfoDataBetV1-calibration-log", "HorseRacing/HorsesBetfairRaceInfoDataTradeV1"];

export function isExcludedPrompt(id: string): boolean {
  const key = id.toLowerCase();
  return EXCLUDED_PROMPTS.some((excluded) => excluded.toLowerCase() === key) || key.endsWith("-log");
}

type Meta = Record<string, string | string[]>;

const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");

export function parseFrontmatter(source: string): { meta: Meta; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { meta: {}, body: source.replace(/^\uFEFF/, "") };
  const meta: Meta = {};
  let listKey: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const list = meta[listKey];
      if (Array.isArray(list)) list.push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    listKey = undefined;
    if (!kv) continue;
    const value = kv[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[kv[1]] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else if (!value) {
      // A YAML block list may follow ("key:" then "  - item" lines).
      meta[kv[1]] = [];
      listKey = kv[1];
    } else {
      meta[kv[1]] = unquote(value);
    }
  }
  return { meta, body: source.slice(match[0].length) };
}

export function firstParagraph(body: string): string {
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

const IDENTIFIER = /\b[A-Za-z]\w*/g;
const QUOTED_NAME = /["“'`]([A-Z]\w*)["”'`]/g;
/** A quoted betting strategy name: "Bet 10 Euro", "Lay Trade", "Trade x profit", "Dutch to profit 10 Euro"... */
const BET_STRATEGY_NAME =
  /["“'`](?:(?:Bet|Back|Lay)\s+(?:\d+(?:[.,]\d+)?\s*(?:Euro|EUR|GBP|USD|AUD|£|€)|[£€$]\s*\d)[^"”'`\n]*|(?:Back|Lay)\s+(?:Trade|hedge|fade)\b[^"”'`\n]*|Trade\s+[^"”'`\n]*\b(?:profit|ticks?|loss)\b[^"”'`\n]*|Trade\s+\d+\/\d+|Dutch\s+(?:to|for)\b[^"”'`\n]*)["”'`]/i;
const EXECUTE_WORD = /\bexecut/i;

const metaList = (meta: Meta, key: string): string[] => (Array.isArray(meta[key]) ? (meta[key] as string[]) : []);
const unique = (values: string[]) => [...new Set(values)];
/** Unique case-insensitively; the first spelling wins. */
const uniqueIgnoreCase = (values: string[]) => {
  const seen = new Set<string>();
  return values.filter((v) => !seen.has(v.toLowerCase()) && !!seen.add(v.toLowerCase()));
};

export class PromptLibrary {
  readonly entries: PromptEntry[];
  private readonly byId: Map<string, PromptEntry>;
  private readonly byName: Map<string, PromptEntry>;
  private readonly implemented: ReadonlySet<string>;
  private readonly providerStatus: (name: string) => ProviderStatus;

  constructor(
    readonly dir: string,
    capabilities: PromptCapabilities = {},
  ) {
    const implemented = capabilities.implementedTools ?? BFEXPLORER_TOOL_NAMES.filter((t) => t !== "execute_console_script");
    this.implemented = new Set(implemented.map((t) => canonicalToolName(t) ?? t));
    this.providerStatus = capabilities.providerStatus ?? ((name) => (isBfexplorerOnly(name) ? "unavailable" : "available"));
    this.entries = fs.existsSync(dir) ? this.load(dir) : [];
    this.byId = new Map(this.entries.map((e) => [e.id.toLowerCase(), e]));
    this.byName = new Map([...promptNames(this.entries)].map(([name, e]) => [name.toLowerCase(), e]));
  }

  private load(dir: string): PromptEntry[] {
    const entries: PromptEntry[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".md") && current !== dir) {
          const id = path.relative(dir, full).replace(/\\/g, "/").replace(/\.md$/, "");
          if (!isExcludedPrompt(id)) entries.push(this.parse(id, fs.readFileSync(full, "utf8")));
        }
      }
    };
    walk(dir);
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Analyse one prompt file (id is its path below the library dir, without .md). */
  private parse(id: string, source: string): PromptEntry {
    const { meta, body } = parseFrontmatter(source);

    const toolSpellings: Record<string, string> = {};
    const stored: string[] = [];
    let strategyExecution = false;
    for (const line of body.split(/\r?\n/)) {
      let storesContext = false;
      for (const [token] of line.matchAll(IDENTIFIER)) {
        const tool = canonicalToolName(token);
        if (!tool) continue;
        toolSpellings[token] ??= tool;
        storesContext ||= AI_CONTEXT_TOOLS.has(tool);
      }
      if (storesContext) {
        for (const [, name] of line.matchAll(QUOTED_NAME)) if (!canonicalToolName(name) && !providerName(name)) stored.push(name);
      }
      strategyExecution ||= EXECUTE_WORD.test(line) && BET_STRATEGY_NAME.test(line);
    }
    const declaredTools = metaList(meta, "mcp_tools").map(canonicalToolName).filter((t): t is string => !!t);
    const tools = unique([...declaredTools, ...Object.values(toolSpellings)]);

    const declared = metaList(meta, "data_contexts").map((name) => KNOWN_CONTEXTS.get(name.toLowerCase()) ?? name);
    const referenced = [...body.matchAll(IDENTIFIER)].map(([token]) => providerName(token)).filter((n): n is string => !!n);
    const dataContexts = uniqueIgnoreCase([...declared, ...referenced]);
    const storedDataContexts = uniqueIgnoreCase([...dataContexts.filter((n) => AI_CONTEXT_NAME.test(n) && !providerName(n)), ...stored]);

    const storedKeys = new Set(storedDataContexts.map((n) => n.toLowerCase()));
    const missingDataContexts: string[] = [];
    const partialDataContexts: string[] = [];
    for (const name of dataContexts) {
      const status = this.providerStatus(name);
      if (status === "partial") partialDataContexts.push(name);
      else if (status === "unavailable" || (status === "unknown" && !storedKeys.has(name.toLowerCase()))) missingDataContexts.push(name);
    }
    const missingTools = tools.filter((t) => !this.implemented.has(t));

    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const basename = path.posix.basename(id);
    return {
      id,
      category: id.split("/")[0],
      title: (typeof meta.title === "string" && meta.title) || heading || basename,
      type: typeof meta.type === "string" ? meta.type : undefined,
      tags: metaList(meta, "tags"),
      description: firstParagraph(body) || heading || basename,
      tools,
      toolSpellings,
      dataContexts,
      storedDataContexts,
      missingTools,
      missingDataContexts,
      partialDataContexts,
      compatibility: missingTools.length || missingDataContexts.length || partialDataContexts.length ? "partial" : "full",
      executesBets: tools.some((t) => EXECUTE_TOOLS.has(t)) || strategyExecution,
      body: body.trim(),
    };
  }

  /**
   * A prompt by id ("HorseRacing/X"), basename ("X") or MCP prompt name; case-insensitive.
   * An ambiguous basename or path suffix gives undefined rather than an arbitrary one of the prompts
   * (HorseRacing/HorseRacingEVAnalysisPrompt only analyses; its Templates namesake places bets).
   */
  get(id: string): PromptEntry | undefined {
    const key = id
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^prompts\//i, "")
      .replace(/\.md$/i, "")
      .toLowerCase();
    if (!key) return undefined;
    const exact = this.byId.get(key) ?? this.byName.get(key);
    if (exact) return exact;
    const suffixed = this.entries.filter((e) => e.id.toLowerCase().endsWith(`/${key}`));
    return suffixed.length === 1 ? suffixed[0] : undefined;
  }

  search(options: { query?: string; category?: string; onlyFullySupported?: boolean; executesBets?: boolean; limit?: number }) {
    // A tool name in any spelling searches for the canonical tool, which is what e.tools holds.
    const terms = (options.query ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => canonicalToolName(term) ?? term.toLowerCase());
    const scored = this.entries
      .filter((e) => !options.category || e.category.toLowerCase() === options.category.toLowerCase())
      .filter((e) => !options.onlyFullySupported || e.compatibility === "full")
      .filter((e) => options.executesBets === undefined || e.executesBets === options.executesBets)
      .map((e) => {
        const haystack = `${e.id} ${e.title} ${e.tags.join(" ")} ${e.dataContexts.join(" ")} ${e.tools.join(" ")} ${e.description}`.toLowerCase();
        const score = terms.reduce((total, t) => total + (haystack.includes(t) ? (e.title.toLowerCase().includes(t) ? 2 : 1) : 0), 0);
        return { e, score };
      })
      .filter(({ score }) => !terms.length || score > 0)
      .sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
    return {
      total: scored.length,
      prompts: scored.slice(0, Math.max(1, options.limit ?? 25)).map(({ e }) => summary(e)),
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
    tools: e.tools,
    dataContexts: e.dataContexts,
    compatibility: e.compatibility,
    missingTools: e.missingTools,
    missingDataContexts: e.missingDataContexts,
    partialDataContexts: e.partialDataContexts,
    executesBets: e.executesBets,
  };
}

/** Short unique MCP prompt names: the basename, or "<category>-<basename>" when basenames collide. */
export function promptNames(entries: readonly PromptEntry[]): Map<string, PromptEntry> {
  const basename = (e: PromptEntry) => path.posix.basename(e.id);
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(basename(e).toLowerCase(), (counts.get(basename(e).toLowerCase()) ?? 0) + 1);
  const names = new Map<string, PromptEntry>();
  const taken = new Set<string>();
  for (const e of entries) {
    const base = (counts.get(basename(e).toLowerCase()) ?? 0) > 1 ? `${e.category}-${basename(e)}` : basename(e);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    taken.add(name.toLowerCase());
    names.set(name, e);
  }
  return names;
}

// ---------------------------------------------------------------- rendering

export interface RenderOptions {
  mode: "paper" | "live";
  /** Market to work on; validated, blank means none. */
  marketId?: string;
  /** How the server names its tools (TOOL_NAMES); default "snake". */
  toolNaming?: ToolNaming;
}

/** Text handed to the model when a library prompt is used through this connector: notes, then the prompt body. */
export function renderPrompt(e: PromptEntry, options: RenderOptions): string {
  const naming = options.toolNaming ?? "snake";
  const t = (snake: string) => actualToolName(snake, naming);
  const marketId = options.marketId?.trim() ? assertMarketId(options.marketId) : undefined;
  const notes = [
    `You are running the BetfairAiTrading prompt "${e.title}" through the Betfair AI Trading connector. ${
      options.mode === "paper"
        ? "PAPER trading: bets are simulated against the live order book; no real money is used."
        : "LIVE trading: bets placed by this prompt use real money on the user's Betfair account."
    }`,
    marketId
      ? `Work on market ${marketId}: call ${t("open_market")} with marketId ${marketId} first, and pass this marketId explicitly to every tool (${t("get_active_market")} accepts marketId too). Never switch markets.`
      : `If ${t("get_active_market")} reports no active market, use ${t("find_markets")} and ${t("open_market")} to choose one (ask the user if unclear). Record the marketId and pass it explicitly afterwards.`,
    `Market tools (${t("get_active_market")}, ${t("get_market")}, ${t("get_monitored_markets")}) return TOON text like BFExplorer; data contexts return JSON {market, selectionsData:[{selectionId, name, data:{...}}], data}. Selection ids are plain strings such as "98427997".`,
  ];

  const mapping = Object.entries(e.toolSpellings)
    .filter(([spelling, snake]) => !e.missingTools.includes(snake) && !isRegisteredSpelling(spelling, snake, naming))
    .map(([spelling, snake]) => `${spelling} -> ${t(snake)}`);
  if (mapping.length) notes.push(`Tool names in this prompt and the tools to call on this server: ${mapping.join(", ")}.`);
  if (e.executesBets && !e.tools.some((tool) => EXECUTE_TOOLS.has(tool))) {
    notes.push(`To execute a strategy the prompt names (such as "Bet 10 Euro"), call ${t("execute_strategy_settings")} with strategyName, marketId and selectionId.`);
  }

  if (e.missingTools.length) {
    const spelled = e.missingTools.map((snake) => Object.keys(e.toolSpellings).find((s) => e.toolSpellings[s] === snake) ?? snake);
    notes.push(`These BFExplorer tools are not available in this connector: ${spelled.join(", ")}. Skip the steps that need them, say so, and never invent their results.`);
  }
  if (e.missingDataContexts.length) {
    const described = e.missingDataContexts.map((name) => {
      const source = Object.entries(BFEXPLORER_ONLY_CONTEXTS).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1].source;
      return source ? `${name} (${source})` : name;
    });
    notes.push(
      `These data contexts are not available in this connector and will come back as unavailable: ${described.join(", ")}. Continue the analysis without them: say they are missing and never invent or estimate their values.`,
    );
  }
  if (e.partialDataContexts.length) {
    notes.push(
      `These data contexts are only partly reproduced here: ${e.partialDataContexts.join(", ")}. Use the fields that are present and treat absent fields as missing; never invent values.`,
    );
  }
  if (e.executesBets && options.mode === "live") {
    notes.push("This prompt places real-money bets. Confirm with the user before the first execution unless they explicitly asked for autonomous execution.");
  }
  return `${notes.map((n) => `> ${n}`).join("\n")}\n\n${e.body}`;
}
