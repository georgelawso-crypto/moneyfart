/**
 * Compound a $1,000 bank on the SIM market using the real game engine.
 *
 * The house keeps 5% (`houseEdge` 0.05) and floors its volatility at half the
 * assumed annual figure. The strategy estimates volatility from the same
 * one-second moves with no floor, and bets quarter-Kelly only when that
 * disagreement clears a 3% edge. Prices alternate quiet and loud regimes so
 * the floor sometimes binds and sometimes does not. Matched regimes produce
 * no bet.
 *
 *   node dist/weekly.js            # 1 week, seed 1
 *   node dist/weekly.js 4          # 4 weeks
 *   node dist/weekly.js 1 7        # 1 week, seed 7
 */
import { MARKETS, DEFAULT_SETTINGS, type GameSettings } from './config.js';
import { Game } from './game.js';
import { SECONDS_PER_YEAR } from './pricing.js';
import { MIN_EDGE, planStake, stakeAmount } from './strategy.js';

const STARTING_BANK = 1000;
const WORKING = 1000;
const WINDOW = DEFAULT_SETTINGS.windowSeconds;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const T0 = 1_760_877_000;
const REGIME_SECONDS = 600;
const QUIET = 0.35;
const LOUD = 1.6;

const weeks = Math.max(1, Number(process.argv[2] ?? 1) || 1);
const seed = Number(process.argv[3] ?? 1) || 1;

function mulberry32(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random: () => number): number {
  const u = Math.max(1e-12, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function money(x: number): string {
  if (!Number.isFinite(x)) return 'overflow';
  if (x >= 1e6) return `$${x.toExponential(3)}`;
  return `$${x.toFixed(2)}`;
}

const settings: GameSettings = { ...DEFAULT_SETTINGS, startingBalance: WORKING, minBet: 1 };
const spec = MARKETS.find((m) => m.symbol === 'SIM')!;
const baseSigma = ((spec.startPrice ?? 100) * spec.annualVolatility) / Math.sqrt(SECONDS_PER_YEAR);

let now = T0;
const game = new Game([spec], settings, () => now);
const sim = game.markets.get('SIM')!;
const random = mulberry32(seed);

let price = spec.startPrice ?? 100;
sim.onPrice(price, now);
game.tick();

function step(seconds: number): void {
  for (let i = 0; i < seconds; i++) {
    now++;
    const phase = Math.floor((now - T0) / REGIME_SECONDS) % 2;
    const sigma = baseSigma * (phase === 0 ? QUIET : LOUD);
    price = Math.max(0.01, price + sigma * normal(random));
    sim.onPrice(price, now);
    game.tick();
  }
}

step(400);

const player = 'bank';
let logBank = Math.log(STARTING_BANK);
const betsPerWeek = Math.floor(WEEK_SECONDS / (WINDOW * 2));

console.log('House edge 5%. Bets only when unfloored vol beats the book by enough to clear the house.');
console.log(`Min edge ${(MIN_EDGE * 100).toFixed(0)}%   stake: quarter Kelly, cap 5%   regimes: x${QUIET} / x${LOUD} every ${REGIME_SECONDS}s`);
console.log(`Start: ${money(STARTING_BANK)}   decisions/week: ${betsPerWeek}   seed: ${seed}`);
console.log('');

for (let week = 1; week <= weeks; week++) {
  const start = Math.exp(logBank);
  let bets = 0;
  let wins = 0;
  let skipped = 0;

  for (let w = 0; w < betsPerWeek; w++) {
    game.resetAccount(player);
    const plan = planStake(game.grid('SIM'), sim.realizedSigma());
    let bet: ReturnType<Game['placeBet']> | undefined;
    let fraction = 0;
    if (plan) {
      const amount = stakeAmount(WORKING, plan.fraction, settings.minBet);
      if (amount >= settings.minBet && amount <= WORKING) {
        bet = game.placeBet(player, plan.cell.id, amount);
        fraction = amount / WORKING;
        bets++;
      } else skipped++;
    } else skipped++;
    const stepTo = bet ? bet.windowEnd : now - (now % WINDOW) + WINDOW;
    step(stepTo - now);
    if (bet && bet.status !== 'pending') {
      if (bet.status === 'won') wins++;
      const returned = bet.status === 'void' ? 1 : bet.payout / bet.amount;
      const factor = 1 - fraction + fraction * returned;
      if (factor > 0) logBank += Math.log(factor);
      else logBank = Number.NEGATIVE_INFINITY;
    }
  }

  const end = Math.exp(logBank);
  const pct = start > 0 ? (end / start - 1) * 100 : 0;
  console.log(
    `Week ${week}: ${money(start)} -> ${money(end)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)  bets ${bets}  wins ${wins}  passed ${skipped}`,
  );
}

const final = Math.exp(logBank);
console.log('');
console.log(`After ${weeks} week(s): ${money(final)}  (${((final / STARTING_BANK - 1) * 100).toFixed(2)}% on $${STARTING_BANK}, seed ${seed})`);
