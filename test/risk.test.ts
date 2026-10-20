import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BetfairApiError, BetfairClient } from "../src/betfair/client.js";
import { checkLiveSafety, loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { startOfDay } from "../src/exchange/guard.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { createServer } from "../src/server.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bat-risk-"));
const TAG = { name: "test", ref: "test" };
const sel101 = [{ selectionId: 101, handicap: 0 }];

function connector(env: Record<string, string> = {}, fake = new FakeBetfair()) {
  const config = loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", ...env });
  return { fake, c: new Connector(config, fake) };
}

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number, extra: Partial<OrderRequest> = {}): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE", ...extra };
}

const placeCalls = (fake: FakeBetfair) => fake.calls.filter((call) => call.method === "placeOrders").length;

// ------------------------------------------------------------------ configuration

describe("Australian jurisdiction", () => {
  test("is the default: .com.au logins, AUD paper account, Sydney time", () => {
    const config = loadConfig({});
    assert.equal(config.betfair.jurisdiction, "au");
    assert.equal(config.betfair.identityUrl, "https://identitysso.betfair.com.au/api");
    assert.equal(config.betfair.certIdentityUrl, "https://identitysso-cert.betfair.com.au/api");
    assert.equal(config.betfair.apiUrl, "https://api.betfair.com/exchange");
    assert.equal(config.trading.paperCurrency, "AUD");
    assert.equal(config.output.displayTimeZone, "Australia/Sydney");
  });

  test("COM (or UK/international) selects the .com endpoints, GBP and London time", () => {
    for (const name of ["COM", "uk", "International"]) {
      const config = loadConfig({ BETFAIR_JURISDICTION: name });
      assert.equal(config.betfair.jurisdiction, "com");
      assert.equal(config.betfair.identityUrl, "https://identitysso.betfair.com/api");
      assert.equal(config.betfair.certIdentityUrl, "https://identitysso-cert.betfair.com/api");
      assert.equal(config.trading.paperCurrency, "GBP");
      assert.equal(config.output.displayTimeZone, "Europe/London");
    }
    assert.throws(() => loadConfig({ BETFAIR_JURISDICTION: "mars" }), /BETFAIR_JURISDICTION must be AU/);
  });

  test("explicit settings win over the preset; endpoints must be https", () => {
    const config = loadConfig({
      BETFAIR_IDENTITY_URL: "https://identitysso.betfair.it/api/",
      BETFAIR_API_URL: "https://api.betfair.it/exchange",
      PAPER_CURRENCY: "eur",
      DISPLAY_TIMEZONE: "Europe/Rome",
    });
    assert.equal(config.betfair.identityUrl, "https://identitysso.betfair.it/api");
    assert.equal(config.betfair.apiUrl, "https://api.betfair.it/exchange");
    assert.equal(config.betfair.keepAliveMinutes, 10);
    assert.equal(config.trading.paperCurrency, "EUR");
    assert.equal(config.output.displayTimeZone, "Europe/Rome");
    assert.throws(() => loadConfig({ BETFAIR_IDENTITY_URL: "http://identitysso.betfair.com.au/api" }), /https/);
    assert.throws(() => loadConfig({ BETFAIR_API_URL: "not a url" }), /must be a URL/);
  });

  test("login and keepAlive go to identitysso.betfair.com.au", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      const body = url.endsWith("/login")
        ? { token: "tok", status: "SUCCESS" }
        : url.endsWith("/keepAlive")
          ? { token: "tok", status: "SUCCESS", error: "" }
          : { jsonrpc: "2.0", result: { availableToBetBalance: 1, exposure: 0 }, id: 1 };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const client = new BetfairClient(loadConfig({ BETFAIR_APP_KEY: "k", BETFAIR_USERNAME: "u", BETFAIR_PASSWORD: "p" }).betfair, fetchImpl);
    await client.getAccountFunds();
    await client.keepAlive();
    assert.deepEqual(requests, [
      "https://identitysso.betfair.com.au/api/login",
      "https://api.betfair.com/exchange/account/json-rpc/v1",
      "https://identitysso.betfair.com.au/api/keepAlive",
    ]);
  });

  test("AUD minimum bet rules apply to the AU paper account", async () => {
    const { c } = connector({ BETFAIR_JURISDICTION: "au" });
    assert.deepEqual(await c.exchange.currencyRules(), { currency: "AUD", minBetSize: 5, minBetPayout: 30 });
  });
});

describe("live-mode limits", () => {
  const all = { MAX_STAKE: "10", MAX_LIABILITY: "50", MAX_MARKET_LIABILITY: "50", MAX_TOTAL_EXPOSURE: "100", DAILY_LOSS_LIMIT: "50" };

  test("live mode refuses to start until every limit is set explicitly", () => {
    assert.throws(() => checkLiveSafety(loadConfig({ TRADING_MODE: "live" })), /MAX_STAKE, MAX_LIABILITY, MAX_MARKET_LIABILITY, MAX_TOTAL_EXPOSURE, DAILY_LOSS_LIMIT/);
    assert.throws(() => checkLiveSafety(loadConfig({ TRADING_MODE: "live", ...all, DAILY_LOSS_LIMIT: "" })), /Missing: DAILY_LOSS_LIMIT\./);
    assert.doesNotThrow(() => checkLiveSafety(loadConfig({ TRADING_MODE: "live", ...all })));
    assert.doesNotThrow(() => checkLiveSafety(loadConfig({})), "paper mode runs on the defaults");
  });

  test("limits must be plain decimal numbers", () => {
    for (const value of ["0x10", "1e3", "-5", "five", "10 "]) {
      if (value.trim() === "10") assert.equal(loadConfig({ MAX_STAKE: value }).trading.maxStake, 10);
      else assert.throws(() => loadConfig({ MAX_STAKE: value }), /MAX_STAKE must be a non-negative number/, value);
    }
    assert.equal(loadConfig({ MAX_STAKE: "12.5" }).trading.maxStake, 12.5);
  });

  test("limits are read from the environment", () => {
    const t = loadConfig(all).trading;
    assert.deepEqual([t.maxStake, t.maxLiability, t.maxMarketLiability, t.maxTotalExposure, t.dailyLossLimit], [10, 50, 50, 100, 50]);
    assert.deepEqual(t.unsetLimits, []);
  });
});

describe("startOfDay", () => {
  const at = (iso: string, zone: string) => new Date(startOfDay(Date.parse(iso), zone)).toISOString();

  test("local midnight in Sydney and London, across daylight-saving changes", () => {
    assert.equal(at("2026-10-20T03:44:00.000Z", "Australia/Sydney"), "2026-10-19T13:00:00.000Z");
    assert.equal(at("2026-10-19T13:00:00.000Z", "Australia/Sydney"), "2026-10-19T13:00:00.000Z");
    assert.equal(at("2026-10-19T12:59:59.000Z", "Australia/Sydney"), "2026-10-18T13:00:00.000Z");
    // Clocks went forward at 2am on 4 Oct 2026: that day's midnight was still +10.
    assert.equal(at("2026-10-04T00:30:00.000Z", "Australia/Sydney"), "2026-10-03T14:00:00.000Z");
    // Clocks went back at 3am on 5 Apr 2026: that day's midnight was still +11.
    assert.equal(at("2026-04-05T12:00:00.000Z", "Australia/Sydney"), "2026-04-04T13:00:00.000Z");
    assert.equal(at("2026-10-20T10:00:00.000Z", "Europe/London"), "2026-10-19T23:00:00.000Z");
    assert.equal(at("2026-12-20T10:00:00.000Z", "Europe/London"), "2026-12-20T00:00:00.000Z");
  });
});

// ------------------------------------------------------------------ the guard (paper)

describe("risk guard: limits that strategies cannot get around", () => {
  test("a bet sent straight to the exchange is still held to MAX_STAKE and MAX_LIABILITY", async () => {
    const { c } = connector({ MAX_STAKE: "10", MAX_LIABILITY: "20" });
    const [back] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 15)], TAG);
    assert.equal(back.status, "FAILURE");
    assert.match(back.errorCode!, /^MAX_STAKE: stake 15.00 exceeds MAX_STAKE 10/);
    const [lay] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 10)], TAG);
    assert.match(lay.errorCode!, /^MAX_LIABILITY: liability 20.50 exceeds MAX_LIABILITY 20/);
    assert.equal((await c.exchange.currentOrders([WIN_MARKET])).length, 0);
  });

  test("a 'closing' bet that would over-hedge is checked as a new bet; a real hedge always goes through", async () => {
    const { c } = connector({ MAX_LIABILITY: "25", MAX_MARKET_LIABILITY: "15" });
    const [entry] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG);
    assert.equal(entry.status, "SUCCESS");
    assert.equal(entry.sizeMatched, 10);

    // Flagged as closing, but it would reverse the position into a 51.50 loss if 101 wins.
    const [overHedge] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 30, { reducesRisk: true })], TAG);
    assert.equal(overHedge.status, "FAILURE");
    assert.match(overHedge.errorCode!, /^MAX_LIABILITY: liability 61.50 exceeds MAX_LIABILITY 25\. \(It was sent as a closing bet, but it doesn't close a position, so it was checked as a new bet\.\)$/);

    // The equal-profit hedge never raises the worst case, so it goes through even with the kill switch
    // on, and even without the flag: bets are judged by what they do, not by what they say.
    c.guard.engageKillSwitch("test");
    const [hedge] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 9.84)], TAG);
    assert.equal(hedge.status, "SUCCESS", JSON.stringify(hedge));
    assert.equal(hedge.sizeMatched, 9.84);
    // Now flat: any further lay on 101 would be new risk, and the kill switch stops it.
    const [more] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 5, { reducesRisk: true })], TAG);
    assert.match(more.errorCode!, /^KILL_SWITCH_ENGAGED: .*It was sent as a closing bet, but it doesn't close a position/);
  });

  test("MAX_MARKET_LIABILITY caps the market's worst case across bets and selections", async () => {
    const { c } = connector({ MAX_MARKET_LIABILITY: "30" });
    const [first] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG);
    assert.equal(first.status, "SUCCESS");
    const [second] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 20)], TAG);
    assert.equal(second.status, "FAILURE");
    assert.match(second.errorCode!, /^MAX_MARKET_LIABILITY: this would take the market's worst-case loss from 20.00 to 40.00/);
    const [third] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 10)], TAG);
    assert.equal(third.status, "SUCCESS");
  });

  test("MAX_TOTAL_EXPOSURE caps the worst case across markets", async () => {
    const { c } = connector({ MAX_TOTAL_EXPOSURE: "30" });
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].status, "SUCCESS");
    const [place] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 20)], TAG);
    assert.equal(place.status, "FAILURE");
    assert.match(place.errorCode!, /^MAX_TOTAL_EXPOSURE: open worst-case loss would be 40.00, above MAX_TOTAL_EXPOSURE 30/);
  });

  test("DAILY_LOSS_LIMIT counts today's settled losses plus everything open; closing bets still go through", async () => {
    const { c, fake } = connector({ DAILY_LOSS_LIMIT: "30" });
    assert.equal((await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 10)], TAG))[0].status, "SUCCESS");
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].status, "SUCCESS");
    const [tooMuch] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 5)], TAG);
    assert.match(tooMuch.errorCode!, /^DAILY_LOSS_LIMIT: today's settled loss 0.00 plus an open worst case of 35.00 would exceed DAILY_LOSS_LIMIT 30/);

    fake.settle([102]); // the WIN bet loses 20
    const status = await c.guard.riskStatus();
    assert.equal(status.settledToday, -20);
    assert.equal(status.openExposure, 10);
    assert.equal(status.headroom, 0);
    assert.equal(status.dailyLimitHit, false);

    const [refused] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 5)], TAG);
    assert.match(refused.errorCode!, /^DAILY_LOSS_LIMIT: today's settled loss 20.00 plus an open worst case of 15.00/);
    const [hedge] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "LAY", 1.52, 9.87, { reducesRisk: true })], TAG);
    assert.equal(hedge.status, "SUCCESS", JSON.stringify(hedge));
  });

  test("once today's settled losses reach the limit nothing new is added", async () => {
    const { c, fake } = connector({ DAILY_LOSS_LIMIT: "20" });
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].status, "SUCCESS");
    fake.settle([102]);
    assert.equal(await c.guard.dailyLimitHit(), true);
    const [bet] = await c.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 5)], TAG);
    assert.match(bet.errorCode!, /^DAILY_LOSS_LIMIT: today's settled loss 20.00 has reached DAILY_LOSS_LIMIT 20; no new risk until midnight \(Europe\/London\)/);
  });

  test("placements are checked one at a time, so two at once cannot share the same headroom", async () => {
    const { c } = connector({ MAX_MARKET_LIABILITY: "30" });
    const [a, b] = await Promise.all([
      c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG),
      c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 20)], TAG),
    ]);
    assert.equal(a[0].status, "SUCCESS");
    assert.equal(b[0].status, "FAILURE");
    assert.match(b[0].errorCode!, /^MAX_MARKET_LIABILITY/);
  });

  test("a strategy refused by the guard reports why, and places nothing", async () => {
    const { c } = connector();
    c.guard.engageKillSwitch("testing the strategy path");
    const result = await c.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101);
    assert.equal(result.status, false);
    assert.equal(result.outcome, "Failed");
    assert.match(result.message!, /KILL_SWITCH_ENGAGED: no new risk since .* \(testing the strategy path\)/);
    assert.equal(result.bets[0].status, "FAILURE");
  });
});

describe("risk guard: Australian in-play rule", () => {
  test("in-play sport is refused for AU accounts, closing bets included; paper mode models it too", async () => {
    const fake = new FakeBetfair();
    fake.catalogues.get(WIN_MARKET)!.eventType = { id: "1", name: "Soccer" };
    const { c } = connector({ BETFAIR_JURISDICTION: "au" }, fake);
    fake.book().inplay = true;
    for (const bet of [order(101, "BACK", 3.0, 10), order(101, "LAY", 3.05, 10, { reducesRisk: true })]) {
      const [result] = await c.exchange.placeOrders(WIN_MARKET, [bet], TAG);
      assert.equal(result.status, "FAILURE");
      assert.match(result.errorCode!, /^IN_PLAY_SPORT_NOT_ALLOWED: Australian customers can't bet in-play on sport online/);
    }
    assert.equal((await c.exchange.currentOrders()).length, 0);
  });

  test("in-play racing is allowed for AU accounts, and in-play sport for .com accounts", async () => {
    const racing = new FakeBetfair();
    racing.book().inplay = true;
    const au = connector({ BETFAIR_JURISDICTION: "au" }, racing);
    assert.equal((await au.c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG))[0].status, "SUCCESS");

    const sport = new FakeBetfair();
    sport.catalogues.get(WIN_MARKET)!.eventType = { id: "1", name: "Soccer" };
    sport.book().inplay = true;
    const com = connector({ BETFAIR_JURISDICTION: "com" }, sport);
    assert.equal((await com.c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG))[0].status, "SUCCESS");
  });
});

describe("risk guard: delayed data", () => {
  test("live mode refuses new risk on delayed prices but still lets a position be closed", async () => {
    const { c, fake } = connector({ TRADING_MODE: "live" });
    assert.equal((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 5)], TAG))[0].status, "SUCCESS");
    fake.book().isMarketDataDelayed = true;
    const before = placeCalls(fake);
    const [entry] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 5)], TAG);
    assert.equal(entry.status, "FAILURE");
    assert.match(entry.errorCode!, /^DELAYED_DATA: Betfair is sending this market's prices with a delay/);
    assert.equal(placeCalls(fake), before, "nothing reached Betfair");
    const [close] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 3.05, 4.92, { reducesRisk: true })], TAG);
    assert.equal(close.status, "SUCCESS");
    assert.equal(placeCalls(fake), before + 1);
  });

  test("paper mode still fills on delayed prices, with a warning the strategy result passes on", async () => {
    const { c, fake } = connector();
    fake.book().isMarketDataDelayed = true;
    const [bet] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 5)], TAG);
    assert.equal(bet.status, "SUCCESS");
    assert.match(bet.warning!, /^Delayed data: Betfair is sending this market's prices late/);
    const result = await c.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101);
    assert.equal(result.status, true);
    assert.match(result.message!, /Delayed data/);
  });
});

describe("risk guard: unconfirmed live orders", () => {
  test("a bet whose outcome is unknown counts as open until it is found or expires", async () => {
    const { c, fake } = connector({ TRADING_MODE: "live", MAX_MARKET_LIABILITY: "30" });
    const original = fake.placeOrders.bind(fake);
    let timeouts = 1;
    fake.placeOrders = async (args) => {
      if (timeouts-- > 0) {
        fake.calls.push({ method: "placeOrders", args });
        throw new BetfairApiError("Betfair placeOrders failed: timed out", "TIMEOUT");
      }
      return original(args);
    };
    const [unknown] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG);
    assert.equal(unknown.status, "UNKNOWN");
    const [next] = await c.exchange.placeOrders(WIN_MARKET, [order(102, "BACK", 5.9, 20)], TAG);
    assert.equal(next.status, "FAILURE");
    assert.match(next.errorCode!, /^MAX_MARKET_LIABILITY: this would take the market's worst-case loss from 20.00 to 40.00/);
  });
});

// ------------------------------------------------------------------ kill switch and daily clean-up

describe("kill switch", () => {
  test("engaging stops the bots, cancels unmatched bets and blocks new risk in every process sharing DATA_DIR", async () => {
    const dir = tmpDir();
    const fake = new FakeBetfair();
    const owner = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir }), fake);
    // A resting lay below the market, and a bot waiting to place a bet later.
    const [resting] = await owner.exchange.placeOrders(WIN_MARKET, [order(101, "LAY", 2.5, 5)], TAG);
    assert.equal(resting.orderStatus, "EXECUTABLE");
    const started = await owner.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101, { PlaceBetTimeSpan: "-0:25:00" });
    assert.equal(started.outcome, "Started", JSON.stringify(started));

    const report = await owner.engageKillSwitch("too many losses");
    assert.equal(report.botsStopped, 1);
    assert.deepEqual(
      report.cancelled.map((r) => [r.betId, r.status]),
      [[resting.betId, "SUCCESS"]],
    );
    const file = path.join(dir, "kill-switch.json");
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "only the account holder's user can read or change it");
    assert.equal(report.release, `delete ${file}`);
    assert.equal(owner.bots.list({ status: "running" }).length, 0);

    const [blocked] = await owner.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 5)], TAG);
    assert.match(blocked.errorCode!, /^KILL_SWITCH_ENGAGED: .*\(too many losses\)\. Bets that close positions still go through\. Only the account holder can release it: delete /);
    // Engaging again keeps the first reason.
    assert.equal(owner.guard.engageKillSwitch("again").reason, "too many losses");
    owner.shutdown();

    // A restarted (or second) process sees the same switch.
    const next = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir }), fake);
    assert.equal(next.killSwitch()?.reason, "too many losses");
    assert.match((await next.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 5)], TAG))[0].errorCode!, /^KILL_SWITCH_ENGAGED/);
    fs.rmSync(file); // the account holder releases it
    assert.equal((await next.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 5)], TAG))[0].status, "SUCCESS");
    next.shutdown();
  });

  test("a kill switch engaged by another process stops this process's bots on its next bot tick", async () => {
    const dir = tmpDir();
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir }), new FakeBetfair());
    const started = await c.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101, { PlaceBetTimeSpan: "-0:25:00" });
    assert.equal(started.outcome, "Started", JSON.stringify(started));
    fs.writeFileSync(path.join(dir, "kill-switch.json"), JSON.stringify({ engagedAt: new Date().toISOString(), reason: "from the other window" }));
    const original = console.error;
    console.error = () => undefined;
    try {
      await c.botTick();
    } finally {
      console.error = original;
    }
    assert.equal(c.bots.list({ status: "running" }).length, 0);
    c.shutdown();
  });

  test("a damaged kill switch file counts as engaged", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "kill-switch.json"), "{not json");
    const { c } = connector({ DATA_DIR: dir });
    assert.match(c.killSwitch()!.reason, /damaged/);
    assert.match((await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 5)], TAG))[0].errorCode!, /^KILL_SWITCH_ENGAGED/);
    c.shutdown();
  });

  test("with the daily limit hit (e.g. lowered on restart) the risk check cancels resting entries and keeps resting hedges", async () => {
    const dir = tmpDir();
    const fake = new FakeBetfair();
    const env = { BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir };
    const first = new Connector(loadConfig({ ...env, DAILY_LOSS_LIMIT: "100" }), fake);
    assert.equal((await first.exchange.placeOrders(PLACE_MARKET, [order(101, "BACK", 1.5, 10)], TAG))[0].sizeMatched, 10);
    const [hedge] = await first.exchange.placeOrders(PLACE_MARKET, [order(101, "LAY", 1.45, 10.34, { reducesRisk: true })], TAG);
    const [entry] = await first.exchange.placeOrders(PLACE_MARKET, [order(102, "BACK", 3.0, 5)], TAG);
    assert.equal(hedge.orderStatus, "EXECUTABLE");
    assert.equal(entry.orderStatus, "EXECUTABLE");
    assert.equal((await first.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 20)], TAG))[0].status, "SUCCESS");
    fake.settle([102]);
    await first.exchange.accountFunds(); // settles the WIN market: -20 today
    first.shutdown();

    const second = new Connector(loadConfig({ ...env, DAILY_LOSS_LIMIT: "20" }), fake);
    await second.riskCheck();
    const resting = (await second.exchange.currentOrders([PLACE_MARKET])).filter((o) => o.sizeRemaining > 0).map((o) => o.betId);
    assert.deepEqual(resting, [hedge.betId]);
    second.shutdown();
  });
});

// ------------------------------------------------------------------ MCP surface

describe("risk tools", () => {
  test("kill_switch status/engage and the risk block in get_connector_status", async () => {
    const { c } = connector({ MAX_STAKE: "10", DAILY_LOSS_LIMIT: "40" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(c, {}).connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    const json = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    };

    const status = await json("kill_switch", { action: "status" });
    assert.equal(status.limits.maxStake, 10);
    assert.equal(status.limits.dailyLossLimit, 40);
    assert.equal(status.killSwitch, undefined);
    assert.equal(status.headroom, 40, "nothing open and nothing settled today");

    const connectorStatus = await json("get_connector_status");
    assert.equal(connectorStatus.jurisdiction, "com");
    assert.equal(connectorStatus.risk.limits.maxStake, 10);

    const engaged = await json("kill_switch", { action: "engage", reason: "checking" });
    assert.equal(engaged.status, true);
    assert.equal(engaged.killSwitch.reason, "checking");
    assert.match(engaged.release, /restart the connector/);
    assert.equal((await json("kill_switch", { action: "status" })).killSwitch.reason, "checking");
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("kill_switch"));
  });
});
