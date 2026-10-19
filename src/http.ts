import crypto from "node:crypto";
import http from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { Connector } from "./connector.js";
import { createServer, type SessionContext } from "./server.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "via"];

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/^\[|\]$/g, "").toLowerCase());
}

/** Host header without the port; handles IPv6 literals such as "[::1]:3000". */
export function hostname(hostHeader: string): string {
  const host = hostHeader.trim();
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]") > 0 ? host.indexOf("]") : undefined);
  return host.replace(/:\d+$/, "");
}

/** Refuse configurations that would expose betting tools without authentication. */
export function checkHttpSecurity(config: Config): void {
  const { host, authToken, allowUnauthenticatedLoopback } = config.http;
  if (authToken) return;
  if (!allowUnauthenticatedLoopback) {
    throw new Error(
      "MCP_AUTH_TOKEN is required for the HTTP transport (generate one with `openssl rand -hex 32`). " +
        "For a local paper-trading server you may set MCP_ALLOW_UNAUTHENTICATED_LOOPBACK=1 instead; stdio needs no token.",
    );
  }
  if (!isLoopback(host)) throw new Error(`MCP_ALLOW_UNAUTHENTICATED_LOOPBACK only works with a loopback HOST, not ${host}.`);
  if (config.trading.mode === "live") throw new Error("TRADING_MODE=live requires MCP_AUTH_TOKEN for the HTTP transport.");
  console.error("[betfair-ai-trading] WARNING: unauthenticated HTTP on loopback. Anything on this machine (or a local reverse proxy) can call the tools.");
}

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

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

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  context: SessionContext;
  lastSeen: number;
}

/**
 * Streamable HTTP endpoint with one MCP session per client (each conversation gets its own
 * active market). Auth: `Authorization: Bearer <token>` or the token as a path segment
 * (`/mcp/<token>`, for clients such as claude.ai custom connectors that only take a URL).
 */
export function createHttpServer(connector: Connector): http.Server {
  const { host, authToken, allowedOrigins, bfexplorerCompat } = connector.config.http;
  const loopbackOnly = isLoopback(host);
  const sessions = new Map<string, Session>();

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(id);
        void s.transport.close();
        void s.server.close();
      }
    }
  }, 60_000);
  sweep.unref();

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(`[http] ${(error as Error).stack ?? error}`);
      send(res, 500, rpcError(-32603, "Internal server error"));
    });
  });
  httpServer.on("close", () => {
    clearInterval(sweep);
    for (const s of sessions.values()) void s.transport.close();
    sessions.clear();
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      send(res, 400, { error: "Bad request" });
      return;
    }

    // Browsers: only explicitly allowed origins may talk to this server (blocks drive-by
    // requests from web pages to a local server). MCP clients send no Origin header.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!allowedOrigins.includes(origin.replace(/\/+$/, ""))) {
        send(res, 403, { error: "Origin not allowed" });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    }

    if (loopbackOnly && !isLoopback(hostname(req.headers.host ?? ""))) {
      send(res, 403, { error: "Host not allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/health") {
      send(res, 200, { status: "ok" });
      return;
    }

    const match = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname) ?? (bfexplorerCompat ? /^\/([^/]+)?\/?$/.exec(url.pathname) : null);
    if (!match) {
      send(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }
    const pathToken = match[1] ? safeDecode(match[1]) : undefined;
    if (authToken) {
      const header = req.headers.authorization;
      const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
      if (!tokenMatches(authToken, pathToken) && !tokenMatches(authToken, bearer)) {
        send(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
        return;
      }
    } else {
      if (match[1]) {
        send(res, 404, { error: "Not found" });
        return;
      }
      // Unauthenticated mode is loopback-only: a request relayed by a reverse proxy is remote.
      if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) {
        send(res, 403, { error: "Proxied requests require MCP_AUTH_TOKEN" });
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (req.method !== "POST") {
      if (!existing) {
        send(res, sessionId ? 404 : 400, rpcError(-32000, sessionId ? "Session not found" : "Missing mcp-session-id header"));
        return;
      }
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      send(res, 400, rpcError(-32700, `Parse error: ${(error as Error).message}`));
      return;
    }

    if (existing) {
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId) {
      send(res, 404, rpcError(-32001, "Session not found; start a new session with initialize"));
      return;
    }
    const isInit = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
    if (!isInit) {
      send(res, 400, rpcError(-32000, "Missing mcp-session-id header (send initialize first)"));
      return;
    }

    const context: SessionContext = {};
    const server = createServer(connector, context);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, context, lastSeen: Date.now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return httpServer;
}
