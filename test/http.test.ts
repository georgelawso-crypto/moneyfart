import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { SESSION_IDLE_MS, checkHttpSecurity, createHttpServer, hostname, maxSessionsFromEnv } from "../src/http.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TOKEN = "s3cret-token";

/** Raw request with full control over headers (fetch() cannot set Host). */
function raw(base: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const method = options.method ?? "POST";
    const req = http.request(`${base}${path}`, { method, agent: false, headers: { "Content-Type": "application/json", ...options.headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? (options.body ?? "{}") : undefined);
  });
}

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

async function start(env: Record<string, string>, options: Parameters<typeof createHttpServer>[1] = {}) {
  const connector = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...env }), new FakeBetfair());
  const server = createHttpServer(connector, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), connector };
}

describe("HTTP transport with a token", () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  before(async () => {
    ctx = await start({ MCP_AUTH_TOKEN: TOKEN, MCP_ALLOWED_ORIGINS: "https://allowed.example" });
  });
  after(() => ctx.close());

  test("health is public and reveals nothing", async () => {
    const res = await raw(ctx.base, "/health", { method: "GET" });
    assert.deepEqual(JSON.parse(res.body), { status: "ok" });
  });

  test("rejects missing or wrong tokens", async () => {
    assert.equal((await raw(ctx.base, "/mcp", { body: initBody })).status, 401);
    assert.equal((await raw(ctx.base, "/mcp/wrong", { body: initBody })).status, 401);
    assert.equal((await raw(ctx.base, "/mcp", { body: initBody, headers: { Authorization: "Bearer wrong" } })).status, 401);
  });

  test("malformed URLs never crash the server", async () => {
    assert.equal((await raw(ctx.base, "/mcp/%ZZ", { body: initBody })).status, 401);
    for (const path of ["//", "///x", "/mcp/%E0%A4%A"]) {
      assert.ok([400, 401, 404].includes((await raw(ctx.base, path, { method: "GET" })).status), path);
    }
    assert.equal((await raw(ctx.base, "/health", { method: "GET" })).status, 200, "still alive");
  });

  test("refuses browser origins that are not allowlisted, without wildcard CORS", async () => {
    const evil = await raw(ctx.base, `/mcp/${TOKEN}`, { body: initBody, headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    const preflight = await raw(ctx.base, `/mcp/${TOKEN}`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(preflight.status, 403);
    const ok = await raw(ctx.base, `/mcp/${TOKEN}`, { method: "OPTIONS", headers: { Origin: "https://allowed.example" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], "https://allowed.example");
    const noOrigin = await raw(ctx.base, "/health", { method: "GET" });
    assert.equal(noOrigin.headers["access-control-allow-origin"], undefined);
  });

  test("rejects foreign Host headers on a loopback bind (DNS rebinding)", async () => {
    assert.equal((await raw(ctx.base, `/mcp/${TOKEN}`, { body: initBody, headers: { Host: "evil.example" } })).status, 403);
    assert.equal((await raw(ctx.base, "/health", { method: "GET", headers: { Host: "[::1]:3000" } })).status, 200);
  });

  test("requires initialize before other requests and rejects unknown sessions", async () => {
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal((await raw(ctx.base, `/mcp/${TOKEN}`, { body: list })).status, 400);
    assert.equal((await raw(ctx.base, `/mcp/${TOKEN}`, { body: list, headers: { "mcp-session-id": "nope" } })).status, 404);
  });

  test("works with the token in the path or as a bearer header; sessions keep their own active market", async () => {
    const clients: Client[] = [];
    for (const [url, headers] of [
      [`${ctx.base}/mcp/${TOKEN}`, {}],
      [`${ctx.base}/mcp`, { Authorization: `Bearer ${TOKEN}` }],
    ] as const) {
      const client = new Client({ name: "http-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
      clients.push(client);
    }
    const [a, b] = clients;
    const { tools } = await a.listTools();
    assert.ok(tools.some((t) => t.name === "get_active_market"));
    await a.callTool({ name: "open_market", arguments: { marketId: WIN_MARKET } });
    const fromA = (await a.callTool({ name: "get_active_market", arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean };
    assert.match(fromA.content[0].text, /^activeBetfairMarket:/);
    const fromB = (await b.callTool({ name: "get_active_market", arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(fromB.isError, true, "session B has no active market of its own");
    for (const c of clients) await c.close();
  });
});

describe("HTTP transport without a token", () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  before(async () => {
    ctx = await start({ MCP_ALLOW_UNAUTHENTICATED_LOOPBACK: "1" });
  });
  after(() => ctx.close());

  test("rejects requests relayed by a reverse proxy", async () => {
    assert.equal((await raw(ctx.base, "/mcp", { body: initBody, headers: { "X-Forwarded-For": "203.0.113.9" } })).status, 403);
    assert.equal((await raw(ctx.base, "/mcp", { body: initBody, headers: { Forwarded: "for=203.0.113.9" } })).status, 403);
  });

  test("serves direct loopback requests", async () => {
    const res = await raw(ctx.base, "/mcp", { body: initBody, headers: { Accept: "application/json, text/event-stream" } });
    assert.equal(res.status, 200);
  });
});

describe("HTTP session limits", () => {
  test("a session beyond the limit closes the least recently used one", async () => {
    const ctx = await start({ MCP_AUTH_TOKEN: TOKEN }, { maxSessions: 2 });
    try {
      const headers = { Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` };
      const list = (id: string) => raw(ctx.base, "/mcp", { headers: { ...headers, "mcp-session-id": id }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
      const init = async () => {
        const res = await raw(ctx.base, "/mcp", { headers, body: initBody });
        assert.equal(res.status, 200);
        return String(res.headers["mcp-session-id"]);
      };
      const a = await init();
      const b = await init();
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await list(a)).status, 200, "a is used again, so b is now the least recently used");
      const c = await init();
      assert.equal((await list(b)).status, 404, "b was closed to make room");
      assert.equal((await list(a)).status, 200);
      assert.equal((await list(c)).status, 200);
    } finally {
      ctx.close();
    }
  });

  test("idle sessions expire after 30 minutes; MCP_MAX_SESSIONS sets the limit", () => {
    assert.equal(SESSION_IDLE_MS, 30 * 60_000);
    assert.equal(maxSessionsFromEnv({}), 100);
    assert.equal(maxSessionsFromEnv({ MCP_MAX_SESSIONS: "7" }), 7);
    assert.throws(() => maxSessionsFromEnv({ MCP_MAX_SESSIONS: "0" }), /MCP_MAX_SESSIONS/);
    assert.throws(() => maxSessionsFromEnv({ MCP_MAX_SESSIONS: "lots" }), /MCP_MAX_SESSIONS/);
  });
});

test("startup security rules", () => {
  assert.throws(() => checkHttpSecurity(loadConfig({})), /MCP_AUTH_TOKEN is required/);
  assert.doesNotThrow(() => checkHttpSecurity(loadConfig({ MCP_AUTH_TOKEN: "x", HOST: "0.0.0.0" })));
  assert.doesNotThrow(() => checkHttpSecurity(loadConfig({ MCP_ALLOW_UNAUTHENTICATED_LOOPBACK: "1" })));
  assert.throws(() => checkHttpSecurity(loadConfig({ MCP_ALLOW_UNAUTHENTICATED_LOOPBACK: "1", HOST: "0.0.0.0" })), /loopback/);
  assert.throws(() => checkHttpSecurity(loadConfig({ MCP_ALLOW_UNAUTHENTICATED_LOOPBACK: "1", TRADING_MODE: "live" })), /live/);
});

test("hostname parsing handles IPv6 literals", () => {
  assert.equal(hostname("[::1]:3000"), "::1");
  assert.equal(hostname("localhost:3000"), "localhost");
  assert.equal(hostname("127.0.0.1"), "127.0.0.1");
});
