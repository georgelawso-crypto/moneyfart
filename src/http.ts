import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Game } from './game.js';
import { SERVER_NAME, SERVER_VERSION, createServer } from './server.js';

const MAX_BODY_BYTES = 1024 * 1024;

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The remote-connector transport: stateless Streamable HTTP on `mcpPath`.
 * Each POST gets its own short-lived MCP server; all game state lives in `game`,
 * so no MCP session needs to survive between requests.
 */
export function createMcpHttpServer(game: Game, mcpPath = '/mcp'): Server {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      const markets = [...game.markets.values()].map((m) => ({ symbol: m.spec.symbol, status: m.status(game.now) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: SERVER_NAME, version: SERVER_VERSION, mcp: mcpPath, markets }));
      return;
    }
    if (url.pathname !== mcpPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no sessions to DELETE.
      res.setHeader('Allow', 'POST, OPTIONS');
      jsonRpcError(res, 405, -32000, 'Method not allowed.');
      return;
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      jsonRpcError(res, 400, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const server = createServer(game);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[http] error handling MCP request:', err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });
}
