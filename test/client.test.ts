import assert from "node:assert/strict";
import { test } from "node:test";
import { BetfairApiError, BetfairClient } from "../src/betfair/client.js";
import { loadConfig } from "../src/config.js";

type Handler = (url: string, init: RequestInit) => unknown;

function fakeFetch(handler: Handler) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    return new Response(JSON.stringify(handler(url, init)), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const betfairConfig = (env: Record<string, string>) => loadConfig({ BETFAIR_APP_KEY: "app-key", ...env }).betfair;

test("logs in, then sends JSON-RPC with app key and session token", async () => {
  const { fetchImpl, requests } = fakeFetch((url) =>
    url.endsWith("/login") ? { token: "tok-1", status: "SUCCESS" } : { jsonrpc: "2.0", result: [{ eventType: { id: "7", name: "Horse Racing" }, marketCount: 3 }], id: 1 },
  );
  const client = new BetfairClient(betfairConfig({ BETFAIR_USERNAME: "u", BETFAIR_PASSWORD: "p" }), fetchImpl);
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
  const client = new BetfairClient(betfairConfig({ BETFAIR_SESSION_TOKEN: "stale", BETFAIR_USERNAME: "u", BETFAIR_PASSWORD: "p" }), fetchImpl);
  const funds = await client.getAccountFunds();
  assert.equal(funds.availableToBetBalance, 12.5);
  assert.equal(logins, 1);
});

test("surfaces Betfair error codes", async () => {
  const { fetchImpl } = fakeFetch((url) =>
    url.endsWith("/login")
      ? { token: "t", status: "SUCCESS" }
      : { jsonrpc: "2.0", error: { code: -32099, message: "ANGX-0006", data: { exceptionname: "APINGException", APINGException: { errorCode: "TOO_MUCH_DATA", errorDetails: "weight" } } }, id: 1 },
  );
  const client = new BetfairClient(betfairConfig({ BETFAIR_USERNAME: "u", BETFAIR_PASSWORD: "p" }), fetchImpl);
  await assert.rejects(client.listMarketBook({ marketIds: ["1.1"] }), (error: BetfairApiError) => error.code === "TOO_MUCH_DATA" && /weight/.test(error.message));
});

test("reports failed logins and missing configuration", async () => {
  const { fetchImpl } = fakeFetch(() => ({ token: "", status: "FAIL", error: "INVALID_USERNAME_OR_PASSWORD" }));
  const client = new BetfairClient(betfairConfig({ BETFAIR_USERNAME: "u", BETFAIR_PASSWORD: "bad" }), fetchImpl);
  await assert.rejects(client.getAccountFunds(), /INVALID_USERNAME_OR_PASSWORD/);

  const unconfigured = new BetfairClient(loadConfig({}).betfair, fetchImpl);
  await assert.rejects(unconfigured.getAccountFunds(), /not configured/);
});
