import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import type { Connector } from "./connector.js";
import { selectionPositions } from "./exchange/math.js";
import type { SettledBetView } from "./exchange/types.js";
import { assertMarketId, compact, formatSelectionId, parseSelectionId, round, toToon, utcSeconds, type SelectionRef } from "./format.js";
import { promptNames, renderPrompt, summary } from "./prompts.js";
import type { State } from "./state.js";

const VERSION = "0.2.0";

/** Per-conversation view of the active market (BFExplorer has one; we scope it per MCP session). */
export interface SessionContext {
  activeMarketId?: string;
  activeSelectionId?: string;
}

/** Session bound to the persisted, process-wide active market (stdio: one client per process). */
export function stateSession(state: State): SessionContext {
  return {
    get activeMarketId() {
      return state.activeMarketId;
    },
    set activeMarketId(value) {
      state.activeMarketId = value;
      state.changed();
    },
    get activeSelectionId() {
      return state.activeSelectionId;
    },
    set activeSelectionId(value) {
      state.activeSelectionId = value;
      state.changed();
    },
  };
}

type Output = { toon: unknown; root?: string } | { json: unknown };

interface ToolDef {
  /** BFExplorer's current wire name (snake_case). */
  name: string;
  /** Legacy PascalCase name used by most library prompts. */
  legacy: string;
  title: string;
  description: string;
  input?: ZodRawShape;
  annotations: ToolAnnotations;
  run: (args: any) => Promise<Output>;
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const WRITE_LOCAL: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const BETTING: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const marketIdArg = z.string().describe('Betfair market id, e.g. "1.234567890"');
const optionalMarketId = marketIdArg.optional().describe("Market id; defaults to the active market");
const selectionIdArg = z.union([z.string(), z.number()]).describe('Selection id from get_active_market, e.g. "98427997"');
const contextNamesArgs = {
  dataContextNames: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe('Data context names, e.g. ["MarketSelectionsCandleStickData","WeightOfMoneyData"] (a comma-separated string also works)'),
  dataContextName: z.string().optional().describe("A single data context name (alternative to dataContextNames)"),
};
const parametersArg = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe('Parameter overrides as an object or JSON string, e.g. {"OpenBetPosition.BetType":"Lay","CloseBetPosition.Profit":9} or {"Stake":5}');

function contextNames(args: { dataContextNames?: string[] | string; dataContextName?: string }): string[] {
  const raw = Array.isArray(args.dataContextNames) ? args.dataContextNames : (args.dataContextNames ?? "").split(",");
  const names = [...raw, args.dataContextName ?? ""].map((n) => n.trim()).filter(Boolean);
  if (!names.length) throw new Error("Provide dataContextNames (or dataContextName).");
  return [...new Set(names)];
}

function jsonObject(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${what} must be valid JSON: ${(error as Error).message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${what} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

function render(output: Output): CallToolResult {
  const text = "toon" in output ? toToon(compact(output.toon), output.root) : JSON.stringify(compact(output.json));
  return { content: [{ type: "text", text }] };
}

export function createServer(connector: Connector, session: SessionContext = stateSession(connector.state)): McpServer {
  const { markets, contexts, exchange, strategies, bots, prompts, state, config } = connector;
  const naming = config.output.toolNames;
  const strict = config.output.strictBfexplorer;
  const mode = exchange.mode;
  const defs: ToolDef[] = [];
  const name = (snake: string, legacy: string) => (naming === "legacy" ? legacy : snake);

  // ---------------------------------------------------------------- helpers

  const marketOf = (marketId?: string): string => {
    if (marketId) return assertMarketId(marketId);
    if (session.activeMarketId) return session.activeMarketId;
    throw new Error(`No active market. Use ${name("find_markets", "FindMarkets")} to find one, then ${name("open_market", "OpenMarket")}(marketId).`);
  };

  const selectionOf = (marketId: string, selectionId?: string | number): SelectionRef => {
    if (selectionId !== undefined && selectionId !== "") return parseSelectionId(selectionId);
    if (session.activeSelectionId && session.activeMarketId === marketId) return parseSelectionId(session.activeSelectionId);
    throw new Error(`selectionId is required (no active selection; set one with ${name("activate_market_selection", "ActivateBetfairMarketSelection")}).`);
  };

  const marketPayload = async (marketId: string) => {
    const catalogue = await markets.getCatalogue(marketId);
    const book = await markets.getBook(catalogue.marketId, { depth: 1 });
    return markets.bfexplorerMarket(catalogue, book, strict);
  };

  const settledProfitByMarket = async (marketIds: string[]) => {
    const profits = new Map<string, number>();
    if (!marketIds.length) return profits;
    const { bets } = await exchange.settledBets(new Date(Date.now() - 90 * 86400_000), marketIds);
    for (const bet of bets) profits.set(bet.marketId, (profits.get(bet.marketId) ?? 0) + bet.profit);
    return profits;
  };

  // ---------------------------------------------------------------- markets

  defs.push({
    name: "get_active_market",
    legacy: "GetActiveMarket",
    title: "Get active market",
    description:
      "The active market as TOON (like BFExplorer): marketId, startTime, eventType, eventName (venue), marketName, totalMatched, status, inPlay, and selections{selectionId,name,price,totalMatched,status} where price is the last traded price. Pass marketId to read a specific market without relying on the shared active market.",
    input: { marketId: optionalMarketId },
    annotations: READ,
    run: async ({ marketId }) => {
      const id = marketOf(marketId);
      const payload = await marketPayload(id);
      const extra = !strict && session.activeSelectionId && session.activeMarketId === id ? { activeSelectionId: session.activeSelectionId } : {};
      return { toon: { ...payload, ...extra }, root: "activeBetfairMarket" };
    },
  });

  defs.push({
    name: "get_market",
    legacy: "GetMarket",
    title: "Get market",
    description: "A market by id as TOON (same fields as get_active_market). Works after the market has closed (runners show Winner/Loser).",
    input: { marketId: marketIdArg },
    annotations: READ,
    run: async ({ marketId }) => ({ toon: await marketPayload(assertMarketId(marketId)), root: "betfairMarket" }),
  });

  defs.push({
    name: "get_monitored_markets",
    legacy: "GetBetfairMonitoredMarkets",
    title: "Monitored markets",
    description: "Markets opened with open_market (recorded every RECORD_INTERVAL_SECONDS), with status and the active market.",
    annotations: READ,
    run: async () => {
      const rows = [...state.monitored.values()]
        .filter((m) => !m.companionOf)
        .map((m) => ({
          marketId: m.marketId,
          startTime: m.catalogue.marketStartTime ? utcSeconds(m.catalogue.marketStartTime) : "",
          eventType: m.catalogue.eventType?.name ?? "",
          eventName: m.catalogue.event?.venue ?? m.catalogue.event?.name ?? "",
          marketName: m.catalogue.marketName,
          status: m.status ?? "",
          inPlay: Boolean(m.inPlay),
        }));
      return { toon: { activeMarketId: session.activeMarketId, markets: rows }, root: "betfairMonitoredMarkets" };
    },
  });

  defs.push({
    name: "open_market",
    legacy: "OpenMarket",
    title: "Open market",
    description:
      "Open a market for monitoring (like opening it in BFExplorer): it becomes the active market and the connector records its trades for candlestick, price-history and traded-price data. Returns the market as TOON.",
    input: { marketId: marketIdArg },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async ({ marketId }) => {
      const { catalogue, book } = await markets.openMarket(marketId);
      if (session.activeMarketId !== catalogue.marketId) session.activeSelectionId = undefined;
      session.activeMarketId = catalogue.marketId;
      return { toon: markets.bfexplorerMarket(catalogue, book, strict), root: "betfairMarket" };
    },
  });

  defs.push({
    name: "activate_market_selection",
    legacy: "ActivateBetfairMarketSelection",
    title: "Activate market selection",
    description: "Make a market (and optionally one of its selections) active, so later calls can omit marketId/selectionId. Returns {status:true}.",
    input: { marketId: marketIdArg, selectionId: selectionIdArg.optional() },
    annotations: WRITE_LOCAL,
    run: async ({ marketId, selectionId }) => {
      const id = assertMarketId(marketId);
      const ref = selectionId !== undefined && selectionId !== "" ? parseSelectionId(selectionId) : undefined;
      const catalogue = await markets.getCatalogue(id);
      if (ref) markets.findRunner(catalogue, ref); // validate before changing anything
      if (!state.monitored.has(id) || state.monitored.get(id)?.companionOf) await markets.openMarket(id);
      session.activeMarketId = id;
      session.activeSelectionId = ref ? formatSelectionId(ref.selectionId, ref.handicap) : undefined;
      return { json: { status: true, marketId: id, selectionId: session.activeSelectionId } };
    },
  });

  defs.push({
    name: "find_markets",
    legacy: "FindMarkets",
    title: "Find Betfair markets",
    description:
      "Connector tool: search Betfair markets. Examples: next UK/IE horse races {sport:'Horse Racing', countries:['GB','IE'], marketTypes:['WIN']}; football {sport:'Soccer', textQuery:'Arsenal', marketTypes:['MATCH_ODDS']}. Includes events that started up to fromHoursAgo (default 4) so in-play markets are found; each result reports status and inPlay.",
    input: {
      sport: z.string().optional().describe("Sport name or event type id, e.g. 'Horse Racing', 'Soccer', 'Tennis', 'Greyhound Racing'"),
      textQuery: z.string().optional().describe("Free text matched against event/market names"),
      countries: z.array(z.string()).optional().describe("ISO country codes, e.g. ['GB','IE']"),
      venues: z.array(z.string()).optional().describe("Racing venues, e.g. ['Ascot']"),
      marketTypes: z.array(z.string()).optional().describe("Market type codes: WIN, PLACE, MATCH_ODDS, OVER_UNDER_25, CORRECT_SCORE, WINNER (outrights)..."),
      eventIds: z.array(z.string()).optional(),
      competitionIds: z.array(z.string()).optional(),
      marketIds: z.array(z.string()).optional(),
      inPlayOnly: z.boolean().optional(),
      fromHoursAgo: z.number().min(0).max(48).optional().describe("Include markets that started up to this many hours ago (default 4)"),
      hoursAhead: z.number().positive().max(24 * 365).optional().describe("Look-ahead window (default 24; outrights are searched without a window)"),
      sort: z.enum(["FIRST_TO_START", "LAST_TO_START", "MAXIMUM_TRADED", "MAXIMUM_AVAILABLE"]).optional(),
      maxResults: z.number().int().min(1).max(100).optional().describe("Default 10"),
    },
    annotations: READ,
    run: async (args) => {
      const found = await markets.findMarkets(args);
      return { json: { count: found.length, markets: found } };
    },
  });

  defs.push({
    name: "get_market_details",
    legacy: "GetMarketDetails",
    title: "Market details",
    description: "Connector tool: rich JSON view of a market with best back/lay prices and sizes, in-play flag, bet delay, minutes to start and book percentage.",
    input: { marketId: optionalMarketId },
    annotations: READ,
    run: async ({ marketId }) => {
      const id = marketOf(marketId);
      const catalogue = await markets.getCatalogue(id);
      return { json: markets.buildView(catalogue, await markets.getBook(id, { depth: 3 })) };
    },
  });

  defs.push({
    name: "get_my_favourite_bet_events",
    legacy: "GetMyFavouriteBetEvents",
    title: "Favourite bet events",
    description: "Names of the saved bet-event groups (BFExplorer's defaults: GB/IE horse racing, football, in-play football, over/under 2.5, in-play tennis, greyhounds, cricket).",
    annotations: READ,
    run: async () => ({ toon: { betEvents: markets.favouriteBetEvents() }, root: "myFavouriteBetEvents" }),
  });

  defs.push({
    name: "get_my_favourite_bet_event_markets",
    legacy: "GetMyFavouriteBetEventMarkets",
    title: "Favourite bet event markets",
    description: "Markets in a favourite bet-event group (from get_my_favourite_bet_events).",
    input: { name: z.string() },
    annotations: READ,
    run: async ({ name: group }) => {
      const found = await markets.favouriteBetEventMarkets(group);
      const rows = found.map((m) => ({
        marketId: m.marketId,
        startTime: m.startTime ?? "",
        eventType: m.eventType ?? "",
        eventName: m.venue ?? m.eventName ?? "",
        marketName: m.marketName,
        status: m.status ?? "",
        inPlay: Boolean(m.inPlay),
      }));
      return { toon: { name: group, markets: rows }, root: "myFavouriteBetEventMarkets" };
    },
  });

  // ---------------------------------------------------------------- data contexts

  defs.push({
    name: "get_available_data_context_providers",
    legacy: "GetAvailableDataContextProviders",
    title: "Data context providers",
    description: "Data contexts this connector produces (available/partial), BFExplorer-only ones it cannot (unavailable, with reason), and AI-agent contexts stored for the market.",
    input: { marketId: marketIdArg.optional() },
    annotations: READ,
    run: async ({ marketId }) => {
      const rows = contexts.providers(marketId ? assertMarketId(marketId) : session.activeMarketId).map((p) => ({
        name: p.name,
        status: p.status,
        dataKeys: [...p.dataKeys, ...(p.marketDataKeys ?? []).map((k) => `market:${k}`)].join(","),
        description: p.reason ? `${p.description} (${p.reason})` : p.description,
      }));
      return { toon: { providers: rows }, root: "dataContextProviders" };
    },
  });

  defs.push({
    name: "get_all_data_context_for_market",
    legacy: "GetAllDataContextForMarket",
    title: "Data contexts for market",
    description:
      'Data contexts for every selection of a market, as JSON in BFExplorer\'s envelope {market, selectionsData:[{selectionId, name, data:{...}}], data}. Requested contexts merge into each selection\'s data, e.g. MarketSelectionsCandleStickData -> candleStickData, vwaPrice, backLayRatio; MarketSelectionsTradedPricesData -> tradedPricesData. Unavailable contexts are listed under unavailableDataContexts and do not fail the call.',
    input: { ...contextNamesArgs, marketId: optionalMarketId },
    annotations: READ,
    run: async (args) => ({ json: await contexts.getForMarket(marketOf(args.marketId), contextNames(args)) }),
  });

  defs.push({
    name: "get_data_context_for_market_selection",
    legacy: "GetDataContextForMarketSelection",
    title: "Data contexts for selection",
    description: "Same envelope as get_all_data_context_for_market with exactly one entry in selectionsData.",
    input: { ...contextNamesArgs, marketId: optionalMarketId, selectionId: selectionIdArg.optional() },
    annotations: READ,
    run: async (args) => {
      const id = marketOf(args.marketId);
      return { json: await contexts.getForMarket(id, contextNames(args), selectionOf(id, args.selectionId)) };
    },
  });

  defs.push({
    name: "get_data_context",
    legacy: "GetDataContext",
    title: "Data context",
    description: "A single data context for the active market (or marketId), same envelope as get_all_data_context_for_market.",
    input: { dataContextName: z.string(), marketId: optionalMarketId },
    annotations: READ,
    run: async ({ dataContextName, marketId }) => ({ json: await contexts.getForMarket(marketOf(marketId), [dataContextName]) }),
  });

  defs.push({
    name: "set_ai_agent_data_context_for_market",
    legacy: "SetAIAgentDataContextForBetfairMarket",
    title: "Store AI analysis for market",
    description:
      "Store JSON produced by the AI agent (analysis, ratings, decisions) under a data context name for a market (default: active market). Read it back with get_all_data_context_for_market or across settled markets with get_ai_agent_data_context_feedback. Returns {status:true}.",
    input: {
      dataContextName: z.string().min(1),
      jsonData: z.union([z.string().max(1_000_000), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe("JSON document (string or object)"),
      marketId: optionalMarketId,
    },
    annotations: { ...WRITE_LOCAL, destructiveHint: true },
    run: async ({ dataContextName, jsonData, marketId }) => {
      const id = marketOf(marketId);
      let data: unknown = jsonData;
      if (typeof jsonData === "string") {
        try {
          data = JSON.parse(jsonData);
        } catch (error) {
          throw new Error(`jsonData must be valid JSON: ${(error as Error).message}`);
        }
      }
      if (JSON.stringify(data).length > 1_000_000) throw new Error("jsonData is larger than 1 MB.");
      state.setDataContext(id, dataContextName, data);
      return { json: { status: true, marketId: id, dataContextName } };
    },
  });

  defs.push({
    name: "get_ai_agent_data_context_feedback",
    legacy: "GetAIAgentDataContextFeedback",
    title: "AI analysis feedback",
    description:
      "Every stored AI-agent context with this name across markets (newest first), joined with the settled result (winners, BSP) and this connector's profit on the market, to evaluate a strategy's decisions.",
    input: { dataContextName: z.string(), forLastResults: z.number().int().min(1).max(1000).optional().describe("Default 100") },
    annotations: READ,
    run: async ({ dataContextName, forLastResults }) => {
      const entries = await contexts.feedback(dataContextName, forLastResults ?? 100);
      const profits = await settledProfitByMarket(entries.filter((e) => e.market.settled).map((e) => e.market.marketId));
      return {
        json: entries.map((e) => (profits.has(e.market.marketId) ? { ...e, profit: round(profits.get(e.market.marketId), 4) } : e)),
      };
    },
  });

  // ---------------------------------------------------------------- strategies

  defs.push({
    name: "get_all_strategy_settings",
    legacy: "GetAllBfexplorerStrategySettings",
    title: "Strategy settings",
    description: "All strategy settings (named configurations of templates) that execute_strategy_settings accepts, e.g. \"Bet 10 Euro\", \"Lay 10 Euro\", \"Trade x profit\".",
    annotations: READ,
    run: async () => ({
      toon: {
        mode,
        settings: strategies.list().map((s) => ({ name: s.name, template: s.template, builtIn: Boolean(s.builtIn), description: s.description ?? "" })),
      },
      root: "strategySettings",
    }),
  });

  defs.push({
    name: "get_strategy_setting",
    legacy: "GetBfexplorerStrategySetting",
    title: "Strategy setting",
    description: "One strategy setting with its full parameter values.",
    input: { strategyName: z.string() },
    annotations: READ,
    run: async ({ strategyName }) => {
      const s = strategies.get(strategyName);
      return { toon: { name: s.name, template: s.template, description: s.description, aliases: s.aliases, parameters: s.parameters }, root: "strategySetting" };
    },
  });

  defs.push({
    name: "get_all_strategy_templates",
    legacy: "GetAllBfexplorerStrategyTemplates",
    title: "Strategy templates",
    description: "Strategy templates (Place Bet, Place Bet and Close Selection Bet Position, Close Selection Bet Position, Trailing Stop Loss, Place Dutching Bets, ...). Use get_strategy_template for parameters.",
    annotations: READ,
    run: async () => ({
      toon: { templates: strategies.templates().map((t) => ({ name: t.name, category: t.category, description: t.description })) },
      root: "strategyTemplates",
    }),
  });

  defs.push({
    name: "get_strategy_template",
    legacy: "GetStrategyTemplate",
    title: "Strategy template",
    description: "A template's parameters (name, type, default, allowed values, meaning). Dotted names such as OpenBetPosition.Stake belong to the open/close template.",
    input: { templateName: z.string().optional(), botName: z.string().optional().describe("Alias of templateName") },
    annotations: READ,
    run: async ({ templateName, botName }) => {
      const t = strategies.template(templateName ?? botName ?? "");
      return {
        toon: {
          name: t.name,
          category: t.category,
          description: t.description,
          parameters: t.parameters.map((p) => ({
            name: p.name,
            type: p.type,
            default: p.default === null ? "" : p.default,
            values: (p.values ?? []).join("|"),
            aliases: (p.aliases ?? []).join("|"),
            description: p.description,
          })),
        },
        root: "strategyTemplate",
      };
    },
  });

  defs.push({
    name: "create_strategy_settings",
    legacy: "CreateStrategySettings",
    title: "Create strategy settings",
    description:
      'Create strategy settings from templates (create-only; existing names are reported, not replaced), e.g. [{"name":"Back Bet 5","template":"Place Bet","parameters":{"BetType":"Back","Stake":5}}].',
    input: {
      strategyTemplateParameters: z
        .union([z.string(), z.array(z.object({ name: z.string(), template: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }))])
        .describe("Array (or JSON string) of {name, template, parameters}"),
    },
    annotations: WRITE_LOCAL,
    run: async ({ strategyTemplateParameters }) => {
      let items = strategyTemplateParameters;
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch (error) {
          throw new Error(`strategyTemplateParameters must be valid JSON: ${(error as Error).message}`);
        }
      }
      if (!Array.isArray(items)) items = [items];
      return { json: strategies.create(items) };
    },
  });

  defs.push({
    name: "save_strategy_settings",
    legacy: "SaveStrategySettings",
    title: "Save strategy setting",
    description: "Connector tool: create or update a custom strategy setting. Replacing an existing or built-in name requires overwrite:true.",
    input: {
      strategyName: z.string().min(1),
      templateName: z.string(),
      parameters: parametersArg.optional(),
      description: z.string().optional(),
      overwrite: z.boolean().optional(),
    },
    annotations: { ...WRITE_LOCAL, destructiveHint: true },
    run: async ({ strategyName, templateName, parameters, description, overwrite }) => ({
      json: strategies.save(strategyName, templateName, jsonObject(parameters, "parameters"), { description, overwrite }),
    }),
  });

  defs.push({
    name: "delete_strategy_settings",
    legacy: "DeleteStrategySettings",
    title: "Delete strategy setting",
    description: "Connector tool: delete a custom strategy setting (a built-in with the same name becomes visible again).",
    input: { strategyName: z.string() },
    annotations: { ...WRITE_LOCAL, destructiveHint: true },
    run: async ({ strategyName }) => ({ json: { status: strategies.remove(strategyName), strategyName } }),
  });

  const modeNote =
    mode === "live" ? " LIVE MODE: places REAL-MONEY bets." : " Paper mode: simulated against the live order book, no real money.";

  defs.push({
    name: "execute_strategy_settings",
    legacy: "ExecuteBfexplorerStrategySettings",
    title: "Execute strategy",
    description: `Execute a strategy setting (e.g. "Bet 10 Euro", "Lay 10 Euro", "Trade x profit", "Close Selection Bet Position") on one selection (default: active market/selection). Returns {status, ...details}; trading strategies start a bot that manages the position.${modeNote}`,
    input: { strategyName: z.string(), marketId: optionalMarketId, selectionId: selectionIdArg.optional() },
    annotations: BETTING,
    run: async ({ strategyName, marketId, selectionId }) => {
      const id = marketOf(marketId);
      return { json: await strategies.execute(strategyName, id, [selectionOf(id, selectionId)]) };
    },
  });

  defs.push({
    name: "execute_strategy_settings_on_selections",
    legacy: "ExecuteBfexplorerStrategySettingsOnSelections",
    title: "Execute strategy on selections",
    description: `Execute a strategy setting on several selections of one market (dutching settings use them together).${modeNote}`,
    input: { strategyName: z.string(), marketId: optionalMarketId, selectionIds: z.array(selectionIdArg).min(1) },
    annotations: BETTING,
    run: async ({ strategyName, marketId, selectionIds }) => ({
      json: await strategies.execute(strategyName, marketOf(marketId), selectionIds.map((s: string | number) => parseSelectionId(s))),
    }),
  });

  defs.push({
    name: "execute_strategy_settings_with_parameters",
    legacy: "ExecuteBfexplorerStrategySettingsWithParameters",
    title: "Execute strategy with parameters",
    description: `Execute a strategy setting with parameter overrides in BFExplorer's flat, dotted or nested form, e.g. strategyName "Trade x profit" with {"OpenBetPosition.BetType":"Lay","CloseBetPosition.Profit":9}, or "Bet 10 Euro" with {"Stake":5,"Odds":3.5}. Unknown parameter names reject the execution.${modeNote}`,
    input: { strategyName: z.string(), marketId: optionalMarketId, selectionId: selectionIdArg.optional(), parameters: parametersArg },
    annotations: BETTING,
    run: async ({ strategyName, marketId, selectionId, parameters }) => {
      const id = marketOf(marketId);
      return { json: await strategies.execute(strategyName, id, [selectionOf(id, selectionId)], jsonObject(parameters, "parameters")) };
    },
  });

  defs.push({
    name: "get_bots",
    legacy: "GetBots",
    title: "Running strategy bots",
    description: "Connector tool: bots started by trading strategies (profit/loss targets, trailing stops, timed closes), with status and recent log.",
    input: { marketId: marketIdArg.optional(), status: z.enum(["running", "finished", "stopped", "failed"]).optional() },
    annotations: READ,
    run: async ({ marketId, status }) => ({ json: bots.list({ marketId: marketId ? assertMarketId(marketId) : undefined, status }) }),
  });

  defs.push({
    name: "stop_bot",
    legacy: "StopBot",
    title: "Stop bot",
    description: "Connector tool: stop a running strategy bot, optionally closing (greening up) the position it manages.",
    input: { botId: z.string(), closePosition: z.boolean().optional() },
    annotations: BETTING,
    run: async ({ botId, closePosition }) => ({ json: await bots.stop(botId, { closePosition }) }),
  });

  // ---------------------------------------------------------------- bets and account

  defs.push({
    name: "get_current_orders",
    legacy: "GetCurrentOrders",
    title: "Current orders and positions",
    description:
      "Connector tool: unsettled bets (matched and unmatched). With a marketId, also each selection's matched position (profit if it wins / loses) and, for single-winner markets, the market profit if each selection wins.",
    input: { marketId: marketIdArg.optional() },
    annotations: READ,
    run: async ({ marketId }) => {
      const id = marketId ? assertMarketId(marketId) : undefined;
      const orders = await exchange.currentOrders(id ? [id] : undefined);
      if (!id) return { json: { mode, orders } };
      const book = await markets.getBook(id, { depth: 1 });
      const positions = selectionPositions(orders);
      const ifNoneWins = [...positions.values()].reduce((t, p) => t + p.ifLose, 0);
      const single = book.numberOfWinners === 1;
      return {
        json: {
          mode,
          orders,
          positions: [...positions].map(([selectionId, p]) => ({
            selectionId,
            ifWin: round(p.ifWin),
            ifLose: round(p.ifLose),
            marketProfitIfWins: single ? round(p.ifWin + ifNoneWins - p.ifLose) : undefined,
          })),
          profitIfNoneOfTheseWins: round(ifNoneWins),
          note: single ? undefined : `Multi-winner market (numberOfWinners=${book.numberOfWinners}): only per-selection ifWin/ifLose apply.`,
        },
      };
    },
  });

  defs.push({
    name: "cancel_bets",
    legacy: "CancelBets",
    title: "Cancel unmatched bets",
    description: "Connector tool: cancel specific unmatched bets (betIds), or every unmatched bet in the market with all:true.",
    input: { marketId: marketIdArg, betIds: z.array(z.string()).min(1).optional(), all: z.boolean().optional() },
    annotations: { ...BETTING, idempotentHint: true },
    run: async ({ marketId, betIds, all }) => {
      if (!betIds && all !== true) throw new Error("Pass betIds, or all:true to cancel every unmatched bet in the market.");
      return { json: { mode, cancelled: await exchange.cancelOrders(assertMarketId(marketId), betIds ?? "ALL") } };
    },
  });

  defs.push({
    name: "get_account_funds",
    legacy: "GetAccountFunds",
    title: "Account funds",
    description: "Connector tool: available balance and exposure (the paper bankroll in paper mode).",
    annotations: READ,
    run: async () => ({ json: await exchange.accountFunds() }),
  });

  defs.push({
    name: "get_all_bet_results",
    legacy: "GetAllBetResults",
    title: "Bet results",
    description:
      "Settled bets of the last N days grouped like BFExplorer (betResults per market and selection with each bet's time, betType, price, size, profit), plus totals, commission and per-strategy strike rate/ROI.",
    input: { days: z.number().positive().max(90).optional().describe("Look-back in days (default 7)"), marketId: marketIdArg.optional() },
    annotations: READ,
    run: async ({ days, marketId }) => {
      const from = new Date(Date.now() - (days ?? 7) * 86400_000);
      const settled = await exchange.settledBets(from, marketId ? [assertMarketId(marketId)] : undefined);
      return { json: { mode, from: utcSeconds(from), ...groupBetResults(settled.bets, state), ...totals(settled) } };
    },
  });

  // ---------------------------------------------------------------- application

  const commands: Record<string, { description: string; run: () => Promise<string> }> = {
    RecordNow: {
      description: "Poll every monitored market now (refresh recordings, paper fills and settlements).",
      run: async () => {
        await connector.recordOnce();
        return "Recorded monitored markets.";
      },
    },
    StopAllBots: { description: "Stop every running strategy bot (positions stay open).", run: async () => `Stopped ${await bots.stopAll()} bot(s).` },
    RemoveClosedMarkets: {
      description: "Remove closed markets from the monitored list.",
      run: async () => {
        let removed = 0;
        for (const [id, m] of state.monitored) if (m.status === "Closed" && state.monitored.delete(id)) removed++;
        state.changed();
        return `Removed ${removed} closed market(s).`;
      },
    },
    ClearActiveMarket: {
      description: "Clear the active market and selection.",
      run: async () => {
        session.activeMarketId = session.activeSelectionId = undefined;
        return "Active market cleared.";
      },
    },
    RetryBetfairLogin: {
      description: "Allow logging in to Betfair again after a failed login (e.g. after fixing the password).",
      run: async () => {
        connector.client?.resetLoginLatch();
        return "Login will be retried on the next Betfair call.";
      },
    },
  };

  defs.push({
    name: "get_application_commands",
    legacy: "GetApplicationActions",
    title: "Application commands",
    description: "Commands that execute_application_command can run.",
    annotations: READ,
    run: async () => ({ toon: { commands: Object.entries(commands).map(([id, c]) => ({ id, description: c.description })) }, root: "applicationCommands" }),
  });

  defs.push({
    name: "execute_application_command",
    legacy: "ExecuteApplicationAction",
    title: "Execute application command",
    description: "Run a command from get_application_commands.",
    input: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async ({ id }) => {
      const command = Object.entries(commands).find(([key]) => key.toLowerCase() === String(id).toLowerCase());
      if (!command) throw new Error(`Unknown command "${id}". Available: ${Object.keys(commands).join(", ")}`);
      return { json: { status: true, message: await command[1].run() } };
    },
  });

  defs.push({
    name: "get_connector_status",
    legacy: "GetConnectorStatus",
    title: "Connector status",
    description: "Connector tool: trading mode, risk limits, Betfair login/connectivity, delayed-key detection, monitored markets and bots. Call this first if anything fails.",
    annotations: READ,
    run: async () => {
      let betfair: Record<string, unknown> = { configured: connector.betfairConfigured, ...(connector.client?.loginStatus() ?? {}) };
      if (connector.betfairConfigured) {
        try {
          const rules = await exchange.currencyRules();
          const funds = await connector.api.getAccountFunds();
          betfair = { ...betfair, connected: true, currency: rules.currency, minBetSize: rules.minBetSize, minBetPayout: rules.minBetPayout, accountAvailableToBetBalance: funds.availableToBetBalance };
        } catch (error) {
          betfair = { ...betfair, connected: false, error: (error as Error).message };
        }
      }
      const delayed = connector.recorder.marketIds().some((id) => connector.recorder.get(id)?.delayed);
      return {
        json: {
          mode,
          toolNames: naming,
          limits: { maxStake: config.trading.maxStake, maxLiability: config.trading.maxLiability },
          betfair,
          delayedApplicationKey: delayed || undefined,
          paperFunds: mode === "paper" && connector.betfairConfigured ? await exchange.accountFunds().catch((e: Error) => ({ error: e.message })) : undefined,
          activeMarketId: session.activeMarketId,
          monitoredMarkets: [...state.monitored.values()].filter((m) => !m.companionOf).length,
          runningBots: bots.list({ status: "running" }).length,
          recordingIntervalSeconds: config.recording.intervalSeconds,
          promptLibrary: { prompts: prompts.entries.length, fullySupported: prompts.entries.filter((e) => e.compatibility === "full").length },
          persistence: config.dataDir ? (state.readOnly ? "file (read-only: DATA_DIR is used by another process)" : "file") : "memory",
          displayTimeZone: config.output.displayTimeZone,
        },
      };
    },
  });

  // ---------------------------------------------------------------- prompt library

  defs.push({
    name: "search_strategy_prompts",
    legacy: "SearchStrategyPrompts",
    title: "Search strategy prompts",
    description:
      "Connector tool: search the BetfairAiTrading prompt library (analysis and execution prompts for horse racing, football, tennis and trading). Results show the tools/data contexts each needs, whether it is fully supported here and whether it places bets.",
    input: {
      query: z.string().optional().describe("Keywords, e.g. 'favourite EV', 'weight of money', 'candlestick', 'dutch'"),
      category: z.enum(["HorseRacing", "General", "Football", "Templates", "Tutorials"]).optional(),
      onlyFullySupported: z.boolean().optional(),
      executesBets: z.boolean().optional().describe("Filter by whether the prompt places bets"),
      limit: z.number().int().min(1).max(130).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args) => ({ json: prompts.search(args) }),
  });

  defs.push({
    name: "get_strategy_prompt",
    legacy: "GetStrategyPrompt",
    title: "Get strategy prompt",
    description: "Connector tool: full text of a library prompt (from search_strategy_prompts), prefixed with notes on running it here (tool names, formats, missing data). Then follow it.",
    input: { id: z.string().describe('e.g. "HorseRacing/HorseRacingBetfairSpDataR1_Favourite"'), marketId: marketIdArg.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ id, marketId }) => {
      const entry = prompts.get(id);
      if (!entry) throw new Error(`Prompt "${id}" not found. Use search_strategy_prompts to find ids.`);
      return { json: { ...summary(entry), text: renderPrompt(entry, { mode, marketId, toolNaming: naming }) } };
    },
  });

  // ---------------------------------------------------------------- registration

  const server = new McpServer(
    { name: "betfair-ai-trading", title: "Betfair AI Trading", version: VERSION },
    { instructions: instructions(connector, naming) },
  );
  for (const def of defs) {
    const names = naming === "both" ? [def.name, def.legacy] : [naming === "legacy" ? def.legacy : def.name];
    for (const toolName of names) {
      const other = toolName === def.name ? def.legacy : def.name;
      server.registerTool(
        toolName,
        { title: def.title, description: `${def.description} (Also known as ${other}.)`, inputSchema: def.input ?? {}, annotations: def.annotations },
        async (args: unknown) => {
          try {
            return render(await def.run(args ?? {}));
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
          }
        },
      );
    }
  }

  for (const [promptName, entry] of promptNames(prompts.entries)) {
    const flags = [entry.executesBets ? "Places bets." : "", entry.compatibility === "partial" ? "Partly supported here." : ""].filter(Boolean).join(" ");
    server.registerPrompt(
      promptName,
      {
        title: entry.title,
        description: `${entry.description}${flags ? ` (${flags})` : ""}`.slice(0, 500),
        argsSchema: { marketId: z.string().optional().describe("Market to work on (defaults to the active market)") },
      },
      ({ marketId }) => ({
        description: entry.title,
        messages: [{ role: "user", content: { type: "text", text: renderPrompt(entry, { mode, marketId, toolNaming: naming }) } }],
      }),
    );
  }

  server.registerResource(
    "strategy-prompt",
    new ResourceTemplate("betfair-prompts://{category}/{name}", {
      list: async () => ({
        resources: prompts.entries.map((e) => ({ uri: `betfair-prompts://${e.id}`, name: e.id, title: e.title, description: e.description, mimeType: "text/markdown" })),
      }),
    }),
    { title: "BetfairAiTrading prompt", description: "Prompt library entries as markdown", mimeType: "text/markdown" },
    async (uri, { category, name: promptName }) => {
      const entry = prompts.get(`${category}/${promptName}`);
      if (!entry) throw new Error(`Unknown prompt ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: entry.body }] };
    },
  );

  // BFExplorer's MCP resources.
  const resource = (resourceName: string, read: () => Promise<Output>) =>
    server.registerResource(resourceName, `bfexplorer://${resourceName}`, { title: resourceName, mimeType: "text/plain" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: render(await read()).content.map((c) => ("text" in c ? c.text : "")).join("") }],
    }));
  const tool = (snake: string) => defs.find((d) => d.name === snake)!;
  resource("activeBetfairMarket", () => tool("get_active_market").run({}));
  resource("betfairMonitoredMarkets", () => tool("get_monitored_markets").run({}));
  resource("bfexplorerStrategySettings", () => tool("get_all_strategy_settings").run({}));
  resource("bfexplorerStrategyTemplates", () => tool("get_all_strategy_templates").run({}));

  return server;
}

function instructions(connector: Connector, naming: "snake" | "legacy" | "both"): string {
  const n = (snake: string, legacy: string) => (naming === "legacy" ? legacy : snake);
  const mode = connector.exchange.mode;
  return [
    "Betfair AI Trading connector: BFExplorer's MCP tools reimplemented on the Betfair Exchange API, plus the BetfairAiTrading prompt library.",
    mode === "paper"
      ? "PAPER TRADING: executions are simulated against the live Betfair order book and settled with real results. No real money is used."
      : "LIVE TRADING: executions place REAL-MONEY bets on the user's Betfair account. Confirm stakes and selections with the user before executing unless they explicitly asked for autonomous execution.",
    `Workflow: ${n("find_markets", "FindMarkets")} -> ${n("open_market", "OpenMarket")} (active market; starts trade recording) -> ${n("get_active_market", "GetActiveMarket")} -> ${n("get_all_data_context_for_market", "GetAllDataContextForMarket")} -> analysis -> ${n("execute_strategy_settings", "ExecuteBfexplorerStrategySettings")}.`,
    "Library prompts name tools in three styles; they are the same tools: GetActiveMarket = get_active_market, GetAllDataContextForMarket = get_all_data_context_for_market, ExecuteBfexplorerStrategySettings = execute_strategy_settings, ExecuteBfexplorerStrategySettingsWithParameters = execute_strategy_settings_with_parameters, SetAIAgentDataContextForBetfairMarket = set_ai_agent_data_context_for_market, ActivateBetfairMarketSelection = activate_market_selection, GetBetfairMonitoredMarkets = get_monitored_markets.",
    "Market tools return TOON text; data contexts return JSON {market, selectionsData:[{selectionId, name, data}], data}. Selection ids are plain strings such as \"98427997\". Always pass marketId explicitly once you know it: other conversations may change the active market.",
    "Racing Post, Timeform, At The Races and other third-party data contexts are BFExplorer-only and come back as unavailable: continue without them and never invent values.",
  ].join("\n");
}

// ---------------------------------------------------------------- bet results

function groupBetResults(bets: SettledBetView[], state: State) {
  const markets = new Map<string, { market: Record<string, unknown>; profit: number; selections: Map<string, { name: string; status?: string; profit: number; bets: unknown[] }> }>();
  for (const bet of bets) {
    const archived = state.archive.get(bet.marketId);
    let group = markets.get(bet.marketId);
    if (!group) {
      group = {
        market: {
          marketId: bet.marketId,
          startTime: archived?.startTime ? utcSeconds(archived.startTime) : bet.marketStartTime ? utcSeconds(bet.marketStartTime) : undefined,
          eventName: archived?.venue ?? archived?.eventName ?? bet.event,
          marketName: archived?.marketName ?? bet.market,
        },
        profit: 0,
        selections: new Map(),
      };
      markets.set(bet.marketId, group);
    }
    group.profit += bet.profit;
    const runner = archived?.runners.find((r) => formatSelectionId(r.selectionId, r.handicap) === bet.selectionId);
    let selection = group.selections.get(bet.selectionId);
    if (!selection) {
      const won = bet.outcome === "WON";
      const derived = bet.side === "BACK" ? (won ? "Winner" : "Loser") : won ? "Loser" : "Winner";
      selection = { name: runner?.name ?? bet.selection ?? bet.selectionId, status: runner?.status ?? derived, profit: 0, bets: [] };
      group.selections.set(bet.selectionId, selection);
    }
    selection.profit += bet.profit;
    selection.bets.push({
      time: bet.placedDate ? utcSeconds(bet.placedDate) : undefined,
      betType: bet.side === "BACK" ? "Back" : "Lay",
      price: bet.priceMatched,
      size: bet.sizeSettled,
      profit: round(bet.profit, 4),
      strategy: bet.strategy,
    });
  }
  return {
    betResults: [...markets.values()].map((g) => ({
      market: g.market,
      profit: round(g.profit, 4),
      selectionsBets: [...g.selections].map(([selectionId, s]) => ({ selectionId, name: s.name, status: s.status, profit: round(s.profit, 4), bets: s.bets })),
    })),
  };
}

function totals(settled: { bets: SettledBetView[]; commission?: number; truncated?: boolean }) {
  const byStrategy = new Map<string, { bets: number; won: number; profit: number; staked: number }>();
  for (const b of settled.bets) {
    const key = b.strategy || "(none)";
    const s = byStrategy.get(key) ?? { bets: 0, won: 0, profit: 0, staked: 0 };
    s.bets++;
    if (b.outcome === "WON") s.won++;
    s.profit += b.profit;
    s.staked += b.side === "BACK" ? (b.sizeSettled ?? 0) : (b.sizeSettled ?? 0) * ((b.priceMatched ?? 1) - 1);
    byStrategy.set(key, s);
  }
  const gross = settled.bets.reduce((t, b) => t + b.profit, 0);
  return {
    summary: {
      bets: settled.bets.length,
      won: settled.bets.filter((b) => b.outcome === "WON").length,
      grossProfit: round(gross),
      commission: settled.commission,
      netProfit: settled.commission !== undefined ? round(gross - settled.commission) : undefined,
      truncated: settled.truncated,
    },
    byStrategy: [...byStrategy].map(([strategy, s]) => ({
      strategy,
      bets: s.bets,
      strikeRate: round((s.won / s.bets) * 100, 1),
      profit: round(s.profit),
      roiPercent: s.staked ? round((s.profit / s.staked) * 100, 1) : undefined,
    })),
  };
}
