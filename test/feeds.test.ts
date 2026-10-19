import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PythFeed, SimulatedFeed, parseHermesResponse } from '../src/feeds.ts';

const BTC = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const XAU = '765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2';

// Shape of https://hermes.pyth.network/v2/updates/price/latest?ids[]=...&parsed=true
const hermesBody = {
  binary: { encoding: 'hex', data: ['504e4155...'] },
  parsed: [
    {
      id: BTC,
      price: { price: '11023412345678', conf: '4512345', expo: -8, publish_time: 1760877000 },
      ema_price: { price: '11020000000000', conf: '4000000', expo: -8, publish_time: 1760877000 },
      metadata: { slot: 1, proof_available_time: 1760877001, prev_publish_time: 1760876999 },
    },
    {
      id: XAU,
      price: { price: '401234500', conf: '12000', expo: -5, publish_time: 1760876998 },
      ema_price: { price: '401200000', conf: '12000', expo: -5, publish_time: 1760876998 },
      metadata: { slot: 1, proof_available_time: 1760876999, prev_publish_time: 1760876997 },
    },
  ],
};

test('parseHermesResponse scales prices by their exponent', () => {
  const updates = parseHermesResponse(hermesBody);
  assert.deepEqual(updates, [
    { feedId: BTC, price: 110234.12345678, publishTime: 1760877000 },
    { feedId: XAU, price: 4012.345, publishTime: 1760876998 },
  ]);
  assert.throws(() => parseHermesResponse({}), /parsed/);
});

test('PythFeed batches all feeds into one request and routes prices by symbol', async () => {
  const requested: URL[] = [];
  const received: [string, number, number][] = [];
  const fakeFetch = (async (url: URL) => {
    requested.push(url);
    return new Response(JSON.stringify(hermesBody), { status: 200 });
  }) as typeof fetch;
  const feed = new PythFeed(new Map([[BTC, 'BTCUSD'], [XAU, 'XAUUSD']]), (...args) => received.push(args), 'https://hermes.example', fakeFetch);

  await feed.poll();

  assert.equal(requested.length, 1);
  assert.equal(requested[0].origin + requested[0].pathname, 'https://hermes.example/v2/updates/price/latest');
  assert.deepEqual(requested[0].searchParams.getAll('ids[]'), [BTC, XAU]);
  assert.equal(requested[0].searchParams.get('parsed'), 'true');
  assert.deepEqual(received, [
    ['BTCUSD', 110234.12345678, 1760877000],
    ['XAUUSD', 4012.345, 1760876998],
  ]);
  assert.equal(feed.lastError, undefined);
});

test('PythFeed records HTTP failures instead of throwing', async () => {
  const fakeFetch = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch;
  const feed = new PythFeed(new Map([[BTC, 'BTCUSD']]), () => assert.fail('no price expected'), 'https://hermes.example', fakeFetch);
  const originalError = console.error;
  console.error = () => {};
  try {
    await feed.poll();
  } finally {
    console.error = originalError;
  }
  assert.equal(feed.lastError, 'Hermes returned HTTP 429');
});

test('SimulatedFeed random walk moves and stays positive', () => {
  let i = 0;
  const draws = [0.9, 0.1, 0.2, 0.7, 0.5, 0.3];
  const feed = new SimulatedFeed('SIM', 100, 0.6, () => {}, () => draws[i++ % draws.length]);
  const prices = Array.from({ length: 1000 }, () => feed.step());
  assert.ok(prices.every((p) => p > 0));
  assert.notEqual(prices[0], 100);
});
