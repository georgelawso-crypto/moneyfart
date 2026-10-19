import path from "node:path";
import { fileURLToPath } from "node:url";

export type TradingMode = "paper" | "live";
export type ToolNaming = "snake" | "legacy" | "both";

export interface Config {
  betfair: {
    appKey?: string;
    username?: string;
    password?: string;
    sessionToken?: string;
    certFile?: string;
    keyFile?: string;
    identityUrl: string;
    certIdentityUrl: string;
    apiUrl: string;
    requestTimeoutMs: number;
    /** placeOrders may legitimately take longer (in-play bet delay), so it gets its own timeout. */
    placeOrdersTimeoutMs: number;
    /** How often to call keepAlive; 0 disables. */
    keepAliveMinutes: number;
  };
  trading: {
    mode: TradingMode;
    maxStake: number;
    maxLiability: number;
    paperStartingBalance: number;
    paperCommissionRate: number;
    /** Currency assumed for paper trading (live mode reads it from the account). */
    paperCurrency: string;
    /** Overrides for Betfair's minimum bet size / minimum payout rule (account currency). */
    minBetSize?: number;
    minBetPayout?: number;
  };
  recording: {
    intervalSeconds: number;
    /** Polling interval for markets with running bots (trading strategies). */
    botIntervalSeconds: number;
    maxMonitoredMarkets: number;
    /** Markets whose trade recordings are kept in memory (LRU). */
    maxRecordedMarkets: number;
    maxTradesPerSelection: number;
  };
  output: {
    toolNames: ToolNaming;
    /** IANA time zone used for data-context times (BFExplorer uses the host's local offset). */
    displayTimeZone: string;
    /** Drop connector-only additions (e.g. inPlay in market TOON) to mirror BFExplorer byte-for-byte. */
    strictBfexplorer: boolean;
  };
  dataDir?: string;
  promptsDir: string;
  http: {
    port: number;
    host: string;
    authToken?: string;
    /** Browser origins allowed to call the server (requests with any other Origin header are refused). */
    allowedOrigins: string[];
    /** Opt-out of the token requirement for loopback-only, paper-mode servers. */
    allowUnauthenticatedLoopback: boolean;
    /** Accept MCP at "/" as well as "/mcp" (BFExplorer clients use http://localhost:10043/). */
    bfexplorerCompat: boolean;
  };
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number;
function num(env: NodeJS.ProcessEnv, name: string, fallback?: undefined): number | undefined;
function num(env: NodeJS.ProcessEnv, name: string, fallback?: number): number | undefined {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = str(env, name)?.toLowerCase();
  if (raw === undefined) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, values: readonly T[], fallback: T): T {
  const raw = (str(env, name) ?? fallback).toLowerCase();
  if (!(values as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${values.join(", ")}, got "${raw}"`);
  }
  return raw as T;
}

function validTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    throw new Error(`DISPLAY_TIMEZONE "${zone}" is not a valid IANA time zone`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = str(env, "DATA_DIR");
  const identityUrl = str(env, "BETFAIR_IDENTITY_URL") ?? "https://identitysso.betfair.com/api";
  const bfexplorerCompat = bool(env, "BFEXPLORER_COMPAT");
  // Italian/Spanish exchange sessions expire after 20 minutes; .com after 12-24 hours.
  const shortSessions = /betfair\.(it|es)\b/.test(identityUrl);
  return {
    betfair: {
      appKey: str(env, "BETFAIR_APP_KEY"),
      username: str(env, "BETFAIR_USERNAME"),
      password: str(env, "BETFAIR_PASSWORD"),
      sessionToken: str(env, "BETFAIR_SESSION_TOKEN"),
      certFile: str(env, "BETFAIR_CERT_FILE"),
      keyFile: str(env, "BETFAIR_KEY_FILE"),
      identityUrl,
      certIdentityUrl: str(env, "BETFAIR_CERT_IDENTITY_URL") ?? "https://identitysso-cert.betfair.com/api",
      apiUrl: (str(env, "BETFAIR_API_URL") ?? "https://api.betfair.com/exchange").replace(/\/+$/, ""),
      requestTimeoutMs: num(env, "BETFAIR_REQUEST_TIMEOUT_MS", 15000),
      placeOrdersTimeoutMs: num(env, "BETFAIR_PLACE_ORDERS_TIMEOUT_MS", 30000),
      keepAliveMinutes: num(env, "BETFAIR_KEEPALIVE_MINUTES", shortSessions ? 10 : 240),
    },
    trading: {
      mode: oneOf(env, "TRADING_MODE", ["paper", "live"] as const, "paper"),
      maxStake: num(env, "MAX_STAKE", 25),
      maxLiability: num(env, "MAX_LIABILITY", 250),
      paperStartingBalance: num(env, "PAPER_STARTING_BALANCE", 1000),
      paperCommissionRate: num(env, "PAPER_COMMISSION_RATE", 0.05),
      paperCurrency: (str(env, "PAPER_CURRENCY") ?? "GBP").toUpperCase(),
      minBetSize: num(env, "MIN_BET_SIZE"),
      minBetPayout: num(env, "MIN_BET_PAYOUT"),
    },
    recording: {
      intervalSeconds: num(env, "RECORD_INTERVAL_SECONDS", 30),
      botIntervalSeconds: num(env, "BOT_INTERVAL_SECONDS", 5),
      maxMonitoredMarkets: num(env, "MAX_MONITORED_MARKETS", 20),
      maxRecordedMarkets: num(env, "MAX_RECORDED_MARKETS", 60),
      maxTradesPerSelection: num(env, "MAX_TRADES_PER_SELECTION", 5000),
    },
    output: {
      toolNames: oneOf(env, "TOOL_NAMES", ["snake", "legacy", "both"] as const, "snake"),
      displayTimeZone: validTimeZone(str(env, "DISPLAY_TIMEZONE") ?? "Europe/London"),
      strictBfexplorer: bool(env, "BFEXPLORER_STRICT"),
    },
    dataDir: dataDir ? path.resolve(dataDir) : undefined,
    promptsDir: path.resolve(str(env, "PROMPTS_DIR") ?? path.join(packageRoot, "prompts")),
    http: {
      port: num(env, "PORT", bfexplorerCompat ? 10043 : 3000),
      host: str(env, "HOST") ?? "127.0.0.1",
      authToken: str(env, "MCP_AUTH_TOKEN"),
      allowedOrigins: (str(env, "MCP_ALLOWED_ORIGINS") ?? "")
        .split(",")
        .map((o) => o.trim().replace(/\/+$/, ""))
        .filter(Boolean),
      allowUnauthenticatedLoopback: bool(env, "MCP_ALLOW_UNAUTHENTICATED_LOOPBACK"),
      bfexplorerCompat,
    },
  };
}

export function hasBetfairCredentials(config: Config): boolean {
  const b = config.betfair;
  return Boolean(b.appKey && (b.sessionToken || (b.username && b.password)));
}
