import fs from "node:fs";
import https from "node:https";
import type { Config } from "../config.js";
import type {
  AccountDetails,
  AccountFunds,
  CancelExecutionReport,
  CancelInstruction,
  ClearedOrderSummaryReport,
  CurrentOrderSummaryReport,
  EventTypeResult,
  MarketBook,
  MarketCatalogue,
  MarketFilter,
  PlaceExecutionReport,
  PlaceInstruction,
  PriceProjection,
  TimeRange,
} from "./types.js";

/** Everything the connector needs from Betfair. Tests supply a fake implementation. */
export interface BetfairApi {
  listEventTypes(filter?: MarketFilter): Promise<EventTypeResult[]>;
  listMarketCatalogue(args: {
    filter: MarketFilter;
    marketProjection?: string[];
    sort?: string;
    maxResults: number;
  }): Promise<MarketCatalogue[]>;
  listMarketBook(args: {
    marketIds: string[];
    priceProjection?: PriceProjection;
    orderProjection?: "ALL" | "EXECUTABLE" | "EXECUTION_COMPLETE";
    matchProjection?: "NO_ROLLUP" | "ROLLED_UP_BY_PRICE" | "ROLLED_UP_BY_AVG_PRICE";
  }): Promise<MarketBook[]>;
  placeOrders(args: {
    marketId: string;
    instructions: PlaceInstruction[];
    customerRef?: string;
    customerStrategyRef?: string;
  }): Promise<PlaceExecutionReport>;
  cancelOrders(args: { marketId?: string; instructions?: CancelInstruction[] }): Promise<CancelExecutionReport>;
  listCurrentOrders(args: {
    betIds?: string[];
    marketIds?: string[];
    orderProjection?: "ALL" | "EXECUTABLE" | "EXECUTION_COMPLETE";
    customerOrderRefs?: string[];
    customerStrategyRefs?: string[];
    dateRange?: TimeRange;
    fromRecord?: number;
    recordCount?: number;
  }): Promise<CurrentOrderSummaryReport>;
  listClearedOrders(args: {
    betStatus: "SETTLED" | "VOIDED" | "LAPSED" | "CANCELLED";
    marketIds?: string[];
    customerStrategyRefs?: string[];
    settledDateRange?: TimeRange;
    groupBy?: "EVENT_TYPE" | "EVENT" | "MARKET" | "SIDE" | "BET" | "RUNNER" | "STRATEGY";
    includeItemDescription?: boolean;
    fromRecord?: number;
    recordCount?: number;
  }): Promise<ClearedOrderSummaryReport>;
  getAccountFunds(): Promise<AccountFunds>;
  getAccountDetails(): Promise<AccountDetails>;
}

export class BetfairApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BetfairApiError";
  }
}

/**
 * Codes after which a request may have been processed by Betfair although no usable answer
 * arrived (client timeout, dropped connection, unreadable body, Betfair-side timeout).
 */
const UNCERTAIN_CODES = new Set(["TIMEOUT", "NETWORK_ERROR", "TIMEOUT_ERROR", "UNEXPECTED_ERROR", "UNKNOWN_ERROR"]);

/** True when a failed call may still have taken effect (e.g. a bet placed): check before retrying. */
export function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof BetfairApiError)) return true;
  return UNCERTAIN_CODES.has(error.code) || /^HTTP_[25]\d\d$/.test(error.code);
}

const SESSION_ERRORS = new Set(["INVALID_SESSION_INFORMATION", "NO_SESSION", "INVALID_SESSION_TOKEN"]);

/** Login failures that will not fix themselves: no further login attempts until resetLoginLatch() or a restart. */
const TERMINAL_LOGIN_ERRORS = new Set([
  "INVALID_USERNAME_OR_PASSWORD",
  "ACCOUNT_NOW_LOCKED",
  "ACCOUNT_ALREADY_LOCKED",
  "PENDING_AUTH",
  "TELBET_TERMS_CONDITIONS_NA",
  "DUPLICATE_CARDS",
  "SECURITY_QUESTION_WRONG_3X",
  "KYC_SUSPEND",
  "SUSPENDED",
  "CLOSED",
  "SELF_EXCLUDED",
  "INVALID_CONNECTIVITY_TO_REGULATOR_DK",
  "INVALID_CONNECTIVITY_TO_REGULATOR_IT",
  "NOT_AUTHORIZED_BY_REGULATOR_DK",
  "NOT_AUTHORIZED_BY_REGULATOR_IT",
  "SECURITY_RESTRICTED_LOCATION",
  "BETTING_RESTRICTED_LOCATION",
  "TRADING_MASTER",
  "TRADING_MASTER_SUSPENDED",
  "AGENT_CLIENT_MASTER",
  "AGENT_CLIENT_MASTER_SUSPENDED",
  "DANISH_AUTHORIZATION_REQUIRED",
  "SPAIN_MIGRATION_REQUIRED",
  "DENMARK_MIGRATION_REQUIRED",
  "SPANISH_TERMS_ACCEPTANCE_REQUIRED",
  "ITALIAN_TERMS_ACCEPTANCE_REQUIRED",
  "CERT_AUTH_REQUIRED",
  "CHANGE_PASSWORD_REQUIRED",
  "PERSONAL_MESSAGE_REQUIRED",
  "INTERNATIONAL_TERMS_ACCEPTANCE_REQUIRED",
  "EMAIL_LOGIN_NOT_ALLOWED",
  "MULTIPLE_USERS_WITH_SAME_CREDENTIAL",
  "ACCOUNT_PENDING_PASSWORD_CHANGE",
  "ACTIONS_REQUIRED",
  "INPUT_VALIDATION_ERROR",
]);
const TEMPORARY_BAN = "TEMPORARY_BAN_TOO_MANY_REQUESTS";
const TEMPORARY_BAN_MS = 20 * 60_000;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** setInterval silently fires every 1 ms for delays above this. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface BetfairClientOptions {
  /** Clock used for login back-off (tests inject one). */
  now?: () => number;
}

export interface LoginStatus {
  /** App key plus a session token or username/password. */
  configured: boolean;
  /** A session token is held (it may still have expired on Betfair's side). */
  loggedIn: boolean;
  lastError?: string;
  lastErrorCode?: string;
  /** While backing off (or temporarily banned): when the next login attempt is allowed. */
  retryAt?: string;
  /** A terminal login error stopped all login attempts until resetLoginLatch(). */
  latched: boolean;
}

interface LoginBlock {
  code: string;
  message: string;
  /** Infinity when latched. */
  until: number;
}

type Fetch = typeof globalThis.fetch;
type ApiName = "betting" | "account";

export class BetfairClient implements BetfairApi {
  private sessionToken?: string;
  private loginInFlight?: Promise<string>;
  private requestId = 0;
  private loginBlock?: LoginBlock;
  private loginFailures = 0;
  private lastLoginError?: { code: string; message: string };
  private keepAliveTimer?: NodeJS.Timeout;
  private keepAliveRunning = false;
  private readonly now: () => number;

  constructor(
    private readonly config: Config["betfair"],
    private readonly fetchImpl: Fetch = globalThis.fetch,
    options: BetfairClientOptions = {},
  ) {
    this.sessionToken = config.sessionToken;
    this.now = options.now ?? Date.now;
  }

  private canLogin(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  private async session(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    return this.login();
  }

  // ---------------------------------------------------------------- login

  /**
   * Single-flight login so concurrent calls never trigger more than one login request. After a
   * failure, calls fail fast (latched, temporarily banned or backing off) instead of hammering
   * the login endpoint: the recorder calls Betfair every few seconds.
   */
  async login(): Promise<string> {
    if (!this.loginInFlight) {
      const blocked = this.blockedError();
      if (blocked) throw blocked;
      this.loginInFlight = this.doLogin().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    return this.loginInFlight;
  }

  /** Allow login attempts again after a latched failure (e.g. once the password has been fixed). */
  resetLoginLatch() {
    this.loginBlock = undefined;
    this.loginFailures = 0;
  }

  loginStatus(): LoginStatus {
    const block = this.loginBlock;
    return {
      configured: Boolean(this.config.appKey && (this.config.sessionToken || this.canLogin())),
      loggedIn: Boolean(this.sessionToken),
      lastError: this.lastLoginError?.message,
      lastErrorCode: this.lastLoginError?.code,
      retryAt: block && Number.isFinite(block.until) && block.until > this.now() ? new Date(block.until).toISOString() : undefined,
      latched: block?.until === Infinity,
    };
  }

  private blockedError(): BetfairApiError | undefined {
    const block = this.loginBlock;
    if (!block) return undefined;
    const now = this.now();
    if (now >= block.until) return undefined;
    if (block.until === Infinity) {
      return new BetfairApiError(
        `${block.message}. Login attempts are stopped (to avoid locking the account) until the login is reset with the RetryBetfairLogin application command or the connector restarts.`,
        block.code,
      );
    }
    const wait = Math.ceil((block.until - now) / 1000);
    return new BetfairApiError(`${block.message}. Next login attempt after ${new Date(block.until).toISOString()} (in ${wait} s).`, block.code);
  }

  private async doLogin(): Promise<string> {
    const { appKey, username, password, certFile, keyFile } = this.config;
    if (!appKey) throw new BetfairApiError("BETFAIR_APP_KEY is not configured", "NOT_CONFIGURED");
    if (!username || !password) {
      throw new BetfairApiError(
        "The Betfair session expired and no BETFAIR_USERNAME/BETFAIR_PASSWORD are configured to log in again",
        "NOT_CONFIGURED",
      );
    }
    let token: string;
    try {
      token = certFile && keyFile ? await this.certLogin(appKey, username, password) : await this.interactiveLogin(appKey, username, password);
    } catch (error) {
      throw this.loginFailed(error);
    }
    this.sessionToken = token;
    this.loginBlock = undefined;
    this.loginFailures = 0;
    this.lastLoginError = undefined;
    return token;
  }

  /** Record a failed login, block further attempts accordingly and return the error to throw. */
  private loginFailed(error: unknown): BetfairApiError {
    const failure =
      error instanceof BetfairApiError ? error : new BetfairApiError(`Betfair login request failed: ${describe(error)}`, "LOGIN_FAILED");
    const now = this.now();
    let until: number;
    if (TERMINAL_LOGIN_ERRORS.has(failure.code)) until = Infinity;
    else if (failure.code === TEMPORARY_BAN) until = now + TEMPORARY_BAN_MS;
    else until = now + Math.min(BACKOFF_FIRST_MS * 2 ** this.loginFailures++, BACKOFF_MAX_MS);
    this.lastLoginError = { code: failure.code, message: failure.message };
    this.loginBlock = { code: failure.code, message: failure.message, until };
    return this.blockedError() ?? failure;
  }

  private async interactiveLogin(appKey: string, username: string, password: string): Promise<string> {
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(`${this.config.identityUrl}/login`, {
        method: "POST",
        headers: {
          "X-Application": appKey,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ username, password }).toString(),
        signal: timeoutSignal(this.config.requestTimeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      // Never TIMEOUT/NETWORK_ERROR: nothing was sent to the exchange, so callers must not treat it as "outcome unknown".
      throw new BetfairApiError(`Betfair login request failed: ${transportProblem(error, this.config.requestTimeoutMs)}`, "LOGIN_FAILED");
    }
    let body: { token?: string; status?: string; error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new BetfairApiError(`Betfair login returned HTTP ${status}: ${text.slice(0, 200)}`, "LOGIN_FAILED");
    }
    if (body.status !== "SUCCESS" || !body.token) {
      const code = body.error || (body.status && body.status !== "SUCCESS" ? body.status : "LOGIN_FAILED");
      throw new BetfairApiError(`Betfair login failed: ${code}`, code);
    }
    return body.token;
  }

  private certLogin(appKey: string, username: string, password: string): Promise<string> {
    const url = new URL(`${this.config.certIdentityUrl}/certlogin`);
    const payload = new URLSearchParams({ username, password }).toString();
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: "POST",
          cert: fs.readFileSync(this.config.certFile!),
          key: fs.readFileSync(this.config.keyFile!),
          headers: {
            "X-Application": appKey,
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: this.config.requestTimeoutMs || undefined,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const body = JSON.parse(data) as { sessionToken?: string; loginStatus?: string };
              if (body.loginStatus === "SUCCESS" && body.sessionToken) resolve(body.sessionToken);
              else reject(new BetfairApiError(`Betfair certificate login failed: ${body.loginStatus}`, body.loginStatus || "LOGIN_FAILED"));
            } catch {
              reject(new BetfairApiError(`Betfair certificate login returned HTTP ${res.statusCode}`, "LOGIN_FAILED"));
            }
          });
          res.on("error", reject);
        },
      );
      request.on("timeout", () => request.destroy(new Error("Betfair certificate login timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  }

  // ---------------------------------------------------------------- keepAlive

  /**
   * Extend the session. Returns false when Betfair answers FAIL (the session is gone: the token is
   * dropped so the next call logs in again); throws on transport errors.
   */
  async keepAlive(): Promise<boolean> {
    const token = this.sessionToken;
    const appKey = this.config.appKey;
    if (!token || !appKey) return false;
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(`${this.config.identityUrl}/keepAlive`, {
        method: "POST",
        headers: { "X-Application": appKey, "X-Authentication": token, Accept: "application/json" },
        signal: timeoutSignal(this.config.requestTimeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw transportError("Betfair keepAlive", error, this.config.requestTimeoutMs);
    }
    let body: { token?: string; product?: string; status?: string; error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new BetfairApiError(`Betfair keepAlive returned HTTP ${status}: ${text.slice(0, 200)}`, `HTTP_${status}`);
    }
    if (body.status === "SUCCESS") {
      if (body.token && this.sessionToken === token) this.sessionToken = body.token;
      return true;
    }
    // NO_SESSION / INPUT_VALIDATION_ERROR: the token is dead. INTERNAL_ERROR is Betfair's problem, not the session's.
    if (body.error !== "INTERNAL_ERROR" && this.sessionToken === token) this.sessionToken = undefined;
    return false;
  }

  /** Call keepAlive every BETFAIR_KEEPALIVE_MINUTES (0 disables) while a session exists. */
  startKeepAlive() {
    const minutes = this.config.keepAliveMinutes;
    if (!(minutes > 0) || this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => void this.keepAliveTick(), Math.min(minutes * 60_000, MAX_TIMER_MS));
    this.keepAliveTimer.unref?.();
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  private async keepAliveTick() {
    if (!this.sessionToken || this.keepAliveRunning) return;
    this.keepAliveRunning = true;
    try {
      if (!(await this.keepAlive())) console.error("[betfair] keepAlive: the session has expired; the next call logs in again.");
    } catch (error) {
      console.error(`[betfair] ${(error as Error).message}`);
    } finally {
      this.keepAliveRunning = false;
    }
  }

  // ---------------------------------------------------------------- JSON-RPC

  async call<T>(api: ApiName, method: string, params: object, timeoutMs = this.config.requestTimeoutMs): Promise<T> {
    if (!this.config.appKey) {
      throw new BetfairApiError(
        "Betfair is not configured. Set BETFAIR_APP_KEY plus BETFAIR_USERNAME/BETFAIR_PASSWORD (or BETFAIR_SESSION_TOKEN).",
        "NOT_CONFIGURED",
      );
    }
    const token = await this.session();
    try {
      return await this.rpc<T>(api, method, params, token, timeoutMs);
    } catch (error) {
      // A rejected session means the request was not processed, so one retry after logging in is safe.
      if (error instanceof BetfairApiError && SESSION_ERRORS.has(error.code) && this.canLogin()) {
        if (this.sessionToken === token) this.sessionToken = undefined;
        return this.rpc<T>(api, method, params, await this.session(), timeoutMs);
      }
      throw error;
    }
  }

  private async rpc<T>(api: ApiName, method: string, params: object, token: string, timeoutMs: number): Promise<T> {
    const prefix = api === "betting" ? "SportsAPING" : "AccountAPING";
    const request = JSON.stringify({ jsonrpc: "2.0", method: `${prefix}/v1.0/${method}`, params, id: ++this.requestId });
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(`${this.config.apiUrl}/${api}/json-rpc/v1`, {
        method: "POST",
        headers: {
          "X-Application": this.config.appKey!,
          "X-Authentication": token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: request,
        signal: timeoutSignal(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw transportError(`Betfair ${method}`, error, timeoutMs);
    }
    let body: { result?: T; error?: { code?: number; message?: string; data?: Record<string, unknown> } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new BetfairApiError(`Betfair ${method} returned HTTP ${status}: ${text.slice(0, 200)}`, `HTTP_${status}`);
    }
    if (body?.error) {
      // data.exceptionname names the exception object: APINGException (betting) or AccountAPINGException (accounts).
      const data = body.error.data ?? {};
      const exceptionName = typeof data.exceptionname === "string" ? data.exceptionname : undefined;
      const exception = (exceptionName ? data[exceptionName] : undefined) as { errorCode?: string; errorDetails?: string } | undefined;
      const code = exception?.errorCode ?? body.error.message ?? "UNKNOWN_ERROR";
      const details = exception?.errorDetails ? ` (${exception.errorDetails})` : "";
      throw new BetfairApiError(`Betfair ${method} failed: ${code}${details}`, code);
    }
    if (!body || typeof body !== "object" || !("result" in body)) {
      throw new BetfairApiError(`Betfair ${method} returned HTTP ${status} without a result: ${text.slice(0, 200)}`, "UNKNOWN_ERROR");
    }
    return body.result as T;
  }

  listEventTypes(filter: MarketFilter = {}) {
    return this.call<EventTypeResult[]>("betting", "listEventTypes", { filter });
  }

  listMarketCatalogue(args: Parameters<BetfairApi["listMarketCatalogue"]>[0]) {
    return this.call<MarketCatalogue[]>("betting", "listMarketCatalogue", args);
  }

  listMarketBook(args: Parameters<BetfairApi["listMarketBook"]>[0]) {
    return this.call<MarketBook[]>("betting", "listMarketBook", args);
  }

  /** Uses BETFAIR_PLACE_ORDERS_TIMEOUT_MS (0 = none): in-play bets wait for the market's bet delay before Betfair answers. */
  placeOrders(args: Parameters<BetfairApi["placeOrders"]>[0]) {
    return this.call<PlaceExecutionReport>("betting", "placeOrders", args, this.config.placeOrdersTimeoutMs ?? this.config.requestTimeoutMs);
  }

  cancelOrders(args: Parameters<BetfairApi["cancelOrders"]>[0]) {
    return this.call<CancelExecutionReport>("betting", "cancelOrders", args);
  }

  listCurrentOrders(args: Parameters<BetfairApi["listCurrentOrders"]>[0]) {
    return this.call<CurrentOrderSummaryReport>("betting", "listCurrentOrders", args);
  }

  listClearedOrders(args: Parameters<BetfairApi["listClearedOrders"]>[0]) {
    return this.call<ClearedOrderSummaryReport>("betting", "listClearedOrders", args);
  }

  getAccountFunds() {
    return this.call<AccountFunds>("account", "getAccountFunds", {});
  }

  getAccountDetails() {
    return this.call<AccountDetails>("account", "getAccountDetails", {});
  }
}

/** 0 disables the timeout. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return ms > 0 ? AbortSignal.timeout(Math.min(ms, MAX_TIMER_MS)) : undefined;
}

function isTimeout(error: unknown): boolean {
  const name = (error as Error | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function transportProblem(error: unknown, timeoutMs: number): string {
  return isTimeout(error) ? `timed out after ${timeoutMs} ms` : `network error (${describe(error)})`;
}

/** TIMEOUT / NETWORK_ERROR: the request may or may not have reached Betfair. */
function transportError(what: string, error: unknown, timeoutMs: number): BetfairApiError {
  return new BetfairApiError(`${what} failed: ${transportProblem(error, timeoutMs)}`, isTimeout(error) ? "TIMEOUT" : "NETWORK_ERROR");
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause as { code?: string; message?: string } | undefined;
  const detail = cause ? (cause.code ?? cause.message) : undefined;
  return detail ? `${error.message}: ${detail}` : error.message;
}
