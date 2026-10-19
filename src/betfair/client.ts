import fs from "node:fs";
import https from "node:https";
import type { Config } from "../config.js";
import type {
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
    fromRecord?: number;
    recordCount?: number;
  }): Promise<CurrentOrderSummaryReport>;
  listClearedOrders(args: {
    betStatus: "SETTLED" | "VOIDED" | "LAPSED" | "CANCELLED";
    marketIds?: string[];
    settledDateRange?: TimeRange;
    includeItemDescription?: boolean;
    fromRecord?: number;
    recordCount?: number;
  }): Promise<ClearedOrderSummaryReport>;
  getAccountFunds(): Promise<AccountFunds>;
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

const SESSION_ERRORS = new Set(["INVALID_SESSION_INFORMATION", "NO_SESSION", "INVALID_SESSION_TOKEN"]);

type Fetch = typeof globalThis.fetch;
type ApiName = "betting" | "account";

export class BetfairClient implements BetfairApi {
  private sessionToken?: string;
  private loginInFlight?: Promise<string>;
  private requestId = 0;

  constructor(
    private readonly config: Config["betfair"],
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.sessionToken = config.sessionToken;
  }

  private canLogin(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  private async session(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    return this.login();
  }

  /** Single-flight login so concurrent calls never trigger more than one login request. */
  async login(): Promise<string> {
    if (!this.loginInFlight) {
      this.loginInFlight = this.doLogin().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    return this.loginInFlight;
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
    const token = certFile && keyFile ? await this.certLogin(appKey, username, password) : await this.interactiveLogin(appKey, username, password);
    this.sessionToken = token;
    return token;
  }

  private async interactiveLogin(appKey: string, username: string, password: string): Promise<string> {
    const response = await this.fetchImpl(`${this.config.identityUrl}/login`, {
      method: "POST",
      headers: {
        "X-Application": appKey,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ username, password }).toString(),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const text = await response.text();
    let body: { token?: string; status?: string; error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new BetfairApiError(`Betfair login returned HTTP ${response.status}: ${text.slice(0, 200)}`, "LOGIN_FAILED");
    }
    if (body.status !== "SUCCESS" || !body.token) {
      throw new BetfairApiError(`Betfair login failed: ${body.error ?? body.status ?? "unknown error"}`, body.error ?? "LOGIN_FAILED");
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
          timeout: this.config.requestTimeoutMs,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const body = JSON.parse(data) as { sessionToken?: string; loginStatus?: string };
              if (body.loginStatus === "SUCCESS" && body.sessionToken) resolve(body.sessionToken);
              else reject(new BetfairApiError(`Betfair certificate login failed: ${body.loginStatus}`, body.loginStatus ?? "LOGIN_FAILED"));
            } catch {
              reject(new BetfairApiError(`Betfair certificate login returned HTTP ${res.statusCode}`, "LOGIN_FAILED"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("Betfair certificate login timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  }

  async call<T>(api: ApiName, method: string, params: object): Promise<T> {
    if (!this.config.appKey) {
      throw new BetfairApiError(
        "Betfair is not configured. Set BETFAIR_APP_KEY plus BETFAIR_USERNAME/BETFAIR_PASSWORD (or BETFAIR_SESSION_TOKEN).",
        "NOT_CONFIGURED",
      );
    }
    try {
      return await this.rpc<T>(api, method, params, await this.session());
    } catch (error) {
      if (error instanceof BetfairApiError && SESSION_ERRORS.has(error.code) && this.canLogin()) {
        this.sessionToken = undefined;
        return this.rpc<T>(api, method, params, await this.login());
      }
      throw error;
    }
  }

  private async rpc<T>(api: ApiName, method: string, params: object, token: string): Promise<T> {
    const prefix = api === "betting" ? "SportsAPING" : "AccountAPING";
    const response = await this.fetchImpl(`${this.config.apiUrl}/${api}/json-rpc/v1`, {
      method: "POST",
      headers: {
        "X-Application": this.config.appKey!,
        "X-Authentication": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: `${prefix}/v1.0/${method}`, params, id: ++this.requestId }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const text = await response.text();
    let body: { result?: T; error?: { code?: number; message?: string; data?: Record<string, unknown> } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new BetfairApiError(`Betfair ${method} returned HTTP ${response.status}: ${text.slice(0, 200)}`, `HTTP_${response.status}`);
    }
    if (body.error) {
      const data = body.error.data ?? {};
      const exceptionName = typeof data.exceptionname === "string" ? data.exceptionname : undefined;
      const exception = (exceptionName ? data[exceptionName] : undefined) as { errorCode?: string; errorDetails?: string } | undefined;
      const code = exception?.errorCode ?? body.error.message ?? "UNKNOWN_ERROR";
      const details = exception?.errorDetails ? ` (${exception.errorDetails})` : "";
      throw new BetfairApiError(`Betfair ${method} failed: ${code}${details}`, code);
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

  placeOrders(args: Parameters<BetfairApi["placeOrders"]>[0]) {
    return this.call<PlaceExecutionReport>("betting", "placeOrders", args);
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
}
