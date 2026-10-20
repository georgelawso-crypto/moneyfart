import path from "node:path";
import { fileURLToPath } from "node:url";

export type TradingMode = "paper" | "live";
export type ToolNaming = "snake" | "legacy" | "both";
/** Betfair exchange the account belongs to: "au" (betfair.com.au) or "com" (international/UK). */
export type Jurisdiction = "au" | "com";

interface JurisdictionPreset {
  label: string;
  identityUrl: string;
  certIdentityUrl: string;
  apiUrl: string;
  /** Default PAPER_CURRENCY (live mode reads the currency from the account). */
  currency: string;
  /** Default DISPLAY_TIMEZONE (BFExplorer shows the host's local time). */
  timeZone: string;
}

/**
 * Betfair Australia: "Correct endpoints for Australian customers: identitysso.betfair.com.au/api/login
 * and identitysso-cert.betfair.com.au/api/certlogin"; a wrong endpoint is a common cause of 403s
 * (betfair-datascientists.github.io/api/apiResources). Betting calls stay on api.betfair.com.
 */
export const JURISDICTIONS: Record<Jurisdiction, JurisdictionPreset> = {
  au: {
    label: "Australia (betfair.com.au)",
    identityUrl: "https://identitysso.betfair.com.au/api",
    certIdentityUrl: "https://identitysso-cert.betfair.com.au/api",
    apiUrl: "https://api.betfair.com/exchange",
    currency: "AUD",
    timeZone: "Australia/Sydney",
  },
  com: {
    label: "International (betfair.com)",
    identityUrl: "https://identitysso.betfair.com/api",
    certIdentityUrl: "https://identitysso-cert.betfair.com/api",
    apiUrl: "https://api.betfair.com/exchange",
    currency: "GBP",
    timeZone: "Europe/London",
  },
};

const JURISDICTION_NAMES: Record<string, Jurisdiction> = {
  au: "au",
  aus: "au",
  australia: "au",
  com: "com",
  int: "com",
  international: "com",
  uk: "com",
  gb: "com",
};

/** Risk limits (account currency). Live mode refuses to start unless each one is set explicitly. */
export const LIMIT_VARIABLES = ["MAX_STAKE", "MAX_LIABILITY", "MAX_MARKET_LIABILITY", "MAX_TOTAL_EXPOSURE", "DAILY_LOSS_LIMIT"] as const;

export interface Config {
  betfair: {
    jurisdiction: Jurisdiction;
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
    /** Largest back stake of one risk-adding bet. */
    maxStake: number;
    /** Largest liability (back stake, or lay liability) of one risk-adding bet. */
    maxLiability: number;
    /** Largest worst-case loss of one market (matched bets plus unmatched ones as if they matched). */
    maxMarketLiability: number;
    /** Largest worst-case loss across every open market. */
    maxTotalExposure: number;
    /** Most that can be lost in a day: today's settled losses plus the worst case of everything open. */
    dailyLossLimit: number;
    /** Limit variables left at their defaults (live mode refuses to start while any is unset). */
    unsetLimits: string[];
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
  // Plain decimals only: Number() would also read "0x10" as 16 or "1e3" as 1000.
  const value = /^(\d+(\.\d*)?|\.\d+)$/.test(raw) ? Number(raw) : Number.NaN;
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

function jurisdictionOf(env: NodeJS.ProcessEnv): Jurisdiction {
  const raw = str(env, "BETFAIR_JURISDICTION") ?? "au";
  const name = raw.toLowerCase();
  if (!Object.hasOwn(JURISDICTION_NAMES, name)) throw new Error(`BETFAIR_JURISDICTION must be AU (betfair.com.au) or COM (international/UK), got "${raw}"`);
  return JURISDICTION_NAMES[name];
}

/** Endpoint override: an https URL without trailing slashes. */
function endpoint(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const url = (str(env, name) ?? fallback).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} must be a URL, got "${url}"`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${name} must be an https:// URL (credentials and session tokens are sent to it), got "${url}"`);
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = str(env, "DATA_DIR");
  const jurisdiction = jurisdictionOf(env);
  const preset = JURISDICTIONS[jurisdiction];
  const identityUrl = endpoint(env, "BETFAIR_IDENTITY_URL", preset.identityUrl);
  const bfexplorerCompat = bool(env, "BFEXPLORER_COMPAT");
  // Italian/Spanish exchange sessions expire after 20 minutes; .com after 12-24 hours.
  const shortSessions = /betfair\.(it|es)\b/.test(identityUrl);
  return {
    betfair: {
      jurisdiction,
      appKey: str(env, "BETFAIR_APP_KEY"),
      username: str(env, "BETFAIR_USERNAME"),
      password: str(env, "BETFAIR_PASSWORD"),
      sessionToken: str(env, "BETFAIR_SESSION_TOKEN"),
      certFile: str(env, "BETFAIR_CERT_FILE"),
      keyFile: str(env, "BETFAIR_KEY_FILE"),
      identityUrl,
      certIdentityUrl: endpoint(env, "BETFAIR_CERT_IDENTITY_URL", preset.certIdentityUrl),
      apiUrl: endpoint(env, "BETFAIR_API_URL", preset.apiUrl),
      requestTimeoutMs: num(env, "BETFAIR_REQUEST_TIMEOUT_MS", 15000),
      placeOrdersTimeoutMs: num(env, "BETFAIR_PLACE_ORDERS_TIMEOUT_MS", 30000),
      keepAliveMinutes: num(env, "BETFAIR_KEEPALIVE_MINUTES", shortSessions ? 10 : 240),
    },
    trading: {
      mode: oneOf(env, "TRADING_MODE", ["paper", "live"] as const, "paper"),
      maxStake: num(env, "MAX_STAKE", 25),
      maxLiability: num(env, "MAX_LIABILITY", 250),
      maxMarketLiability: num(env, "MAX_MARKET_LIABILITY", 250),
      maxTotalExposure: num(env, "MAX_TOTAL_EXPOSURE", 500),
      dailyLossLimit: num(env, "DAILY_LOSS_LIMIT", 250),
      unsetLimits: LIMIT_VARIABLES.filter((name) => str(env, name) === undefined),
      paperStartingBalance: num(env, "PAPER_STARTING_BALANCE", 1000),
      paperCommissionRate: num(env, "PAPER_COMMISSION_RATE", 0.05),
      paperCurrency: (str(env, "PAPER_CURRENCY") ?? preset.currency).toUpperCase(),
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
      displayTimeZone: validTimeZone(str(env, "DISPLAY_TIMEZONE") ?? preset.timeZone),
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

/**
 * Live mode must not run on default limits: every limit has to be a number the account holder
 * chose. Throws with the missing variables (call before starting a live connector).
 */
export function checkLiveSafety(config: Config) {
  if (config.trading.mode !== "live") return;
  const missing = config.trading.unsetLimits;
  if (missing.length) {
    throw new Error(
      `TRADING_MODE=live needs every risk limit set explicitly, in the account currency. Missing: ${missing.join(", ")}. ` +
        "See .env.example for what each one caps; DAILY_LOSS_LIMIT is the most the connector can lose in a day.",
    );
  }
}

export function hasBetfairCredentials(config: Config): boolean {
  const b = config.betfair;
  return Boolean(b.appKey && (b.sessionToken || (b.username && b.password)));
}
