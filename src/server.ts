import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { approx, clock, decimalsFor, money, num, percent, relative, signedMoney } from './format.js';
import { GameError, type Account, type Bet, type Game, type Grid, type MarketInfo } from './game.js';

export const SERVER_NAME = 'tradermaster';
export const SERVER_VERSION = '0.1.0';

function instructions(game: Game): string {
  const s = game.settings;
  return `TraderMaster is a play-money prediction game played on live price charts.

The chart's future is cut into boxes: ${s.windowSeconds}-second time windows (columns) × price bands (rows).
Bet on a box and you win if the price at the moment its window closes is inside the band.
Odds come from how likely that is (a normal-distribution model fed by recent volatility), minus a ${s.houseEdge * 100}% house edge,
and are locked in when you bet. Odds of 4.00 on a 100 stake pay 400 back (300 profit); a loss loses the stake.

How to play:
1. list_markets to see symbols (XAUUSD gold, BTCUSD, ETHUSD, SOLUSD via Pyth; SIM is simulated and always open).
2. get_prediction_grid for a symbol shows each box's odds and how to build its cell_id.
3. place_bet with a cell_id and amount (min ${money(s.minBet)}). Betting on a window closes ${s.betCloseSeconds}s before it opens.
4. wait_for_results blocks until your next bet settles; get_account shows balance and history.

Every player starts with ${money(s.startingBalance)} credits. Pass the same "player" name on every call to keep a balance.
All times are UTC. No real money is involved.`;
}

const player = z
  .string()
  .trim()
  .regex(/^[\w .-]{1,32}$/, 'Player names are 1-32 letters, digits, spaces, "_", "-" or "."')
  .default('player')
  .describe('Your player name. Any new name starts with fresh credits; reuse it to keep your balance.');

const symbol = z.string().min(1).describe('Market symbol, e.g. "SIM", "BTCUSD", "XAUUSD" (from list_markets).');

function text(body: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: body }], ...(structuredContent && { structuredContent }) };
}

/** Runs a tool body, turning game-rule violations into readable tool errors. */
async function run(fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GameError) return { content: [{ type: 'text', text: err.message }], isError: true };
    throw err;
  }
}

function priceDecimals(bandSize: number | undefined): number {
  return bandSize === undefined ? 2 : decimalsFor(bandSize) + 2;
}

function describeMarket(m: MarketInfo): string {
  const source = m.source === 'pyth' ? 'Pyth oracle' : 'simulated';
  const lines = [`${m.symbol} — ${m.name} · ${source} · ${m.status.toUpperCase()}`];
  if (m.price !== undefined) {
    lines.push(
      `  price ${num(m.price, priceDecimals(m.bandSize))}, updated ${m.priceAge ?? 0}s ago · ` +
        `band size ${m.bandSize} · volatility ≈ ${approx(m.sigmaPerSecond!)} per √s`,
    );
  }
  if (m.feedError) lines.push(`  feed error: ${m.feedError}`);
  if (m.status === 'stale') lines.push('  betting paused: no fresh price (market closed or feed down)');
  return lines.join('\n');
}

function describeGrid(grid: Grid, game: Game): string {
  const dp = decimalsFor(grid.bandSize);
  const s = game.settings;
  const bandLabel = (low: number, high: number, index: number) => `${num(low, dp)}–${num(high, dp)} #${index}`;
  const labelWidth = Math.max(...grid.bands.map((b) => bandLabel(b.low, b.high, b.index).length));
  const out = [
    `${grid.symbol} price ${num(grid.price, dp + 2)} at ${clock(grid.now)} UTC · band size ${grid.bandSize} · ` +
      `volatility ≈ ${approx(grid.sigmaPerSecond)} per √s`,
    '',
    `Columns are ${s.windowSeconds}s windows; a box wins if the price when its window closes is inside its band.`,
    `Cells show odds (total payout per 1 staked; implied win chance ≈ ${(1 - s.houseEdge) * 100}% ÷ odds).`,
    '"locked" = betting on that window has closed, "--" = too likely to win to offer odds.',
    '',
    `Windows (cell_id = ${grid.symbol}-<start>-<band #>):`,
    ...grid.windows.map(
      (w, i) =>
        `  W${i + 1}  ${clock(w.start)}–${clock(w.end)}  start ${w.start}  opens ${relative(w.start, grid.now)}  ` +
        (w.bettable ? `betting closes ${relative(w.closesAt, grid.now)}` : 'betting closed'),
    ),
    '',
    '```',
    ' '.repeat(labelWidth) + grid.windows.map((_, i) => `W${i + 1}`.padStart(8)).join(''),
    ...grid.bands.map((band, row) => {
      const cells = grid.cells[row].map((cell, col) => {
        const value = !grid.windows[col].bettable ? 'locked' : cell.odds === null ? '--' : cell.odds.toFixed(2);
        return value.padStart(8);
      });
      return bandLabel(band.low, band.high, band.index).padEnd(labelWidth) + cells.join('') + (band.containsPrice ? '  ◀ price' : '');
    }),
    '```',
  ];
  const example = grid.cells.flat().find((c) => c.odds !== null);
  if (example) {
    out.push(`Example: band #${example.band} in the ${clock(example.windowStart)} window is cell_id "${example.id}".`);
  }
  return out.join('\n');
}

function describeBet(bet: Bet, now: number, dp: number): string {
  const band = `${bet.symbol} ${num(bet.low, dp)}–${num(bet.high, dp)}`;
  const stake = `stake ${money(bet.amount)} @ ${bet.odds.toFixed(2)}`;
  switch (bet.status) {
    case 'pending':
      return `${bet.id}  PENDING  ${band}, settles ${clock(bet.windowEnd)} UTC (${relative(bet.windowEnd, now)}) · ${stake} → pays ${money(bet.amount * bet.odds)} if it lands`;
    case 'won':
      return `${bet.id}  WON      ${band}, closed ${clock(bet.windowEnd)} UTC at ${num(bet.settlePrice!, dp + 2)} · ${stake} → +${money(bet.payout - bet.amount)} profit`;
    case 'lost':
      return `${bet.id}  LOST     ${band}, closed ${clock(bet.windowEnd)} UTC at ${num(bet.settlePrice!, dp + 2)} · ${stake} → -${money(bet.amount)}`;
    case 'void':
      return `${bet.id}  REFUNDED ${band}, ${clock(bet.windowEnd)} UTC · ${stake} → ${bet.note}`;
  }
}

function describeAccount(account: Account, game: Game): string {
  const now = game.now;
  const dpFor = (symbol: string) => decimalsFor(game.markets.get(symbol)?.bandSize ?? 0.01);
  const pending = account.bets.filter((b) => b.status === 'pending');
  const settled = account.bets.filter((b) => b.status !== 'pending').reverse();
  const lines = [
    `Player "${account.player}" · balance ${money(account.balance)} (started with ${money(game.settings.startingBalance)})`,
    `Record: ${account.wins} won, ${account.losses} lost, ${account.voids} refunded · net ${signedMoney(account.returned - account.staked)} on settled bets`,
  ];
  lines.push('', pending.length ? `Pending bets (${pending.length}):` : 'No pending bets.');
  for (const bet of pending) {
    const market = game.markets.get(bet.symbol)!;
    const price = market.price!;
    const where = price >= bet.low && price < bet.high ? 'inside the band now' : price < bet.low ? 'below the band now' : 'above the band now';
    lines.push(`  ${describeBet(bet, now, dpFor(bet.symbol))} · price ${num(price, dpFor(bet.symbol) + 2)} (${where})`);
  }
  if (settled.length) {
    lines.push('', 'Settled (newest first):', ...settled.slice(0, 20).map((b) => `  ${describeBet(b, now, dpFor(b.symbol))}`));
  }
  return lines.join('\n');
}

/** Builds an MCP server exposing `game` as tools. Cheap: one per HTTP request is fine. */
export function createServer(game: Game): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: instructions(game) });
  const s = game.settings;

  server.registerTool(
    'list_markets',
    {
      title: 'List markets',
      description: 'Lists the markets you can bet on, with live price, feed status and band size.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(() => {
        const markets = [...game.markets.values()].map((m) => game.marketInfo(m));
        return text(
          [`Server time ${clock(game.now)} UTC`, '', ...markets.map(describeMarket)].join('\n'),
          { now: game.now, markets },
        );
      }),
  );

  server.registerTool(
    'get_market',
    {
      title: 'Price chart',
      description: 'Recent price action for one market as OHLC bars, plus its current price and volatility.',
      inputSchema: {
        symbol,
        lookback_seconds: z.number().int().min(30).max(3600).default(300).describe('How far back to look (seconds).'),
        bar_seconds: z.number().int().min(1).max(600).default(15).describe('Bar size (seconds).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ symbol, lookback_seconds, bar_seconds }) =>
      run(() => {
        const market = game.market(symbol);
        const info = game.marketInfo(market);
        const bars = market.bars(lookback_seconds, bar_seconds);
        const dp = priceDecimals(market.bandSize);
        const lines = [describeMarket(info)];
        if (bars.length > 0) {
          const high = Math.max(...bars.map((b) => b.high));
          const low = Math.min(...bars.map((b) => b.low));
          const change = bars.at(-1)!.close - bars[0].open;
          const sign = change >= 0 ? '+' : '';
          const typicalMinute = info.sigmaPerSecond! * Math.sqrt(60);
          lines.push(
            `  last ${lookback_seconds}s: high ${num(high, dp)}, low ${num(low, dp)}, change ${sign}${num(change, dp)} ` +
              `(${sign}${((change / bars[0].open) * 100).toFixed(3)}%) · typical 1-minute move ±${approx(typicalMinute)}`,
            '',
            `${bar_seconds}s bars (UTC):`,
            '```',
            `time      ${'open'.padStart(12)}${'high'.padStart(12)}${'low'.padStart(12)}${'close'.padStart(12)}`,
            ...bars.map(
              (b) =>
                `${clock(b.time)}  ${[b.open, b.high, b.low, b.close].map((x) => num(x, dp).padStart(12)).join('')}${b.fresh ? '' : '  (stale)'}`,
            ),
            '```',
          );
        }
        return text(lines.join('\n'), { ...info, bars });
      }),
  );

  server.registerTool(
    'get_prediction_grid',
    {
      title: 'Prediction grid',
      description:
        'Shows the boxes you can bet on for a market: upcoming time windows (columns) × price bands (rows) with live odds, ' +
        'and the cell_id format for place_bet. Odds move with the price, so fetch a fresh grid before betting.',
      inputSchema: {
        symbol,
        columns: z.number().int().min(1).max(s.columns).optional().describe(`Windows to show (default and max ${s.columns}).`),
        layers: z.number().int().min(1).max(25).optional().describe(`Price bands to show around the current price (default ${s.layers}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ symbol, columns, layers }) =>
      run(() => {
        const grid = game.grid(symbol, columns, layers);
        return text(describeGrid(grid, game), { ...grid });
      }),
  );

  server.registerTool(
    'place_bet',
    {
      title: 'Place bet',
      description:
        `Bets play money on one box. You win amount × odds if the price is inside the box's band when its window closes. ` +
        `Odds are locked when the bet is placed. Minimum ${money(s.minBet)}; one bet per box; betting on a window closes ` +
        `${s.betCloseSeconds}s before it opens.`,
      inputSchema: {
        cell_id: z.string().min(1).describe('Box to bet on, "<SYMBOL>-<window start>-<band #>", from get_prediction_grid.'),
        amount: z.number().positive().describe(`Stake in credits (min ${s.minBet}).`),
        player,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ cell_id, amount, player }) =>
      run(() => {
        const bet = game.placeBet(player, cell_id, amount);
        const account = game.account(player);
        const dp = decimalsFor(game.markets.get(bet.symbol)!.bandSize!);
        return text(
          [
            `Bet ${bet.id} placed: ${money(bet.amount)} on ${bet.symbol} closing in ${num(bet.low, dp)}–${num(bet.high, dp)} ` +
              `at ${clock(bet.windowEnd)} UTC (${relative(bet.windowEnd, game.now)}).`,
            `Odds ${bet.odds.toFixed(2)} (model win chance ${percent(bet.probability)}): pays ${money(bet.amount * bet.odds)} if it lands.`,
            `Price now ${num(bet.priceAtBet, dp + 2)}. Balance ${money(account.balance)}.`,
          ].join('\n'),
          { bet, balance: account.balance },
        );
      }),
  );

  server.registerTool(
    'get_account',
    {
      title: 'Account',
      description: 'Shows a player\'s balance, win/loss record, pending bets (with where the price is now) and recent results.',
      inputSchema: { player },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ player }) =>
      run(() => {
        const account = game.account(player);
        return text(describeAccount(account, game), { ...account });
      }),
  );

  server.registerTool(
    'wait_for_results',
    {
      title: 'Wait for results',
      description:
        'Waits (up to timeout_seconds) for the player\'s next pending bet to settle, then reports the result and new balance. ' +
        'Returns immediately if nothing is pending.',
      inputSchema: {
        player,
        timeout_seconds: z.number().int().min(1).max(55).default(45).describe('Longest to wait, in seconds (max 55).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ player, timeout_seconds }, extra) =>
      run(async () => {
        const { settled, timedOut } = await game.waitForResults(player, timeout_seconds, extra.signal);
        const account = game.account(player);
        const pending = account.bets.filter((b) => b.status === 'pending');
        const dpFor = (symbol: string) => decimalsFor(game.markets.get(symbol)?.bandSize ?? 0.01);
        const lines: string[] = [];
        if (settled.length) {
          lines.push('Settled:', ...settled.map((b) => `  ${describeBet(b, game.now, dpFor(b.symbol))}`));
        } else if (timedOut) {
          lines.push(`Nothing settled in ${timeout_seconds}s.`);
        } else {
          lines.push('No pending bets to wait for.');
        }
        lines.push(`Balance ${money(account.balance)}.`);
        if (pending.length) {
          const next = Math.min(...pending.map((b) => b.windowEnd));
          lines.push(`${pending.length} bet(s) still pending; next settles at ${clock(next)} UTC (${relative(next, game.now)}).`);
        }
        return text(lines.join('\n'), { settled, timedOut, balance: account.balance, pending: pending.length });
      }),
  );

  server.registerTool(
    'reset_account',
    {
      title: 'Reset account',
      description: `Starts a player over with ${money(s.startingBalance)} credits, clearing history and forfeiting pending bets.`,
      inputSchema: { player },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ player }) =>
      run(() => {
        const account = game.resetAccount(player);
        return text(`Player "${account.player}" reset to ${money(account.balance)} credits.`, { balance: account.balance });
      }),
  );

  return server;
}
