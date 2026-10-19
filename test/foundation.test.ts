import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { localTime, parseTimeSpan, toToon, utcSeconds, compact } from "../src/format.js";
import { MarketService } from "../src/markets.js";
import { Recorder, classifyTrade } from "../src/recorder.js";
import { State } from "../src/state.js";
import { FakeBetfair, PLACE_MARKET, WIN_MARKET } from "./fakeBetfair.js";

function setup() {
  const fake = new FakeBetfair();
  const state = new State();
  const recorder = new Recorder();
  const markets = new MarketService(fake, state, recorder, 20);
  return { fake, state, recorder, markets };
}

describe("format", () => {
  test("TOON reproduces BFExplorer's get_active_market text", () => {
    const text = toToon(
      {
        marketId: "1.262425289",
        startTime: utcSeconds("2026-09-16T12:45:00.000Z"),
        eventType: "Horse Racing",
        eventName: "Sandown",
        marketName: "5f Hcap",
        totalMatched: 5320.11,
        status: "Open",
        selections: [
          { selectionId: "72693638", name: "Hint Of Humour", price: 5.2, totalMatched: 889.69, status: "Active" },
          { selectionId: "88668986", name: "Bellini Spirit", price: 130.01, totalMatched: 8.83, status: "Active" },
        ],
      },
      "activeBetfairMarket",
    );
    assert.equal(
      text,
      [
        "activeBetfairMarket:",
        '  marketId: "1.262425289"',
        '  startTime: "2026-09-16T12:45:00Z"',
        '  eventType: "Horse Racing"',
        "  eventName: Sandown",
        '  marketName: "5f Hcap"',
        "  totalMatched: 5320.11",
        "  status: Open",
        "  selections[2]{selectionId,name,price,totalMatched,status}:",
        '    "72693638","Hint Of Humour",5.2,889.69,Active',
        '    "88668986","Bellini Spirit",130.01,8.83,Active',
      ].join("\n"),
    );
  });

  test("TOON handles nested, list and empty values", () => {
    assert.equal(toToon({ a: [], b: { c: [1, 2] }, d: [{ x: 1, y: [1] }, { x: 2 }], e: "", f: "true", "g-h": "-1" }), [
      "a: []",
      "b:",
      "  c[2]: 1,2",
      "d[2]:",
      "  - x: 1",
      "    y[1]: 1",
      "  - x: 2",
      'e: ""',
      'f: "true"',
      '"g-h": "-1"',
    ].join("\n"));
  });

  test("times use UTC Z for markets and local offsets for data contexts", () => {
    assert.equal(utcSeconds("2026-09-16T12:45:00.000Z"), "2026-09-16T12:45:00Z");
    assert.equal(localTime("2026-10-06T18:00:00Z", "Europe/Bratislava"), "2026-10-06T20:00:00+02:00");
    assert.equal(localTime("2026-12-28T15:52:14Z", "Europe/London"), "2026-12-28T15:52:14+00:00");
    assert.equal(localTime("2026-07-01T10:00:00Z", "Europe/London"), "2026-07-01T11:00:00+01:00");
  });

  test(".NET TimeSpans parse to milliseconds", () => {
    assert.equal(parseTimeSpan("-0:05:00"), -300_000);
    assert.equal(parseTimeSpan("00:00:05"), 5000);
    assert.equal(parseTimeSpan("1.02:00:00"), 93_600_000);
    assert.equal(parseTimeSpan(null), undefined);
    assert.throws(() => parseTimeSpan("five minutes"));
  });

  test("compact drops nulls and empty data", () => {
    assert.deepEqual(compact({ a: null, b: undefined, data: {}, c: [{ data: { x: null } }] }), { c: [{}] });
  });
});

describe("recorder", () => {
  test("classifies aggressors against the previous best prices", () => {
    assert.equal(classifyTrade(3.0, 3.0, 3.05), "back");
    assert.equal(classifyTrade(2.98, 3.0, 3.05), "back");
    assert.equal(classifyTrade(3.05, 3.0, 3.05), "lay");
    assert.equal(classifyTrade(3.1, 3.0, 3.05), "lay");
    assert.equal(classifyTrade(3.02, 3.0, 3.05), "unknown");
  });

  test("reconstructs trades from traded-volume growth", async () => {
    const { fake, markets, recorder } = setup();
    await markets.getBook(WIN_MARKET);
    fake.trade(101, 3.0, 50); // at the back price: backer
    fake.trade(101, 3.05, 20); // at the lay price: layer
    await markets.getBook(WIN_MARKET);
    const sel = recorder.get(WIN_MARKET)!.selections.get("101")!;
    assert.equal(sel.startPrice, 3.0);
    assert.deepEqual(
      sel.trades.map((t) => [t.price, t.size, t.side]).sort(),
      [[3, 50, "back"], [3.05, 20, "lay"]].sort(),
    );
    assert.equal(sel.trades.at(-1)!.price, 3.05, "last trade is the new LTP");
    assert.deepEqual(recorder.get(WIN_MARKET)!.preOffOrder, ["101", "103", "102"]);
  });

  test("tracks in-play price range", async () => {
    const { fake, markets, recorder } = setup();
    await markets.getBook(WIN_MARKET);
    fake.book().inplay = true;
    fake.trade(101, 1.5, 10);
    await markets.getBook(WIN_MARKET);
    fake.trade(101, 4.0, 10);
    await markets.getBook(WIN_MARKET);
    const sel = recorder.get(WIN_MARKET)!.selections.get("101")!;
    assert.equal(sel.inPlayMin, 1.5);
    assert.equal(sel.inPlayMax, 4.0);
  });
});

describe("market service", () => {
  test("re-requests closed markets that Betfair drops from mixed batches", async () => {
    const { fake, markets } = setup();
    fake.settle([101], PLACE_MARKET);
    const books = await markets.getBooks([WIN_MARKET, PLACE_MARKET]);
    assert.deepEqual(books.map((b) => b.marketId).sort(), [WIN_MARKET, PLACE_MARKET]);
  });

  test("keeps serving closed markets from the catalogue snapshot and archives results", async () => {
    const { fake, markets, state } = setup();
    await markets.openMarket(WIN_MARKET, { activate: true });
    assert.equal(state.activeMarketId, WIN_MARKET);
    fake.settle([103]);
    const catalogue = await markets.getCatalogue(WIN_MARKET, true);
    assert.equal(catalogue.marketName, "2m Hcap");
    const book = await markets.getBook(WIN_MARKET);
    const market = markets.bfexplorerMarket(catalogue, book);
    assert.equal(market.status, "Closed");
    assert.equal(market.selections.find((s) => s.selectionId === "103")!.status, "Winner");
    const archived = state.archive.get(WIN_MARKET)!;
    assert.equal(archived.venue, "Ascot");
    assert.equal(archived.runners.find((r) => r.selectionId === 103)!.status, "Winner");
    assert.equal(state.monitored.get(WIN_MARKET)!.status, "Closed");
  });

  test("builds BFExplorer's market payload: venue, LTP prices, price order before the off", async () => {
    const { fake, markets } = setup();
    const catalogue = await markets.getCatalogue(WIN_MARKET);
    let market = markets.bfexplorerMarket(catalogue, await markets.getBook(WIN_MARKET));
    assert.equal(market.eventName, "Ascot");
    assert.match(market.startTime!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(market.selections.map((s) => [s.selectionId, s.price]), [["101", 3], ["103", 4.5], ["102", 6]]);
    // In-play the order stays as it was before the off even when prices cross.
    fake.book().inplay = true;
    fake.setRunner(102, { lastPriceTraded: 1.2 });
    market = markets.bfexplorerMarket(catalogue, await markets.getBook(WIN_MARKET));
    assert.deepEqual(market.selections.map((s) => s.selectionId), ["101", "103", "102"]);
    assert.equal(market.inPlay, true);
    assert.equal(markets.bfexplorerMarket(catalogue, fake.book(), true).inPlay, undefined);
  });

  test("finds the sibling PLACE market of a WIN market", async () => {
    const { markets } = setup();
    const place = await markets.findSiblingMarket(await markets.getCatalogue(WIN_MARKET), "PLACE");
    assert.equal(place?.marketId, PLACE_MARKET);
  });

  test("FindMarkets includes recently started events and reports in-play status", async () => {
    const { fake, markets } = setup();
    fake.book().inplay = true;
    const found = await markets.findMarkets({ sport: "horses", marketTypes: ["WIN"] });
    assert.equal(found[0].marketId, WIN_MARKET);
    assert.equal(found[0].inPlay, true);
    const filter = fake.calls.find((c) => c.method === "listMarketCatalogue")!.args.filter;
    assert.ok(Date.parse(filter.marketStartTime.from) < Date.now() - 3 * 3600_000);
    await markets.findMarkets({ sport: "Soccer", marketTypes: ["WINNER"] });
    assert.equal(fake.calls.filter((c) => c.method === "listMarketCatalogue").at(-1)!.args.filter.marketStartTime, undefined);
  });

  test("batches books by Betfair's data-weight limit", async () => {
    const { fake, markets } = setup();
    const ids = Array.from({ length: 25 }, (_, i) => `1.30000${String(i).padStart(4, "0")}`);
    await markets.getBooks(ids, { allOffers: true, sp: true });
    const requests = fake.calls.filter((c) => c.method === "listMarketBook").map((c) => c.args.marketIds.length);
    assert.ok(requests.every((n) => n * (17 + 17 + 10) <= 200), JSON.stringify(requests));
  });
});

describe("state", () => {
  test("strategy refs fit Betfair's 15 characters without merging strategies", () => {
    const state = new State();
    const a = state.strategyRefFor("Execute my AI Agent strategy - Bet");
    const b = state.strategyRefFor("Execute my AI Agent strategy - Trade");
    assert.ok(a.length <= 15 && b.length <= 15);
    assert.notEqual(a, b);
    assert.equal(state.strategyRefFor("Bet 10 Euro"), "Bet 10 Euro");
    assert.equal(state.strategyNameForRef(b), "Execute my AI Agent strategy - Trade");
    assert.equal(state.strategyRefFor("Execute my AI Agent strategy - Bet"), a);
  });

  test("persists, locks DATA_DIR and flushes on demand", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bat-state-"));
    const first = State.forDataDir(dir);
    first.setDataContext("1.1", "Analysis", { pick: 1 });
    first.flush();
    first.release();
    // Another live process (our parent) holds the lock.
    fs.writeFileSync(path.join(dir, "state.lock"), String(process.ppid));
    const second = State.forDataDir(dir);
    assert.equal(second.readOnly, true, "a second process must not overwrite the ledger");
    assert.deepEqual(second.getDataContext("1.1", "Analysis")!.data, { pick: 1 });
    // A lock left by a dead process is taken over.
    fs.writeFileSync(path.join(dir, "state.lock"), "999999");
    const third = State.forDataDir(dir);
    assert.equal(third.readOnly, false);
    third.release();
  });

  test("a failing save is logged instead of crashing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bat-state-"));
    const state = State.forDataDir(dir);
    fs.mkdirSync(path.join(dir, "state.json")); // rename onto a directory fails
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      state.setDataContext("1.1", "X", 1);
      assert.doesNotThrow(() => state.flush());
    } finally {
      console.error = original;
      state.release();
    }
    assert.match(errors.join("\n"), /failed to save state/);
  });
});
