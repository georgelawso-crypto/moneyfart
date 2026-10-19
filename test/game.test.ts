import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, MARKETS } from '../src/config.ts';
import { Game, GameError } from '../src/game.ts';

const T0 = 1_760_877_000; // a multiple of the 30s window

/** A game on the SIM market driven by a hand-cranked clock. */
function setup(startPrice = 100.02) {
  let now = T0;
  const game = new Game(MARKETS.filter((m) => m.symbol === 'SIM'), DEFAULT_SETTINGS, () => now);
  const sim = game.markets.get('SIM')!;
  sim.onPrice(startPrice, now);
  game.tick();
  /** Advances the clock one second at a time, publishing `price` each second unless it's null. */
  const advanceTo = (t: number, price: number | null) => {
    while (now < t) {
      now++;
      if (price !== null) sim.onPrice(price, now);
      game.tick();
    }
  };
  return { game, sim, advanceTo, now: () => now };
}

test('grid shows upcoming windows × bands centred on the price', () => {
  const { game } = setup();
  const grid = game.grid('sim');
  assert.equal(grid.bandSize, 0.05);
  assert.equal(grid.windows.length, DEFAULT_SETTINGS.columns);
  assert.equal(grid.windows[0].start, T0 + 30);
  assert.equal(grid.bands.length, DEFAULT_SETTINGS.layers);
  const center = grid.bands.findIndex((b) => b.containsPrice);
  assert.equal(grid.bands[center].index, 2000);
  assert.deepEqual([grid.bands[center].low, grid.bands[center].high], [100, 100.05]);
  assert.ok(grid.bands[0].index > grid.bands.at(-1)!.index, 'highest band first');
  assert.equal(grid.cells[center][0].id, `SIM-${T0 + 30}-2000`);

  for (let col = 0; col < grid.windows.length; col++) {
    const column = grid.cells.map((row) => row[col]);
    const total = column.reduce((sum, c) => sum + c.probability, 0);
    assert.ok(total <= 1 + 1e-9);
    assert.ok(column.every((c) => c.probability <= column[center].probability + 1e-12));
    for (const c of column) if (c.odds !== null) assert.ok(c.odds * c.probability <= 0.95 + 1e-9);
  }
});

test('a bet that lands pays amount × odds when its window closes', () => {
  const { game, advanceTo } = setup();
  const bet = game.placeBet('alice', `SIM-${T0 + 30}-2000`, 100);
  assert.equal(game.account('Alice').balance, 9900);
  assert.equal(bet.status, 'pending');

  advanceTo(T0 + 59, 100.03);
  assert.equal(bet.status, 'pending', 'not settled before the window closes');
  advanceTo(T0 + 60, 100.03);
  assert.equal(bet.status, 'won');
  assert.equal(bet.settlePrice, 100.03);
  assert.equal(bet.payout, Math.round(100 * bet.odds * 100) / 100);
  assert.equal(game.account('alice').balance, 9900 + bet.payout);
  assert.equal(game.account('alice').wins, 1);
});

test('only the price at the close of the window matters', () => {
  const { game, advanceTo } = setup();
  const bet = game.placeBet('bob', `SIM-${T0 + 30}-2000`, 50);
  advanceTo(T0 + 59, 100.02); // inside the band the whole window...
  advanceTo(T0 + 60, 100.05); // ...but closes exactly on the upper edge, which is outside [low, high)
  assert.equal(bet.status, 'lost');
  assert.equal(game.account('bob').balance, 9950);
});

test('a bet is refunded if there is no fresh price when its window closes', () => {
  const { game, advanceTo } = setup();
  const bet = game.placeBet('carol', `SIM-${T0 + 30}-2001`, 200);
  advanceTo(T0 + 60, null);
  assert.equal(bet.status, 'void');
  assert.equal(game.account('carol').balance, 10_000);
  assert.throws(() => game.grid('SIM'), /hasn't updated/);
});

test('bets are validated', () => {
  const { game, advanceTo, now } = setup();
  const reject = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (err: unknown) => err instanceof GameError && pattern.test(err.message));

  reject(() => game.placeBet('dan', 'nonsense', 100), /isn't a cell id/);
  reject(() => game.placeBet('dan', `DOGE-${T0 + 30}-2000`, 100), /Unknown market/);
  reject(() => game.placeBet('dan', `SIM-${T0 + 31}-2000`, 100), /isn't the start/);
  reject(() => game.placeBet('dan', `SIM-${T0 + 30 * 20}-2000`, 100), /too far ahead/);
  reject(() => game.placeBet('dan', `SIM-${T0 + 30}-2500`, 100), /too far from the current price/);
  reject(() => game.placeBet('dan', `SIM-${T0 + 30}-2000`, 5), /minimum bet/);
  reject(() => game.placeBet('dan', `SIM-${T0 + 30}-2000`, 20_000), /Insufficient balance/);
  reject(() => game.placeBet('', `SIM-${T0 + 30}-2000`, 100), /Player names/);

  game.placeBet('dan', `SIM-${T0 + 30}-2000`, 100);
  reject(() => game.placeBet('DAN', `SIM-${T0 + 30}-2000`, 100), /one bet per box/);

  advanceTo(T0 + 20, 100.02); // the T0+30 window stops taking bets 10s before it opens
  reject(() => game.placeBet('erin', `SIM-${T0 + 30}-2000`, 100), /closed/);
  assert.equal(now(), T0 + 20);
  assert.ok(game.placeBet('erin', `SIM-${T0 + 60}-2000`, 100));
});

test('very likely boxes are not offered', () => {
  const game = new Game(MARKETS.filter((m) => m.symbol === 'SIM'), DEFAULT_SETTINGS, () => T0);
  const sim = game.markets.get('SIM')!;
  sim.bandSize = 1; // a band far wider than a minute's move...
  sim.onPrice(100.5, T0); // ...with the price in the middle of it
  game.tick(T0);
  const cell = game.grid('SIM', 1, 1).cells[0][0];
  assert.equal(cell.id, `SIM-${T0 + 30}-100`);
  assert.ok(cell.probability > 0.99);
  assert.equal(cell.odds, null);
  assert.throws(() => game.placeBet('fay', cell.id, 100), /too likely to win/);
});

test('waitForResults resolves when the next bet settles', async () => {
  const { game, advanceTo } = setup();
  assert.deepEqual(await game.waitForResults('gus', 1), { settled: [], timedOut: false });

  game.placeBet('gus', `SIM-${T0 + 30}-2000`, 100);
  const waiting = game.waitForResults('gus', 5);
  advanceTo(T0 + 60, 101);
  const { settled, timedOut } = await waiting;
  assert.equal(timedOut, false);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'lost');
});

test('resetAccount starts a player over', () => {
  const { game } = setup();
  game.placeBet('hal', `SIM-${T0 + 30}-2000`, 100);
  const account = game.resetAccount('hal');
  assert.equal(account.balance, 10_000);
  assert.equal(account.bets.length, 0);
});
