import assert from "node:assert/strict";
import { test } from "node:test";
import { BetfairApiError, BetfairClient, outcomeUnknown } from "../src/betfair/client.js";
import { loadConfig } from "../src/config.js";

type Handler = (url: string, init: RequestInit) => unknown;

function fakeFetch(handler: Handler) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const result = await handler(url, init);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const betfairConfig = (env: Record<string, string>) => loadConfig({ BETFAIR_JURISDICTION: "com", BETFAIR_APP_KEY: "app-key", ...env }).betfair;
const CREDENTIALS = { BETFAIR_USERNAME: "u", BETFAIR_PASSWORD: "p" };

const rpcResult = (result: unknown) => ({ jsonrpc: "2.0", result, id: 1 });
const FUNDS = { availableToBetBalance: 12.5, exposure: 0, retainedCommission: 0, exposureLimit: 0 };
const apingError = (errorCode: string, exceptionname = "APINGException") => ({
  jsonrpc: "2.0",
  error: { code: -32099, message: "ANGX-0003", data: { exceptionname, [exceptionname]: { errorCode, errorDetails: "details" } } },
  id: 1,
});

/** Resolves after `ms` unless the request's AbortSignal fires first (like a real slow server). */
function slow<T>(ms: number, init: RequestInit, value: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    init.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(init.signal!.reason);
    });
  });
}

/** A clock the test moves by hand. */
function clock(start = Date.parse("2026-10-19T12:00:00.000Z")) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms), at: (offsetMs: number) => new Date(start + offsetMs).toISOString() };
}

const logins = (requests: Array<{ url: string }>) => requests.filter((r) => r.url.endsWith("/login")).length;

test("logs in, then sends JSON-RPC with app key and session token", async () => {
  const { fetchImpl, requests } = fakeFetch((url) =>
    url.endsWith("/login") ? { token: "tok-1", status: "SUCCESS" } : { jsonrpc: "2.0", result: [{ eventType: { id: "7", name: "Horse Racing" }, marketCount: 3 }], id: 1 },
  );
  const client = new BetfairClient(betfairConfig(CREDENTIALS), fetchImpl);
  const result = await client.listEventTypes();
  assert.equal(result[0].eventType.name, "Horse Racing");
  assert.equal(requests[0].url, "https://identitysso.betfair.com/api/login");
  assert.equal(String(requests[0].init.body), "username=u&password=p");
  const rpc = requests[1];
  assert.equal(rpc.url, "https://api.betfair.com/exchange/betting/json-rpc/v1");
  const headers = rpc.init.headers as Record<string, string>;
  assert.equal(headers["X-Application"], "app-key");
  assert.equal(headers["X-Authentication"], "tok-1");
  assert.equal(JSON.parse(String(rpc.init.body)).method, "SportsAPING/v1.0/listEventTypes");
  assert.deepEqual(client.loginStatus(), { configured: true, loggedIn: true, lastError: undefined, lastErrorCode: undefined, retryAt: undefined, latched: false });
});

test("re-logs in once when the session expires", async () => {
  let logins = 0;
  let calls = 0;
  const { fetchImpl } = fakeFetch((url) => {
    if (url.endsWith("/login")) return { token: `tok-${++logins}`, status: "SUCCESS" };
    calls++;
    if (calls === 1) {
      return { jsonrpc: "2.0", error: { code: -32099, message: "ANGX-0003", data: { exceptionname: "APINGException", APINGException: { errorCode: "INVALID_SESSION_INFORMATION" } } }, id: 1 };
    }
    return { jsonrpc: "2.0", result: { availableToBetBalance: 12.5, exposure: 0, retainedCommission: 0, exposureLimit: 0 }, id: 2 };
  });
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "stale", ...CREDENTIALS }), fetchImpl);
  const funds = await client.getAccountFunds();
  assert.equal(funds.availableToBetBalance, 12.5);
  assert.equal(logins, 1);
});

test("a session error is retried only once", async () => {
  const { fetchImpl, requests } = fakeFetch((url) => (url.endsWith("/login") ? { token: "tok", status: "SUCCESS" } : apingError("NO_SESSION")));
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "stale", ...CREDENTIALS }), fetchImpl);
  await assert.rejects(client.getAccountFunds(), (error: BetfairApiError) => error.code === "NO_SESSION");
  assert.equal(requests.length, 3); // rpc, login, rpc
});

test("concurrent calls share a single login", async () => {
  const { fetchImpl, requests } = fakeFetch(async (url, init) => (url.endsWith("/login") ? slow(20, init, { token: "tok", status: "SUCCESS" }) : rpcResult(FUNDS)));
  const client = new BetfairClient(betfairConfig(CREDENTIALS), fetchImpl);
  await Promise.all([client.getAccountFunds(), client.getAccountFunds(), client.listEventTypes()]);
  assert.equal(logins(requests), 1);
});

test("surfaces Betfair error codes", async () => {
  const { fetchImpl } = fakeFetch((url) =>
    url.endsWith("/login")
      ? { token: "t", status: "SUCCESS" }
      : { jsonrpc: "2.0", error: { code: -32099, message: "ANGX-0006", data: { exceptionname: "APINGException", APINGException: { errorCode: "TOO_MUCH_DATA", errorDetails: "weight" } } }, id: 1 },
  );
  const client = new BetfairClient(betfairConfig(CREDENTIALS), fetchImpl);
  await assert.rejects(client.listMarketBook({ marketIds: ["1.1"] }), (error: BetfairApiError) => error.code === "TOO_MUCH_DATA" && /weight/.test(error.message));
});

test("parses AccountAPINGException errors from the accounts API", async () => {
  const { fetchImpl, requests } = fakeFetch(() => apingError("SUBSCRIPTION_EXPIRED", "AccountAPINGException"));
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok" }), fetchImpl);
  await assert.rejects(client.getAccountFunds(), (error: BetfairApiError) => error.code === "SUBSCRIPTION_EXPIRED" && /details/.test(error.message));
  assert.equal(requests[0].url, "https://api.betfair.com/exchange/account/json-rpc/v1");
  assert.equal(JSON.parse(String(requests[0].init.body)).method, "AccountAPING/v1.0/getAccountFunds");
});

test("a JSON-RPC answer without a result is an unknown error, not undefined", async () => {
  const { fetchImpl } = fakeFetch(() => ({ jsonrpc: "2.0", id: 1 }));
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok" }), fetchImpl);
  await assert.rejects(client.getAccountFunds(), (error: BetfairApiError) => error.code === "UNKNOWN_ERROR");
});

test("reports failed logins and missing configuration", async () => {
  const { fetchImpl } = fakeFetch(() => ({ token: "", status: "FAIL", error: "INVALID_USERNAME_OR_PASSWORD" }));
  const client = new BetfairClient(betfairConfig({ BETFAIR_USERNAME: "u", BETFAIR_PASSWORD: "bad" }), fetchImpl);
  await assert.rejects(client.getAccountFunds(), /INVALID_USERNAME_OR_PASSWORD/);

  const unconfigured = new BetfairClient(loadConfig({}).betfair, fetchImpl);
  await assert.rejects(unconfigured.getAccountFunds(), /not configured/);
  assert.deepEqual(unconfigured.loginStatus(), { configured: false, loggedIn: false, lastError: undefined, lastErrorCode: undefined, retryAt: undefined, latched: false });

  const tokenOnly = new BetfairClient(betfairConfig({}), fetchImpl);
  await assert.rejects(tokenOnly.getAccountFunds(), (error: BetfairApiError) => error.code === "NOT_CONFIGURED");
  assert.equal(tokenOnly.loginStatus().latched, false);
});

test("a terminal login error stops all further logins until the latch is reset", async () => {
  const time = clock();
  let password = "bad";
  const { fetchImpl, requests } = fakeFetch((url) =>
    url.endsWith("/login") ? (password === "bad" ? { token: "", status: "FAIL", error: "INVALID_USERNAME_OR_PASSWORD" } : { token: "tok", status: "SUCCESS" }) : rpcResult(FUNDS),
  );
  const client = new BetfairClient(betfairConfig(CREDENTIALS), fetchImpl, { now: time.now });
  await assert.rejects(client.getAccountFunds(), (error: BetfairApiError) => error.code === "INVALID_USERNAME_OR_PASSWORD" && /stopped/.test(error.message));
  for (let i = 0; i < 5; i++) {
    time.advance(86400_000); // waiting does not help
    await assert.rejects(client.listMarketBook({ marketIds: ["1.1"] }), (error: BetfairApiError) => error.code === "INVALID_USERNAME_OR_PASSWORD" && /RetryBetfairLogin/.test(error.message));
  }
  await assert.rejects(client.login(), /INVALID_USERNAME_OR_PASSWORD/);
  assert.equal(logins(requests), 1);
  assert.equal(requests.length, 1);
  const status = client.loginStatus();
  assert.equal(status.latched, true);
  assert.equal(status.loggedIn, false);
  assert.equal(status.retryAt, undefined);
  assert.equal(status.lastErrorCode, "INVALID_USERNAME_OR_PASSWORD");
  assert.match(status.lastError!, /INVALID_USERNAME_OR_PASSWORD/);

  password = "fixed";
  client.resetLoginLatch();
  assert.equal(client.loginStatus().latched, false);
  assert.equal((await client.getAccountFunds()).availableToBetBalance, 12.5);
  assert.equal(logins(requests), 2);
  assert.deepEqual(client.loginStatus(), { configured: true, loggedIn: true, lastError: undefined, lastErrorCode: undefined, retryAt: undefined, latched: false });
});

test("every terminal login status latches", async () => {
  for (const code of ["ACCOUNT_NOW_LOCKED", "ACCOUNT_ALREADY_LOCKED", "CERT_AUTH_REQUIRED", "SECURITY_QUESTION_WRONG_3X", "NOT_AUTHORIZED_BY_REGULATOR_IT", "ACTIONS_REQUIRED", "INPUT_VALIDATION_ERROR"]) {
    const { fetchImpl, requests } = fakeFetch(() => ({ token: "", status: "FAIL", error: code }));
    const client = new BetfairClient(betfairConfig(CREDENTIALS), fetchImpl);
    await assert.rejects(client.getAccountFunds(), new RegExp(code));
    await assert.rejects(client.getAccountFunds(), new RegExp(code));
    assert.equal(requests.length, 1, code);
    assert.equal(client.loginStatus().latched, true, code);
  }
});

test("TEMPORARY_BAN_TOO_MANY_REQUESTS blocks logins for 20 minutes", async () => {
  const time = clock();
  const { fetchImpl, requests } = fakeFetch(() => ({ token: "", status: "FAIL", error: "TEMPORARY_BAN_TOO_MANY_REQUESTS" }));
  const client = new BetfairClient(betfairConfig(CREDENTIALS), fetchImpl, { now: time.now });
  await assert.rejects(client.getAccountFunds(), /TEMPORARY_BAN_TOO_MANY_REQUESTS/);
  assert.equal(client.loginStatus().retryAt, time.at(20 * 60_000));
  assert.equal(client.loginStatus().latched, false);
  time.advance(20 * 60_000 - 1);
  await assert.rejects(client.getAccountFunds(), (error: BetfairApiError) => error.code === "TEMPORARY_BAN_TOO_MANY_REQUESTS" && /Next login attempt after/.test(error.message));
  assert.equal(logins(requests), 1);
  time.advance(1);
  await assert.rejects(client.getAccountFunds(), /TEMPORARY_BAN_TOO_MANY_REQUESTS/);
  assert.equal(logins(requests), 2);
  // A second ban is again 20 minutes, not an exponential back-off.
  assert.equal(client.loginStatus().retryAt, time.at(40 * 60_000));
});

test("network failures back off exponentially from 30 s to 15 minutes", async () => {
  const time = clock();
  let down = true;
  const { fetchImpl, requests } = fakeFetch((url) => {
    if (url.endsWith("/login")) {
      if (down) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      return { token: "tok", status: "SUCCESS" };
    }
    return rpcResult(FUNDS);
  });
  const client = new BetfairClient(betfairConfig(CREDENTIALS), fetchImpl, { now: time.now });
  let elapsed = 0;
  for (const delay of [30, 60, 120, 240, 480, 900, 900].map((s) => s * 1000)) {
    const attempts = logins(requests);
    // Never TIMEOUT/NETWORK_ERROR: a failed login means nothing was sent, which callers must be able to tell.
    await assert.rejects(client.getAccountFunds(), (error: BetfairApiError) => error.code === "LOGIN_FAILED" && /ECONNREFUSED/.test(error.message));
    assert.equal(logins(requests), attempts + 1);
    assert.equal(client.loginStatus().retryAt, time.at(elapsed + delay));
    time.advance(delay - 1);
    await assert.rejects(client.getAccountFunds(), (error: BetfairApiError) => /Next login attempt after/.test(error.message));
    assert.equal(logins(requests), attempts + 1);
    time.advance(1);
    elapsed += delay;
  }
  down = false;
  assert.equal((await client.getAccountFunds()).availableToBetBalance, 12.5);
  assert.equal(client.loginStatus().retryAt, undefined);
  assert.equal(client.loginStatus().lastError, undefined);
});

test("unreadable login responses back off, and a successful login resets the back-off", async () => {
  const time = clock();
  let mode: "html" | "ok" | "expired" = "html";
  const { fetchImpl, requests } = fakeFetch((url) => {
    if (url.endsWith("/login")) {
      if (mode === "html") return new Response("<html>503 Service Unavailable</html>", { status: 503 });
      if (mode === "expired") throw new TypeError("fetch failed");
      return { token: "tok", status: "SUCCESS" };
    }
    return mode === "expired" ? apingError("INVALID_SESSION_INFORMATION") : rpcResult(FUNDS);
  });
  const client = new BetfairClient(betfairConfig(CREDENTIALS), fetchImpl, { now: time.now });
  await assert.rejects(client.getAccountFunds(), (error: BetfairApiError) => error.code === "LOGIN_FAILED" && /HTTP 503/.test(error.message));
  time.advance(30_000);
  await assert.rejects(client.getAccountFunds(), /HTTP 503/);
  assert.equal(client.loginStatus().retryAt, time.at(30_000 + 60_000));
  time.advance(60_000);
  mode = "ok";
  await client.getAccountFunds();
  // The session later expires and the relogin fails: the back-off starts again at 30 s.
  mode = "expired";
  await assert.rejects(client.getAccountFunds(), /LOGIN_FAILED|fetch failed/);
  assert.equal(client.loginStatus().retryAt, time.at(90_000 + 30_000));
  assert.equal(logins(requests), 4);
});

test("keepAlive extends the session, and drops it when Betfair says it is gone", async () => {
  let answer: Record<string, string> = { token: "tok-1", product: "app-key", status: "SUCCESS", error: "" };
  const { fetchImpl, requests } = fakeFetch((url) => {
    if (url.endsWith("/keepAlive")) return answer;
    if (url.endsWith("/login")) return { token: "tok-2", status: "SUCCESS" };
    return rpcResult(FUNDS);
  });
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok-1", ...CREDENTIALS }), fetchImpl);
  assert.equal(await client.keepAlive(), true);
  const [keepAlive] = requests;
  assert.equal(keepAlive.url, "https://identitysso.betfair.com/api/keepAlive");
  assert.equal(keepAlive.init.method, "POST");
  assert.deepEqual(keepAlive.init.headers, { "X-Application": "app-key", "X-Authentication": "tok-1", Accept: "application/json" });
  assert.equal(client.loginStatus().loggedIn, true);

  // Betfair's own hiccup keeps the session.
  answer = { token: "", product: "app-key", status: "FAIL", error: "INTERNAL_ERROR" };
  assert.equal(await client.keepAlive(), false);
  assert.equal(client.loginStatus().loggedIn, true);

  answer = { token: "", product: "app-key", status: "FAIL", error: "NO_SESSION" };
  assert.equal(await client.keepAlive(), false);
  assert.equal(client.loginStatus().loggedIn, false);
  // The next call logs in again and uses the new token.
  await client.getAccountFunds();
  assert.equal(logins(requests), 1);
  assert.equal((requests.at(-1)!.init.headers as Record<string, string>)["X-Authentication"], "tok-2");

  // No session: nothing to keep alive, no request.
  const idle = fakeFetch(() => answer);
  assert.equal(await new BetfairClient(betfairConfig(CREDENTIALS), idle.fetchImpl).keepAlive(), false);
  assert.equal(idle.requests.length, 0);
});

test("keepAlive adopts a refreshed token and maps transport failures", async () => {
  const { fetchImpl, requests } = fakeFetch((url) => (url.endsWith("/keepAlive") ? { token: "tok-new", product: "app-key", status: "SUCCESS", error: "" } : rpcResult(FUNDS)));
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok-old" }), fetchImpl);
  await client.keepAlive();
  await client.getAccountFunds();
  assert.equal((requests[1].init.headers as Record<string, string>)["X-Authentication"], "tok-new");

  const broken = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const offline = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok" }), broken.fetchImpl);
  await assert.rejects(offline.keepAlive(), (error: BetfairApiError) => error.code === "NETWORK_ERROR");
  assert.equal(offline.loginStatus().loggedIn, true); // a network problem does not end the session
});

test("startKeepAlive calls keepAlive on its interval while a session exists", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const { fetchImpl, requests } = fakeFetch(() => ({ token: "tok", product: "app-key", status: "SUCCESS", error: "" }));

  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok", BETFAIR_KEEPALIVE_MINUTES: "10" }), fetchImpl);
  client.startKeepAlive();
  client.startKeepAlive(); // idempotent
  t.mock.timers.tick(10 * 60_000 - 1);
  await settle();
  assert.equal(requests.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith("/keepAlive"));
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(requests.length, 2);
  client.stopKeepAlive();
  t.mock.timers.tick(60 * 60_000);
  await settle();
  assert.equal(requests.length, 2);

  // No session yet: the timer runs but never logs in just to keep alive.
  const noSession = fakeFetch(() => ({ token: "tok", status: "SUCCESS" }));
  const fresh = new BetfairClient(betfairConfig({ ...CREDENTIALS, BETFAIR_KEEPALIVE_MINUTES: "10" }), noSession.fetchImpl);
  fresh.startKeepAlive();
  t.mock.timers.tick(30 * 60_000);
  await settle();
  assert.equal(noSession.requests.length, 0);
  fresh.stopKeepAlive();

  // 0 disables keepAlive.
  const disabled = fakeFetch(() => ({ status: "SUCCESS" }));
  const off = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok", BETFAIR_KEEPALIVE_MINUTES: "0" }), disabled.fetchImpl);
  off.startKeepAlive();
  t.mock.timers.tick(24 * 60 * 60_000);
  await settle();
  assert.equal(disabled.requests.length, 0);
});

test("maps timeouts to TIMEOUT and network failures to NETWORK_ERROR", async () => {
  const hanging = fakeFetch((_url, init) => slow(10_000, init, rpcResult([])));
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok", BETFAIR_REQUEST_TIMEOUT_MS: "20" }), hanging.fetchImpl);
  await assert.rejects(client.listMarketBook({ marketIds: ["1.1"] }), (error: BetfairApiError) => error.code === "TIMEOUT" && /timed out after 20 ms/.test(error.message));

  const refused = fakeFetch(() => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  });
  const offline = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok" }), refused.fetchImpl);
  await assert.rejects(offline.placeOrders({ marketId: "1.1", instructions: [] }), (error: BetfairApiError) => error.code === "NETWORK_ERROR" && /ECONNRESET/.test(error.message));

  // The connection drops while the body is being read.
  const truncated = (async () => ({ status: 200, text: () => Promise.reject(new TypeError("terminated")) })) as unknown as typeof fetch;
  const dropped = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok" }), truncated);
  await assert.rejects(dropped.placeOrders({ marketId: "1.1", instructions: [] }), (error: BetfairApiError) => error.code === "NETWORK_ERROR");

  // A login that times out is a login failure (nothing was sent), not an unknown outcome.
  const slowLogin = fakeFetch((_url, init) => slow(10_000, init, { token: "tok", status: "SUCCESS" }));
  const loggingIn = new BetfairClient(betfairConfig({ ...CREDENTIALS, BETFAIR_REQUEST_TIMEOUT_MS: "20" }), slowLogin.fetchImpl);
  await assert.rejects(loggingIn.placeOrders({ marketId: "1.1", instructions: [] }), (error: BetfairApiError) => error.code === "LOGIN_FAILED" && /timed out/.test(error.message));
});

test("placeOrders has its own, longer timeout", async () => {
  const { fetchImpl } = fakeFetch((_url, init) => slow(150, init, rpcResult({ status: "SUCCESS", marketId: "1.1", instructionReports: [] })));
  const client = new BetfairClient(
    betfairConfig({ BETFAIR_SESSION_TOKEN: "tok", BETFAIR_REQUEST_TIMEOUT_MS: "40", BETFAIR_PLACE_ORDERS_TIMEOUT_MS: "2000" }),
    fetchImpl,
  );
  await assert.rejects(client.listCurrentOrders({}), (error: BetfairApiError) => error.code === "TIMEOUT");
  await assert.rejects(client.cancelOrders({ marketId: "1.1", instructions: [{ betId: "1" }] }), (error: BetfairApiError) => error.code === "TIMEOUT");
  const report = await client.placeOrders({ marketId: "1.1", instructions: [] });
  assert.equal(report.status, "SUCCESS");

  const short = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok", BETFAIR_PLACE_ORDERS_TIMEOUT_MS: "40" }), fetchImpl);
  await assert.rejects(short.placeOrders({ marketId: "1.1", instructions: [] }), (error: BetfairApiError) => error.code === "TIMEOUT" && /40 ms/.test(error.message));
});

test("a placeOrders timeout of 0 means no timeout, like every other timeout setting", async () => {
  const { fetchImpl } = fakeFetch((_url, init) => slow(100, init, rpcResult({ status: "SUCCESS", marketId: "1.1", instructionReports: [] })));
  const client = new BetfairClient(
    betfairConfig({ BETFAIR_SESSION_TOKEN: "tok", BETFAIR_REQUEST_TIMEOUT_MS: "20", BETFAIR_PLACE_ORDERS_TIMEOUT_MS: "0" }),
    fetchImpl,
  );
  const report = await client.placeOrders({ marketId: "1.1", instructions: [] });
  assert.equal(report.status, "SUCCESS");
});

test("outcomeUnknown separates 'may have happened' from 'rejected'", () => {
  for (const code of ["TIMEOUT", "NETWORK_ERROR", "HTTP_503", "HTTP_200", "TIMEOUT_ERROR", "UNEXPECTED_ERROR", "UNKNOWN_ERROR"]) {
    assert.equal(outcomeUnknown(new BetfairApiError("x", code)), true, code);
  }
  for (const code of ["INVALID_INPUT_DATA", "TOO_MANY_REQUESTS", "INVALID_SESSION_INFORMATION", "NOT_CONFIGURED", "LOGIN_FAILED", "INVALID_USERNAME_OR_PASSWORD", "HTTP_403"]) {
    assert.equal(outcomeUnknown(new BetfairApiError("x", code)), false, code);
  }
  assert.equal(outcomeUnknown(new Error("socket hang up")), true);
});

test("a non-JSON HTTP error keeps its status as the code", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "tok" }), fetchImpl);
  await assert.rejects(client.listMarketBook({ marketIds: ["1.1"] }), (error: BetfairApiError) => error.code === "HTTP_502");
});

