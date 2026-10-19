import path from "node:path";
import { fileURLToPath } from "node:url";

export type TradingMode = "paper" | "live";

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
  };
  trading: {
    mode: TradingMode;
    maxStake: number;
    maxLiability: number;
    paperStartingBalance: number;
    paperCommissionRate: number;
  };
  recording: {
    intervalSeconds: number;
    maxMonitoredMarkets: number;
    maxSnapshotsPerMarket: number;
  };
  dataDir?: string;
  promptsDir: string;
  http: {
    port: number;
    host: string;
    authToken?: string;
  };
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (str(env, "TRADING_MODE") ?? "paper").toLowerCase();
  if (mode !== "paper" && mode !== "live") {
    throw new Error(`TRADING_MODE must be "paper" or "live", got "${mode}"`);
  }
  const dataDir = str(env, "DATA_DIR");
  return {
    betfair: {
      appKey: str(env, "BETFAIR_APP_KEY"),
      username: str(env, "BETFAIR_USERNAME"),
      password: str(env, "BETFAIR_PASSWORD"),
      sessionToken: str(env, "BETFAIR_SESSION_TOKEN"),
      certFile: str(env, "BETFAIR_CERT_FILE"),
      keyFile: str(env, "BETFAIR_KEY_FILE"),
      identityUrl: str(env, "BETFAIR_IDENTITY_URL") ?? "https://identitysso.betfair.com/api",
      certIdentityUrl: str(env, "BETFAIR_CERT_IDENTITY_URL") ?? "https://identitysso-cert.betfair.com/api",
      apiUrl: (str(env, "BETFAIR_API_URL") ?? "https://api.betfair.com/exchange").replace(/\/+$/, ""),
      requestTimeoutMs: num(env, "BETFAIR_REQUEST_TIMEOUT_MS", 15000),
    },
    trading: {
      mode,
      maxStake: num(env, "MAX_STAKE", 25),
      maxLiability: num(env, "MAX_LIABILITY", 250),
      paperStartingBalance: num(env, "PAPER_STARTING_BALANCE", 1000),
      paperCommissionRate: num(env, "PAPER_COMMISSION_RATE", 0.05),
    },
    recording: {
      intervalSeconds: num(env, "RECORD_INTERVAL_SECONDS", 30),
      maxMonitoredMarkets: num(env, "MAX_MONITORED_MARKETS", 20),
      maxSnapshotsPerMarket: num(env, "MAX_SNAPSHOTS_PER_MARKET", 720),
    },
    dataDir: dataDir ? path.resolve(dataDir) : undefined,
    promptsDir: path.resolve(str(env, "PROMPTS_DIR") ?? path.join(packageRoot, "prompts")),
    http: {
      port: num(env, "PORT", 3000),
      host: str(env, "HOST") ?? "127.0.0.1",
      authToken: str(env, "MCP_AUTH_TOKEN"),
    },
  };
}

export function hasBetfairCredentials(config: Config): boolean {
  const b = config.betfair;
  return Boolean(b.appKey && (b.sessionToken || (b.username && b.password)));
}
