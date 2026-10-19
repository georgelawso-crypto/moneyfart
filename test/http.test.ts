import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { createHttpServer } from "../src/http.js";
import { FakeBetfair } from "./fakeBetfair.js";

const TOKEN = "s3cret-token";

describe("HTTP transport", () => {
  let base: string;
  let close: () => void;

  before(async () => {
    const connector = new Connector(loadConfig({ RECORD_INTERVAL_SECONDS: "0", MCP_AUTH_TOKEN: TOKEN, PORT: "0" }), new FakeBetfair());
    const server = createHttpServer(connector);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());

  const initialize = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });

  test("health check is public", async () => {
    const res = await fetch(`${base}/health`);
    assert.deepEqual(await res.json(), { status: "ok", mode: "paper" });
  });

  test("rejects requests without the token", async () => {
    assert.equal((await initialize(`${base}/mcp`)).status, 401);
    assert.equal((await initialize(`${base}/mcp/wrong`)).status, 401);
    assert.equal((await initialize(`${base}/mcp`, { Authorization: "Bearer wrong" })).status, 401);
  });

  test("rejects non-loopback Host headers when bound to localhost", async () => {
    // fetch() cannot override Host, so use node:http directly (DNS-rebinding scenario).
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/mcp/${TOKEN}`, { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403);
  });

  test("only POST is supported", async () => {
    assert.equal((await fetch(`${base}/mcp/${TOKEN}`)).status, 405);
  });

  test("works with the token in the URL path or as a bearer header", async () => {
    for (const [url, headers] of [
      [`${base}/mcp/${TOKEN}`, {}],
      [`${base}/mcp`, { Authorization: `Bearer ${TOKEN}` }],
    ] as const) {
      const client = new Client({ name: "http-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "GetActiveMarket"));
      const result = (await client.callTool({ name: "FindMarkets", arguments: { sport: "Horse Racing" } })) as { content: Array<{ text: string }> };
      assert.equal(JSON.parse(result.content[0].text).count, 1);
      await client.close();
    }
  });
});

test("refuses to listen publicly without MCP_AUTH_TOKEN", async () => {
  const run = promisify(execFile);
  await assert.rejects(
    run(process.execPath, ["--import", "tsx", "src/index.ts"], { env: { ...process.env, HOST: "0.0.0.0", PORT: "0", MCP_AUTH_TOKEN: "" } }),
    (error: { stderr: string }) => /Refusing to listen on 0\.0\.0\.0 without MCP_AUTH_TOKEN/.test(error.stderr),
  );
});
