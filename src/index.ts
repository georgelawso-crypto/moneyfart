#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadSettings, selectMarkets } from './config.js';
import { DEFAULT_HERMES_URL } from './feeds.js';
import { Game } from './game.js';
import { createMcpHttpServer } from './http.js';
import { createServer } from './server.js';

// Logs go to stderr: in stdio mode stdout carries the MCP protocol.
const game = new Game(selectMarkets(process.env.MARKETS), loadSettings());
game.start(process.env.HERMES_URL || DEFAULT_HERMES_URL);

const shutdown = () => {
  game.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (process.argv.includes('--stdio') || process.env.MCP_TRANSPORT === 'stdio') {
  await createServer(game).connect(new StdioServerTransport());
  console.error('TraderMaster MCP server running on stdio');
} else {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const path = process.env.MCP_PATH || '/mcp';
  createMcpHttpServer(game, path).listen(port, host, () => {
    console.error(`TraderMaster MCP server listening on http://${host}:${port}${path}`);
  });
}
