/**
 * Replay the real game engine on a CSV of 1-minute prices.
 *
 * Feeds each price into the Game via onPrice + tick, then uses
 * planStake(grid, realizedSigma()) on the full multi-band grid.
 * House edge is the configured 5%. Only bets when the unfloored
 * vol clears the 3% edge. Quarter-Kelly, capped at 5%.
 *
 *   node dist/replay.js btc_1m.csv
 */
import { readFileSync } from 'node:fs';
import { MARKETS, DEFAULT_SETTINGS, type GameSettings } from './config.js';
import { Game } from './game.js';
import { planStake, stakeAmount } from './strategy.js';

const STARTING_BANK = 1000;
const WORKING = 1000;

const file = process.argv[2] ?? 'btc_1m.csv';
const lines = readFileSync(file, 'utf8').trim().split('\n').slice(1);
const bars = lines.map((l) => {
  const [t, c] = l.split(',');
  return { time: Number(t), close: Number(c) };
});
if (bars.length < 100) throw new Error('need more price bars');

console.log(`${bars.length} bars from ${file}`);

const settings: GameSettings = { ...DEFAULT_SETTINGS, startingBalance: WORKING, minBet: 1, houseEdge: 0.05 };
const spec = { ...MARKETS.find((m) => m.symbol === 'SIM')!, annualVolatility: 0.5, startPrice: bars[0].close };

let now = bars[0].time;
const game = new Game([spec], settings, () => now);
const sim = game.markets.get('SIM')!;

function money(x: number): string {
  if (!Number.isFinite(x)) return 'overflow';
  if (x >= 1e6) return `$${x.toExponential(3)}`;
  return `$${x.toFixed(0)}`;
}

for (let i = 0; i < 10; i++) {
  now = bars[i].time;
  sim.onPrice(bars[i].close, now);
  game.tick();
}

const player = 'bank';
let logBank = Math.log(STARTING_BANK);
let bets = 0;
let wins = 0;
let skipped = 0;
const mid = Math.floor(bars.length / 2);
let halfBank = STARTING_BANK;

for (let i = 10; i < bars.length - 1; i++) {
  const target = bars[i].time;
  const price = bars[i].close;
  while (now < target) {
    now++;
    sim.onPrice(price, now);
    game.tick();
  }

  if (i === mid) {
    halfBank = Math.exp(logBank);
    console.log(`First half: ${money(halfBank)}  bets ${bets}  wins ${wins}`);
  }

  game.resetAccount(player);
  const plan = planStake(game.grid('SIM'), sim.realizedSigma());
  let bet: ReturnType<Game['placeBet']> | undefined;
  let fraction = 0;
  if (plan) {
    const amount = stakeAmount(WORKING, plan.fraction, settings.minBet);
    if (amount >= settings.minBet && amount <= WORKING) {
      try {
        bet = game.placeBet(player, plan.cell.id, amount);
        fraction = amount / WORKING;
        bets++;
      } catch {
        skipped++;
      }
    } else skipped++;
  } else skipped++;

  const stepTo = bet ? bet.windowEnd : now + 30;
  while (now < stepTo) {
    now++;
    const px = i + 1 < bars.length && now >= bars[i + 1].time ? bars[i + 1].close : price;
    sim.onPrice(px, now);
    game.tick();
  }

  if (bet && bet.status !== 'pending') {
    if (bet.status === 'won') wins++;
    const returned = bet.status === 'void' ? 1 : bet.payout / bet.amount;
    const factor = 1 - fraction + fraction * returned;
    if (factor > 0) logBank += Math.log(factor);
    else logBank = Number.NEGATIVE_INFINITY;
  }
}

const full = Math.exp(logBank);
console.log(`Full: ${money(full)}  bets ${bets}  wins ${wins}`);
const held = full / halfBank;
console.log('');
console.log(`Held-out multiple: ${held.toFixed(2)}x`);
console.log(`Passed ${skipped} decisions.`);
console.log(held > 1 ? 'Held-out positive on the full engine.' : 'Held-out not positive. The full grid did not keep the edge.');
