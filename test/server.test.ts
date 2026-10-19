import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_SETTINGS, MARKETS } from '../src/config.ts';
import { Game, type Grid } from '../src/game.ts';
import { createMcpHttpServer } from '../src/http.ts';
import { createServer } from '../src/server.ts';

const T0 = 1_760_877_000;

function liveGame() {
  const game = new Game(MARKETS.filter((m) => m.symbol === 'SIM' || m.symbol === 'BTCUSD'), DEFAULT_SETTINGS, () => T0);
  game.markets.get('SIM')!.onPrice(100.02, T0);
  game.tick(T0);
  return game;
}

const textOf = (result: unknown) => (result as CallToolResult).content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

async function playThrough(client: Client) {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    'get_account',
    'get_market',
    'get_prediction_grid',
    'list_markets',
    'place_bet',
    'reset_account',
    'wait_for_results',
  ]);
  assert.match(client.getInstructions() ?? '', /TraderMaster is a play-money prediction game/);

  const markets = textOf(await client.callTool({ name: 'list_markets', arguments: {} }));
  assert.match(markets, /SIM — .* LIVE/);
  assert.match(markets, /BTCUSD — .* WAITING/);

  const gridResult = (await client.callTool({ name: 'get_prediction_grid', arguments: { symbol: 'SIM' } })) as CallToolResult;
  assert.match(textOf(gridResult), /◀ price/);
  const grid = gridResult.structuredContent as unknown as Grid;
  const cell = grid.cells.flat().find((c) => c.odds !== null)!;

  const bet = (await client.callTool({ name: 'place_bet', arguments: { cell_id: cell.id, amount: 250, player: 'Ada' } })) as CallToolResult;
  assert.equal(bet.isError, undefined, textOf(bet));
  assert.match(textOf(bet), /Bet bet-1 placed: 250\.00 on SIM/);

  const account = textOf(await client.callTool({ name: 'get_account', arguments: { player: 'ada' } }));
  assert.match(account, /balance 9,750\.00/);
  assert.match(account, /PENDING/);

  const error = (await client.callTool({ name: 'place_bet', arguments: { cell_id: 'oops', amount: 50 } })) as CallToolResult;
  assert.equal(error.isError, true);
  assert.match(textOf(error), /isn't a cell id/);

  const waiting = (await client.callTool({ name: 'get_prediction_grid', arguments: { symbol: 'btc' } })) as CallToolResult;
  assert.equal(waiting.isError, true);
  assert.match(textOf(waiting), /BTCUSD has no price yet/);
}

test('tools work over an in-memory MCP connection', async () => {
  const game = liveGame();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(game).connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  await playThrough(client);
  await client.close();
});

test('tools work over the Streamable HTTP connector endpoint', async () => {
  const game = liveGame();
  const http = createMcpHttpServer(game);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.mcp, '/mcp');
    assert.equal((await fetch(`${base}/mcp`)).status, 405);

    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    await playThrough(client);
    await client.close();
  } finally {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
});
