import crypto from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Connector } from "./connector.js";
import { createServer } from "./server.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/^\[|\]$/g, ""));
}

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Stateless Streamable HTTP endpoint. Accepts POST /mcp with `Authorization: Bearer <token>`
 * or POST /mcp/<token> (for clients such as claude.ai custom connectors that only take a URL).
 */
export function createHttpServer(connector: Connector): http.Server {
  const { host, authToken } = connector.config.http;
  const loopbackOnly = isLoopback(host);

  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");

    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/health") {
      send(res, 200, { status: "ok", mode: connector.exchange.mode });
      return;
    }

    const match = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if (!match) {
      send(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }

    if (loopbackOnly) {
      const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!isLoopback(hostname)) {
        send(res, 403, { error: "Host not allowed" });
        return;
      }
    }

    if (authToken) {
      const header = req.headers.authorization;
      const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
      const pathToken = match[1] ? decodeURIComponent(match[1]) : undefined;
      if (!tokenMatches(authToken, pathToken) && !tokenMatches(authToken, bearer)) {
        send(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
        return;
      }
    } else if (match[1]) {
      send(res, 404, { error: "Not found" });
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." }, id: null }, { Allow: "POST" });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${(error as Error).message}` }, id: null });
      return;
    }

    const server = createServer(connector);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error(`[http] ${(error as Error).stack ?? error}`);
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
}
