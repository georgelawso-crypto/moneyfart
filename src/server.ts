import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connector } from "./connector.js";
import { listDataContextProviders } from "./dataContexts.js";
import { TEMPLATES, selectionPositions } from "./strategies.js";
import { assertMarketId, formatSelectionId, parseSelectionId, round } from "./markets.js";
import { renderPrompt, summary, type PromptEntry } from "./prompts.js";

const VERSION = "0.1.0";

function instructions(connector: Connector): string {
  const mode = connector.exchange.mode;
  return [
    "Betfair AI Trading connector: BFExplorer-compatible tools for the Betfair Exchange plus the BetfairAiTrading prompt library.",
    mode === "paper"
      ? "PAPER TRADING mode: strategy executions are simulated against the live Betfair order book and settled with real results. No real money is used."
      : "LIVE TRADING mode: strategy executions place REAL-MONEY bets on the user's Betfair account. Confirm stakes and selections with the user before executing unless they explicitly asked for autonomous execution.",
    "Workflow: FindMarkets -> OpenMarket (makes it the active market and starts recording prices) -> GetActiveMarket -> GetAllDataContextForMarket -> analysis -> ExecuteBfexplorerStrategySettings.",
    "Selection ids use BFExplorer's format \"<selectionId>_<handicap>\", e.g. \"12345678_0.00\". Market ids look like \"1.234567890\".",
    "Use SearchStrategyPrompts / GetStrategyPrompt to load one of the 120+ community analysis prompts and follow it with these tools.",
    "Some BFExplorer data contexts (Racing Post, Timeform, At The Races...) are not available; GetAvailableDataContextProviders lists what is.",
  ].join("\n");
}

const json = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const marketIdArg = z.string().describe('Betfair market id, e.g. "1.234567890"');
const selectionIdArg = z.string().describe('Selection id as returned by GetActiveMarket/GetMarket, e.g. "12345678_0.00"');

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} must be valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function promptNames(entries: PromptEntry[]): Map<string, PromptEntry> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const base = e.id.split("/").pop()!;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return new Map(
    entries.map((e) => {
      const base = e.id.split("/").pop()!;
      return [counts.get(base)! > 1 ? `${e.category}-${base}` : base, e];
    }),
  );
}

export function createServer(connector: Connector): McpServer {
  const { markets, state, strategies, exchange, prompts, config } = connector;
  const server = new McpServer(
    { name: "betfair-ai-trading", title: "Betfair AI Trading", version: VERSION },
    { instructions: instructions(connector) },
  );

  // ---------------------------------------------------------------- status

  server.registerTool(
    "GetConnectorStatus",
    {
      title: "Connector status",
      description: "Trading mode (paper/live), risk limits, Betfair connectivity and monitored markets. Call this first if anything fails.",
      annotations: READ,
    },
    () =>
      run(async () => {
        let betfair: Record<string, unknown> = { configured: connector.betfairConfigured };
        if (connector.betfairConfigured) {
          try {
            const funds = await connector.api.getAccountFunds();
            betfair = { ...betfair, connected: true, accountAvailableToBetBalance: funds.availableToBetBalance };
          } catch (error) {
            betfair = { ...betfair, connected: false, error: (error as Error).message };
          }
        }
        return {
          mode: exchange.mode,
          ...(exchange.mode === "paper" && connector.betfairConfigured
            ? { paperFunds: await exchange.accountFunds().catch((error: Error) => ({ error: error.message })) }
            : {}),
          limits: { maxStake: config.trading.maxStake, maxLiability: config.trading.maxLiability },
          betfair,
          activeMarketId: state.activeMarketId,
          monitoredMarkets: state.monitored.size,
          recordingIntervalSeconds: config.recording.intervalSeconds,
          promptLibrarySize: prompts.entries.length,
          persistence: config.dataDir ? "file" : "memory",
        };
      }),
  );

  // ---------------------------------------------------------------- markets

  server.registerTool(
    "FindMarkets",
    {
      title: "Find Betfair markets",
      description:
        "Search Betfair Exchange markets. Examples: next UK/IE horse races {sport:'Horse Racing', countries:['GB','IE'], marketTypes:['WIN']}; football match odds {sport:'Soccer', textQuery:'Arsenal', marketTypes:['MATCH_ODDS']}. Results are sorted by start time by default.",
      inputSchema: {
        sport: z.string().optional().describe("Sport name or event type id, e.g. 'Horse Racing', 'Soccer', 'Tennis', 'Greyhound Racing'"),
        textQuery: z.string().optional().describe("Free text matched against event/market names, e.g. a team or venue"),
        countries: z.array(z.string()).optional().describe("ISO country codes, e.g. ['GB','IE']"),
        venues: z.array(z.string()).optional().describe("Racing venues, e.g. ['Ascot']"),
        marketTypes: z.array(z.string()).optional().describe("Market type codes, e.g. WIN, PLACE, MATCH_ODDS, OVER_UNDER_25, CORRECT_SCORE"),
        inPlayOnly: z.boolean().optional().describe("Only markets that are currently in-play"),
        hoursAhead: z.number().positive().max(24 * 14).optional().describe("Look-ahead window for start times (default 24)"),
        sort: z.enum(["FIRST_TO_START", "LAST_TO_START", "MAXIMUM_TRADED", "MAXIMUM_AVAILABLE"]).optional(),
        maxResults: z.number().int().min(1).max(100).optional().describe("Default 10"),
      },
      annotations: READ,
    },
    (args) => run(async () => {
      const found = await markets.findMarkets(args);
      return { count: found.length, markets: found };
    }),
  );

  server.registerTool(
    "OpenMarket",
    {
      title: "Open market",
      description:
        "Open a market for monitoring (like opening it in BFExplorer): it becomes the active market and the connector starts recording its prices for history/candlestick data. Returns the market with selections and prices.",
      inputSchema: { marketId: marketIdArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ marketId }) => run(() => markets.openMarket(marketId)),
  );

  server.registerTool(
    "GetActiveMarket",
    {
      title: "Get active market",
      description:
        "The currently active market with every selection's id, name, status, price (last traded), best back/lay prices and volumes. Set the active market with OpenMarket or ActivateBetfairMarketSelection.",
      annotations: READ,
    },
    () =>
      run(async () => {
        if (!state.activeMarketId) {
          throw new Error("No active market. Use FindMarkets to find one, then OpenMarket(marketId) to make it active.");
        }
        return markets.getMarketView(state.activeMarketId);
      }),
  );

  server.registerTool(
    "GetMarket",
    {
      title: "Get market",
      description: "A market's details, selections and current prices by market id.",
      inputSchema: { marketId: marketIdArg },
      annotations: READ,
    },
    ({ marketId }) => run(() => markets.getMarketView(marketId)),
  );

  server.registerTool(
    "GetBetfairMonitoredMarkets",
    {
      title: "Monitored markets",
      description: "Markets currently monitored by the connector (opened with OpenMarket), with their status.",
      annotations: READ,
    },
    () =>
      run(async () => ({
        activeMarketId: state.activeMarketId,
        markets: [...state.monitored.values()].map((m) => ({
          ...m,
          minutesToStart: m.startTime ? Math.round((Date.parse(m.startTime) - Date.now()) / 60000) : undefined,
          recordedSnapshots: state.history.get(m.marketId)?.length ?? 0,
        })),
      })),
  );

  server.registerTool(
    "ActivateBetfairMarketSelection",
    {
      title: "Activate market selection",
      description: "Make a market (and optionally one of its selections) the active one.",
      inputSchema: { marketId: marketIdArg, selectionId: selectionIdArg.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ marketId, selectionId }) =>
      run(async () => {
        const id = assertMarketId(marketId);
        if (!state.monitored.has(id)) await markets.openMarket(id);
        state.activeMarketId = id;
        if (selectionId) {
          const ref = parseSelectionId(selectionId);
          markets.findRunner(await markets.getCatalogue(id), ref);
          state.activeSelectionId = formatSelectionId(ref.selectionId, ref.handicap);
        } else state.activeSelectionId = undefined;
        state.changed();
        return { activeMarketId: id, activeSelectionId: state.activeSelectionId };
      }),
  );

  // ---------------------------------------------------------------- data contexts

  server.registerTool(
    "GetAvailableDataContextProviders",
    {
      title: "Data context providers",
      description: "Data contexts this connector can produce (and BFExplorer ones it cannot), plus AI-agent contexts stored for a market.",
      inputSchema: { marketId: marketIdArg.optional() },
      annotations: READ,
    },
    ({ marketId }) => run(async () => listDataContextProviders(state, marketId ?? state.activeMarketId)),
  );

  server.registerTool(
    "GetAllDataContextForMarket",
    {
      title: "Get data contexts for market",
      description:
        "Retrieve one or more data contexts for every selection in a market, e.g. ['HorsesBaseBetfairFormData','WeightOfMoneyData','MarketSelectionsTradedPricesData','BetfairSpData','MarketSelectionsPriceHistoryData','MarketSelectionsCandleStickData'] or names stored with SetAIAgentDataContextForBetfairMarket. Unavailable contexts are reported, not fatal.",
      inputSchema: {
        dataContextNames: z.array(z.string()).min(1).describe("Data context names"),
        marketId: marketIdArg,
      },
      annotations: READ,
    },
    ({ dataContextNames, marketId }) => run(() => connector.dataContexts.getForMarket(marketId, dataContextNames)),
  );

  server.registerTool(
    "GetDataContextForMarketSelection",
    {
      title: "Get data contexts for selection",
      description: "Same as GetAllDataContextForMarket but for a single selection.",
      inputSchema: {
        dataContextNames: z.array(z.string()).min(1).describe("Data context names"),
        marketId: marketIdArg,
        selectionId: selectionIdArg,
      },
      annotations: READ,
    },
    ({ dataContextNames, marketId, selectionId }) =>
      run(async () => {
        const result = await connector.dataContexts.getForMarket(marketId, dataContextNames, parseSelectionId(selectionId));
        const { selectionsData, ...rest } = result;
        return { ...rest, selection: selectionsData[0] };
      }),
  );

  server.registerTool(
    "SetAIAgentDataContextForBetfairMarket",
    {
      title: "Store AI analysis for market",
      description:
        "Store JSON produced by the AI agent (analysis results, ratings, decisions) under a data context name for a market. It can be read back with GetAllDataContextForMarket and is persisted when DATA_DIR is configured.",
      inputSchema: {
        dataContextName: z.string().min(1).describe('e.g. "HorseRacingEVAnalysisResults"'),
        jsonData: z.string().max(1_000_000).describe("JSON document as a string"),
        marketId: marketIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ dataContextName, jsonData, marketId }) =>
      run(async () => {
        const id = assertMarketId(marketId);
        let data: unknown;
        try {
          data = JSON.parse(jsonData);
        } catch (error) {
          throw new Error(`jsonData must be valid JSON: ${(error as Error).message}`);
        }
        state.setDataContext(id, dataContextName, data);
        return { stored: true, marketId: id, dataContextName };
      }),
  );

  // ---------------------------------------------------------------- strategies

  server.registerTool(
    "GetAllBfexplorerStrategySettings",
    {
      title: "Strategy settings",
      description: "All strategy settings (named, ready-to-run strategy configurations) that ExecuteBfexplorerStrategySettings accepts.",
      annotations: READ,
    },
    () =>
      run(async () => ({
        mode: exchange.mode,
        strategies: strategies.list().map((s) => ({ name: s.name, template: s.template, parameters: s.parameters, description: s.description, builtIn: Boolean(s.builtIn) })),
      })),
  );

  server.registerTool(
    "GetAllBfexplorerStrategyTemplates",
    {
      title: "Strategy templates",
      description: "Strategy templates with their parameters, defaults and meaning. Use them to create strategy settings or to pass parameters to ExecuteBfexplorerStrategySettingsWithParameters.",
      annotations: READ,
    },
    () => run(async () => Object.entries(TEMPLATES).map(([name, t]) => ({ name, ...t }))),
  );

  server.registerTool(
    "GetBfexplorerStrategySetting",
    {
      title: "Strategy setting",
      description: "Details of one strategy setting, including the full parameter set after defaults.",
      inputSchema: { strategyName: z.string() },
      annotations: READ,
    },
    ({ strategyName }) =>
      run(async () => {
        const s = strategies.get(strategyName);
        return { ...s, templateDescription: TEMPLATES[s.template].description, parameterSpecs: TEMPLATES[s.template].parameters };
      }),
  );

  server.registerTool(
    "SaveBfexplorerStrategySettings",
    {
      title: "Save strategy setting",
      description:
        "Create or replace a named strategy setting from a template, e.g. {strategyName:'Back 5 at 3-8', templateName:'Place Bet', parameters:'{\"BetType\":\"Back\",\"Stake\":5,\"MinimumOdds\":3,\"MaximumOdds\":8}'}.",
      inputSchema: {
        strategyName: z.string().min(1),
        templateName: z.string().describe("One of the templates from GetAllBfexplorerStrategyTemplates"),
        parameters: z.string().default("{}").describe("JSON object of template parameters"),
        description: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ strategyName, templateName, parameters, description }) =>
      run(async () => strategies.save(strategyName, templateName, parseJsonObject(parameters, "parameters"), description)),
  );

  const executeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
  const modeNote =
    exchange.mode === "live"
      ? " LIVE MODE: places real-money bets."
      : " Paper mode: simulated against the live order book, no real money.";

  server.registerTool(
    "ExecuteBfexplorerStrategySettings",
    {
      title: "Execute strategy",
      description: `Execute a strategy setting (e.g. "Bet 10 Euro", "Lay 10 Euro", "Back Trade", "Close Selection Bet Position") on one selection.${modeNote}`,
      inputSchema: { strategyName: z.string(), marketId: marketIdArg, selectionId: selectionIdArg },
      annotations: executeAnnotations,
    },
    ({ strategyName, marketId, selectionId }) =>
      run(() => strategies.execute(strategyName, assertMarketId(marketId), [parseSelectionId(selectionId)])),
  );

  server.registerTool(
    "ExecuteBfexplorerStrategySettingsOnSelections",
    {
      title: "Execute strategy on selections",
      description: `Execute a strategy setting on several selections of one market (dutching strategies use all selections together).${modeNote}`,
      inputSchema: { strategyName: z.string(), marketId: marketIdArg, selectionIds: z.array(z.string()).min(1).describe("Selection ids") },
      annotations: executeAnnotations,
    },
    ({ strategyName, marketId, selectionIds }) =>
      run(() => strategies.execute(strategyName, assertMarketId(marketId), selectionIds.map(parseSelectionId))),
  );

  server.registerTool(
    "ExecuteBfexplorerStrategySettingsWithParameters",
    {
      title: "Execute strategy with parameters",
      description: `Execute a strategy setting with parameter overrides, e.g. parameters '{"Stake":5,"Odds":3.5}' or '{"BetType":"Lay","MaximumOdds":6}'.${modeNote}`,
      inputSchema: {
        strategyName: z.string(),
        marketId: marketIdArg,
        selectionId: selectionIdArg,
        parameters: z.string().describe("JSON object of parameter overrides"),
      },
      annotations: executeAnnotations,
    },
    ({ strategyName, marketId, selectionId, parameters }) =>
      run(() =>
        strategies.execute(strategyName, assertMarketId(marketId), [parseSelectionId(selectionId)], parseJsonObject(parameters, "parameters")),
      ),
  );

  // ---------------------------------------------------------------- bets and account

  server.registerTool(
    "GetCurrentOrders",
    {
      title: "Current orders and positions",
      description:
        "Unsettled bets (matched and unmatched). With a marketId, also the matched position per selection: profit if it wins, if it loses, and the market profit if each selection wins.",
      inputSchema: { marketId: marketIdArg.optional() },
      annotations: READ,
    },
    ({ marketId }) =>
      run(async () => {
        const id = marketId ? assertMarketId(marketId) : undefined;
        const orders = await exchange.currentOrders(id ? [id] : undefined);
        if (!id) return { mode: exchange.mode, orders };
        const positions = selectionPositions(orders);
        const totalIfLose = [...positions.values()].reduce((t, p) => t + p.ifLose, 0);
        return {
          mode: exchange.mode,
          orders,
          positions: [...positions].map(([selectionId, p]) => ({
            selectionId,
            ifWin: round(p.ifWin),
            ifLose: round(p.ifLose),
            marketProfitIfWins: round(p.ifWin + totalIfLose - p.ifLose),
          })),
          marketProfitIfOtherWins: round(totalIfLose),
        };
      }),
  );

  server.registerTool(
    "CancelBets",
    {
      title: "Cancel unmatched bets",
      description: "Cancel unmatched bets in a market: specific betIds, or all unmatched bets in the market when betIds is omitted.",
      inputSchema: { marketId: marketIdArg, betIds: z.array(z.string()).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ marketId, betIds }) => run(async () => ({ mode: exchange.mode, cancelled: await exchange.cancelOrders(assertMarketId(marketId), betIds) })),
  );

  server.registerTool(
    "GetAccountFunds",
    {
      title: "Account funds",
      description: "Available balance and exposure (the paper bankroll in paper mode).",
      annotations: READ,
    },
    () => run(() => exchange.accountFunds()),
  );

  server.registerTool(
    "GetAllBetResults",
    {
      title: "Bet results",
      description: "Settled bets with profit/loss over the last N days, summarised in total and per strategy.",
      inputSchema: {
        days: z.number().positive().max(90).optional().describe("Look-back in days (default 7)"),
        marketId: marketIdArg.optional(),
      },
      annotations: READ,
    },
    ({ days, marketId }) =>
      run(async () => {
        const from = new Date(Date.now() - (days ?? 7) * 86400_000);
        const { bets, commission } = await exchange.settledBets(from, marketId ? [assertMarketId(marketId)] : undefined);
        const byStrategy = new Map<string, { bets: number; won: number; profit: number; staked: number }>();
        for (const b of bets) {
          const key = b.strategy || "(none)";
          const s = byStrategy.get(key) ?? { bets: 0, won: 0, profit: 0, staked: 0 };
          s.bets++;
          if (b.outcome === "WON") s.won++;
          s.profit += b.profit;
          s.staked += b.sizeSettled ?? 0;
          byStrategy.set(key, s);
        }
        const profit = bets.reduce((t, b) => t + b.profit, 0);
        return {
          mode: exchange.mode,
          from: from.toISOString(),
          summary: {
            bets: bets.length,
            won: bets.filter((b) => b.outcome === "WON").length,
            grossProfit: round(profit),
            ...(commission !== undefined ? { commission, netProfit: round(profit - commission) } : {}),
          },
          byStrategy: [...byStrategy].map(([strategy, s]) => ({
            strategy,
            bets: s.bets,
            strikeRate: round((s.won / s.bets) * 100, 1),
            profit: round(s.profit),
            roiPercent: s.staked ? round((s.profit / s.staked) * 100, 1) : undefined,
          })),
          bets,
        };
      }),
  );

  // ---------------------------------------------------------------- prompt library

  server.registerTool(
    "SearchStrategyPrompts",
    {
      title: "Search strategy prompts",
      description:
        "Search the BetfairAiTrading prompt library (120+ analysis and execution prompts for horse racing, football, tennis and general trading). Each result says which data contexts it needs and whether it is fully supported here.",
      inputSchema: {
        query: z.string().optional().describe("Keywords, e.g. 'favourite EV', 'weight of money', 'candlestick', 'dutch'"),
        category: z.enum(["HorseRacing", "General", "Football", "Templates", "Tutorials"]).optional(),
        onlyFullySupported: z.boolean().optional().describe("Hide prompts that depend on BFExplorer-only data"),
        limit: z.number().int().min(1).max(130).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(async () => prompts.search(args)),
  );

  server.registerTool(
    "GetStrategyPrompt",
    {
      title: "Get strategy prompt",
      description: "Full text of a library prompt by id (from SearchStrategyPrompts), prefixed with notes on running it through this connector. Then follow its instructions.",
      inputSchema: { id: z.string().describe('e.g. "HorseRacing/HorseRacingEVAnalysisFavouriteR3"'), marketId: marketIdArg.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id, marketId }) =>
      run(async () => {
        const entry = prompts.get(id);
        if (!entry) throw new Error(`Prompt "${id}" not found. Use SearchStrategyPrompts to find ids.`);
        return { ...summary(entry), text: renderPrompt(entry, exchange.mode, marketId) };
      }),
  );

  for (const [name, entry] of promptNames(prompts.entries)) {
    server.registerPrompt(
      name,
      {
        title: entry.title,
        description: `${entry.description}${entry.missingDataContexts.length ? ` (Partly supported: needs ${entry.missingDataContexts.join(", ")}.)` : ""}`.slice(0, 500),
        argsSchema: { marketId: z.string().optional().describe("Market to analyse (defaults to the active market)") },
      },
      ({ marketId }) => ({
        description: entry.title,
        messages: [{ role: "user", content: { type: "text", text: renderPrompt(entry, exchange.mode, marketId) } }],
      }),
    );
  }

  server.registerResource(
    "strategy-prompt",
    new ResourceTemplate("betfair-prompts://{category}/{name}", {
      list: async () => ({
        resources: prompts.entries.map((e) => ({
          uri: `betfair-prompts://${e.id}`,
          name: e.id,
          title: e.title,
          description: e.description,
          mimeType: "text/markdown",
        })),
      }),
    }),
    { title: "BetfairAiTrading prompt", description: "Prompt library entries as markdown", mimeType: "text/markdown" },
    async (uri, { category, name }) => {
      const entry = prompts.get(`${category}/${name}`);
      if (!entry) throw new Error(`Unknown prompt ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: entry.body }] };
    },
  );

  return server;
}
