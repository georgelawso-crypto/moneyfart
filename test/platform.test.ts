import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, mock, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { PaperOrder } from "../src/exchange/paperTypes.js";
import { createServer } from "../src/server.js";
import { LOCK_RETRY_MS, State, type SettledMarket } from "../src/state.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bat-platform-"));
const lockOf = (dir: string) => path.join(dir, "state.lock");
const stateOf = (dir: string) => path.join(dir, "state.json");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const ago = (ms: number) => new Date(Date.now() - ms);
const foreignLock = (pid: number, token = "theirs") => JSON.stringify({ hostname: "other-container", pid, token, startedAt: new Date().toISOString() });

/** Run fn with console.error captured; returns what was logged. */
async function logsOf(fn: () => unknown): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

function paperOrder(betId: string): PaperOrder {
  return {
    betId,
    marketId: WIN_MARKET,
    selectionId: 101,
    handicap: 0,
    side: "BACK",
    price: 3,
    size: 2,
    fills: [{ price: 3, size: 2, at: new Date().toISOString() }],
    sizeCancelled: 0,
    sizeLapsed: 0,
    sizeVoided: 0,
    persistenceType: "LAPSE",
    placedDate: new Date().toISOString(),
    placedInPlay: false,
  };
}

function settledMarket(marketId: string): SettledMarket {
  return { marketId, marketName: "Race", settledAt: new Date().toISOString(), runners: [{ selectionId: 1, handicap: 0, name: "A", status: "Winner", bsp: 2 }] };
}

describe("DATA_DIR lock", () => {
  test("names its owner, is refreshed by a heartbeat and is respected while fresh", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const dir = tmpDir();
      const owner = State.forDataDir(dir);
      const record = readJson(lockOf(dir));
      assert.deepEqual(Object.keys(record).sort(), ["hostname", "pid", "startedAt", "token"]);
      assert.equal(record.pid, process.pid);
      assert.equal(record.hostname, os.hostname());
      const old = ago(10 * 60_000);
      fs.utimesSync(lockOf(dir), old, old);
      mock.timers.tick(30_000);
      assert.ok(Date.now() - fs.statSync(lockOf(dir)).mtimeMs < 10_000, "the heartbeat refreshed the lock");
      let second!: State;
      await logsOf(() => (second = State.forDataDir(dir)));
      assert.equal(second.readOnly, true);
      second.release();
      owner.release();
      assert.equal(fs.existsSync(lockOf(dir)), false);
    } finally {
      mock.timers.reset();
    }
  });

  test("a fresh lock with this process's PID belongs to someone else (containers all run as PID 1)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(lockOf(dir), foreignLock(process.pid));
    let state!: State;
    const logs = await logsOf(() => (state = State.forDataDir(dir)));
    assert.equal(state.readOnly, true);
    assert.match(state.readOnlyReason!, new RegExp(`pid ${process.pid} on other-container`));
    assert.match(logs, /will not save state or run bots/);
    state.release();
    assert.equal(readJson(lockOf(dir)).token, "theirs", "release never deletes another process's lock");
  });

  test("a lock that is still being written (empty) is held, not stale", async () => {
    const dir = tmpDir();
    fs.writeFileSync(lockOf(dir), "");
    let state!: State;
    await logsOf(() => (state = State.forDataDir(dir)));
    assert.equal(state.readOnly, true);
    state.release();
  });

  test("a lock nobody refreshed for two minutes is taken over, whatever its PID", () => {
    const dir = tmpDir();
    fs.writeFileSync(lockOf(dir), JSON.stringify({ hostname: os.hostname(), pid: process.ppid, token: "gone", startedAt: ago(3600_000).toISOString() }));
    fs.utimesSync(lockOf(dir), ago(3 * 60_000), ago(3 * 60_000));
    const state = State.forDataDir(dir);
    assert.equal(state.readOnly, false);
    const record = readJson(lockOf(dir));
    assert.equal(record.pid, process.pid);
    assert.notEqual(record.token, "gone");
    state.release();
    assert.equal(fs.existsSync(lockOf(dir)), false);
  });

  test("an owner whose lock was taken over stops saving instead of overwriting the new owner's file", async () => {
    const dir = tmpDir();
    const owner = State.forDataDir(dir);
    owner.setDataContext("1.1", "Analysis", { v: 1 });
    owner.flush();
    // Another container (same PID) took the lock over, e.g. after this process was suspended.
    fs.writeFileSync(lockOf(dir), foreignLock(process.pid));
    const logs = await logsOf(() => {
      owner.setDataContext("1.1", "Analysis", { v: 2 });
      owner.flush();
    });
    assert.equal(owner.readOnly, true);
    assert.match(logs, /taken DATA_DIR over/);
    assert.deepEqual(readJson(stateOf(dir)).dataContexts["1.1"].Analysis.data, { v: 1 });
    assert.equal(owner.ownsDataDir(), false);
    owner.release();
    assert.equal(readJson(lockOf(dir)).token, "theirs");
  });
});

describe("read-only takeover", () => {
  test("retries the lock and takes DATA_DIR over once the owner exits", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const dir = tmpDir();
      const owner = State.forDataDir(dir);
      let reader!: State;
      await logsOf(() => (reader = State.forDataDir(dir)));
      mock.timers.tick(LOCK_RETRY_MS);
      assert.equal(reader.readOnly, true, "the owner is still running");
      owner.release();
      const logs = await logsOf(() => mock.timers.tick(LOCK_RETRY_MS));
      assert.equal(reader.readOnly, false);
      assert.equal(reader.readOnlyReason, undefined);
      assert.match(logs, /now owns/);
      reader.release();
    } finally {
      mock.timers.reset();
    }
  });

  test("merges what the read-only process changed into the owner's last save", async () => {
    const dir = tmpDir();
    const owner = State.forDataDir(dir);
    owner.setDataContext("1.1", "Shared", { by: "owner, early" });
    owner.dataContexts.get("1.1")!.get("Shared")!.updatedAt = "2026-01-01T00:00:00.000Z";
    owner.setDataContext("1.1", "OwnerLater", { by: "owner, early" });
    owner.dataContexts.get("1.1")!.get("OwnerLater")!.updatedAt = "2026-01-01T00:00:00.000Z";
    owner.customStrategies.set("edited here", { name: "Edited here", template: "Place Bet", parameters: { Stake: 1 } });
    owner.customStrategies.set("edited there", { name: "Edited there", template: "Place Bet", parameters: { Stake: 1 } });
    owner.paper.orders.push(paperOrder("P1"));
    owner.paper.betCounter = 1;
    owner.changed();
    owner.flush();

    let reader!: State;
    await logsOf(() => (reader = State.forDataDir(dir)));
    assert.equal(reader.readOnly, true);
    assert.equal(reader.tryTakeOver(), false, "the owner still holds the lock");

    // Made while read-only.
    reader.setDataContext("1.1", "Shared", { by: "reader" });
    reader.setDataContext("1.2", "ReaderOnly", { by: "reader" });
    reader.customStrategies.set("edited here", { name: "Edited here", template: "Place Bet", parameters: { Stake: 2 } });
    reader.customStrategies.set("new here", { name: "New here", template: "Place Bet", parameters: { Stake: 5 } });
    reader.paper.orders.push(paperOrder("P2"));
    reader.paper.betCounter = 7;
    reader.archiveMarket(settledMarket("1.9"));
    const ref = reader.strategyRefFor("A strategy name longer than fifteen");
    assert.equal(fs.existsSync(stateOf(dir)) && readJson(stateOf(dir)).paper.orders.length, 1, "nothing was saved while read-only");

    // The owner keeps working, then exits.
    owner.setDataContext("1.1", "OwnerLater", { by: "owner, late" });
    owner.setDataContext("1.3", "OwnerOnly", { by: "owner" });
    owner.customStrategies.set("edited there", { name: "Edited there", template: "Place Bet", parameters: { Stake: 3 } });
    owner.paper.orders.push(paperOrder("P3"));
    owner.paper.betCounter = 3;
    owner.changed();
    owner.flush();
    owner.release();

    const logs = await logsOf(() => assert.equal(reader.tryTakeOver(), true));
    assert.match(logs, /merged 1 paper order\(s\), 2 AI data context\(s\) and 2 strategy setting\(s\)/);
    assert.equal(reader.readOnly, false);
    const saved = readJson(stateOf(dir));
    assert.deepEqual(saved.dataContexts["1.1"].Shared.data, { by: "reader" }, "the newest write wins");
    assert.deepEqual(saved.dataContexts["1.1"].OwnerLater.data, { by: "owner, late" }, "the newest write wins");
    assert.deepEqual(saved.dataContexts["1.2"].ReaderOnly.data, { by: "reader" });
    assert.deepEqual(saved.dataContexts["1.3"].OwnerOnly.data, { by: "owner" });
    const stakes = Object.fromEntries(saved.strategies.map((s: { name: string; parameters: { Stake: number } }) => [s.name, s.parameters.Stake]));
    assert.deepEqual(stakes, { "Edited here": 2, "Edited there": 3, "New here": 5 });
    assert.deepEqual(saved.paper.orders.map((o: PaperOrder) => o.betId).sort(), ["P1", "P2", "P3"]);
    assert.equal(saved.paper.betCounter, 7);
    assert.ok(saved.archive.some((m: SettledMarket) => m.marketId === "1.9"));
    assert.equal(saved.strategyRefs[ref], "A strategy name longer than fifteen");
    assert.deepEqual(reader.getDataContext("1.3", "OwnerOnly")!.data, { by: "owner" }, "memory holds the merged state");
    reader.release();
  });
});

describe("read-only takeover failures", () => {
  test("a takeover that cannot merge with state.json gives the lock back and saves nothing", async () => {
    const dir = tmpDir();
    const owner = State.forDataDir(dir);
    let reader!: State;
    await logsOf(() => (reader = State.forDataDir(dir)));
    reader.setDataContext("1.2", "Mine", 1);
    owner.release();
    const odd = JSON.stringify({ version: 2, paper: { note: "no orders array" } });
    fs.writeFileSync(stateOf(dir), odd);
    const logs = await logsOf(() => assert.equal(reader.tryTakeOver(), false));
    assert.match(logs, /could not take DATA_DIR over/);
    assert.equal(reader.readOnly, true);
    assert.equal(fs.existsSync(lockOf(dir)), false, "the lock was given back");
    reader.flush();
    assert.equal(fs.readFileSync(stateOf(dir), "utf8"), odd);
    reader.release();
  });
});

describe("state.json upgrades and damage", () => {
  test("a v1 state.json is backed up, and its AI contexts and custom strategy settings are migrated", async () => {
    const dir = tmpDir();
    const placeBetV1 = { BetType: "Lay", Stake: 4, StakeType: "Stake", Odds: 0, OddsOffsetTicks: 0, MinimumOdds: 1.01, MaximumOdds: 10, PersistenceType: "Persist", AllowPlacingBetInPlay: false };
    const tickOffsetV1 = { BetType: "Back", Stake: 10, StakeType: "Stake", Odds: 0, OddsOffsetTicks: 0, MinimumOdds: 1.01, MaximumOdds: 1000, PersistenceType: "Lapse", AllowPlacingBetInPlay: true, ProfitTicks: 3, ExitPersistenceType: "Lapse" };
    const v1 = {
      monitored: [{ marketId: "1.5", marketName: "2m Hcap", eventName: "Ascot", eventType: "Horse Racing", openedAt: "2026-09-01T10:00:00.000Z" }],
      activeMarketId: "1.5",
      dataContexts: { "1.5": { EVAnalysis: { data: { pick: "7" }, updatedAt: "2026-09-01T10:00:00.000Z" } } },
      strategies: [
        { name: "Mine", template: "Place Bet", parameters: placeBetV1, description: "my lay" },
        { name: "My trade", template: "Tick Offset", parameters: tickOffsetV1 },
        { name: "Odd trade", template: "Tick Offset", parameters: { ...tickOffsetV1, ExitPersistenceType: "Persist" } },
      ],
      paperOrders: [{ betId: "PV1", marketId: "1.5", selectionId: 7, handicap: 0, side: "BACK", price: 3, size: 2, sizeMatched: 2, averagePriceMatched: 3 }],
      paperSettlements: [],
      paperBetCounter: 1,
    };
    const text = JSON.stringify(v1);
    fs.writeFileSync(stateOf(dir), text);
    let state!: State;
    const logs = await logsOf(() => (state = State.forDataDir(dir)));

    assert.equal(fs.readFileSync(path.join(dir, "state.v1-backup.json"), "utf8"), text, "the v1 file is kept as it was");
    assert.deepEqual(state.getDataContext("1.5", "EVAnalysis"), { data: { pick: "7" }, updatedAt: "2026-09-01T10:00:00.000Z" });
    assert.deepEqual(state.customStrategies.get("mine"), {
      name: "Mine",
      template: "Place Bet",
      parameters: { BetType: "Lay", Stake: 4, StakeType: "Stake", Odds: 0, PriceImprovement: 0, MinimumOdds: 1.01, MaximumOdds: 10, AtInPlayKeepBet: true, AllowPlacingBetInPlay: false },
      description: "my lay",
    });
    assert.deepEqual(state.customStrategies.get("my trade")!.parameters, { BetType: "Back", Stake: 10, StakeType: "Stake", Odds: 0, AtInPlayKeepBet: false, Profit: 3 });
    assert.equal(state.customStrategies.has("odd trade"), false, "a setting v2 cannot express stays in the backup");
    assert.equal(state.monitored.size, 0, "v1 monitored entries have no catalogue");
    assert.match(logs, /Migrated 1 AI data context\(s\) and 2 custom strategy setting\(s\); not migrated: "Odd trade"/);
    assert.match(logs, /1 v1 paper order\(s\)/);
    assert.match(logs, /state\.v1-backup\.json/);

    state.flush();
    const saved = readJson(stateOf(dir));
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.dataContexts["1.5"].EVAnalysis.data, { pick: "7" });
    assert.deepEqual(saved.strategies.map((s: { name: string }) => s.name), ["Mine", "My trade"]);
    assert.equal(readJson(path.join(dir, "state.v1-backup.json")).paperOrders[0].betId, "PV1");
    state.release();
  });

  test("a state.json from an unknown (newer) version is copied aside, never silently overwritten", async () => {
    const dir = tmpDir();
    const text = JSON.stringify({ version: 3, everything: "new" });
    fs.writeFileSync(stateOf(dir), text);
    let state!: State;
    const logs = await logsOf(() => (state = State.forDataDir(dir)));
    assert.equal(fs.readFileSync(path.join(dir, "state.v3-backup.json"), "utf8"), text);
    assert.match(logs, /unknown connector version \(3\)/);
    state.release();
  });

  test("an unreadable state.json is moved aside and the connector starts empty instead of crash-looping", async () => {
    for (const content of ["", '{"version":2,"monit', "null", "[]"]) {
      const dir = tmpDir();
      fs.writeFileSync(stateOf(dir), content);
      let state!: State;
      const logs = await logsOf(() => (state = State.forDataDir(dir)));
      assert.equal(state.readOnly, false, JSON.stringify(content));
      assert.equal(state.dataContexts.size, 0);
      const aside = fs.readdirSync(dir).filter((f) => /^state\.corrupt-.+\.json$/.test(f));
      assert.equal(aside.length, 1, JSON.stringify(content));
      assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), content);
      assert.match(logs, /unreadable.*EMPTY state/s);
      state.setDataContext("1.1", "X", 1);
      state.flush();
      assert.equal(readJson(stateOf(dir)).version, 2);
      state.release();
    }
  });

  test("saves fsync the new file before renaming it over state.json", () => {
    const dir = tmpDir();
    const state = State.forDataDir(dir);
    const calls: string[] = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    mock.method(fs, "fsyncSync", (fd: number) => {
      calls.push("fsync");
      return fsync(fd);
    });
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      calls.push(`rename ${path.basename(String(to))}`);
      return rename(from, to);
    });
    try {
      state.setDataContext("1.1", "X", 1);
      state.flush();
    } finally {
      mock.restoreAll();
      state.release();
    }
    assert.deepEqual(calls.slice(0, 2), ["fsync", "rename state.json"]);
  });
});

describe("stored AI context limits", () => {
  test("names per market are capped, the least recently written dropped first", () => {
    const state = new State();
    for (let i = 0; i < 52; i++) state.setDataContext("1.1", `Analysis${i}`, { i });
    assert.equal(state.dataContexts.get("1.1")!.size, 50);
    assert.equal(state.getDataContext("1.1", "Analysis0"), undefined);
    assert.equal(state.getDataContext("1.1", "Analysis1"), undefined);
    state.setDataContext("1.1", "Analysis2", "rewritten");
    state.setDataContext("1.1", "New", 1);
    assert.deepEqual(state.getDataContext("1.1", "Analysis2")!.data, "rewritten", "a rewrite counts as recent");
    assert.equal(state.getDataContext("1.1", "Analysis3"), undefined);
  });

  test("the total size is capped by dropping the least recently written markets", () => {
    const state = new State(undefined, { maxTotalBytes: 3000 });
    const blob = "x".repeat(1000);
    state.setDataContext("1.1", "A", blob);
    state.setDataContext("1.2", "A", blob);
    state.setDataContext("1.1", "B", "y"); // 1.1 is now the most recently written
    state.setDataContext("1.3", "A", blob);
    assert.deepEqual([...state.dataContexts.keys()], ["1.1", "1.3"]);
    state.setDataContext("1.3", "A", "small"); // replacing frees its size
    state.setDataContext("1.4", "A", blob);
    assert.deepEqual([...state.dataContexts.keys()], ["1.1", "1.3", "1.4"]);
  });

  test("a single context over 1 MB, or an overlong name, is refused with a clear error", () => {
    const state = new State();
    assert.throws(() => state.setDataContext("1.1", "Big", { text: "x".repeat(1_000_000) }), /larger than 1 MB.*Nothing was stored/);
    assert.equal(state.getDataContext("1.1", "Big"), undefined);
    assert.throws(() => state.setDataContext("1.1", "N".repeat(201), 1), /limited to 200 characters/);
  });
});

describe("read-only connector process", () => {
  const env = { TRADING_MODE: "live", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0" };
  const sel101 = [{ selectionId: 101, handicap: 0 }];
  const placeOrders = (fake: FakeBetfair) => fake.calls.filter((c) => c.method === "placeOrders").length;

  /** An owner with a delayed bet that is now due, and a second process on the same DATA_DIR. */
  async function pair() {
    const dir = tmpDir();
    const config = loadConfig({ ...env, DATA_DIR: dir });
    const ownerFake = new FakeBetfair();
    const owner = new Connector(config, ownerFake, State.forDataDir(dir));
    const started = await owner.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101, { PlaceBetTimeSpan: "-0:25:00" });
    assert.equal(started.outcome, "Started", JSON.stringify(started));
    owner.state.bots[0].meta!.placeAt = Date.now() - 1000;
    owner.state.changed();
    owner.state.flush();
    const fake = new FakeBetfair();
    let reader!: Connector;
    await logsOf(() => (reader = new Connector(config, fake, State.forDataDir(dir))));
    return { owner, ownerFake, reader, fake };
  }

  test("does not tick the owner's bots, and runs them once it has taken DATA_DIR over", async () => {
    const { owner, reader, fake } = await pair();
    assert.equal(reader.state.readOnly, true);
    assert.equal(reader.bots.list({ status: "running" }).length, 1, "the owner's bot is visible");
    await reader.botTick();
    assert.equal(placeOrders(fake), 0, "a second process must not place the owner's delayed bet");

    owner.shutdown();
    await logsOf(() => assert.equal(reader.state.tryTakeOver(), true));
    await reader.botTick();
    assert.equal(placeOrders(fake), 1, "the bot resumes in the new owner");
    reader.shutdown();
  });

  test("refuses strategies that start a bot before placing anything; plain bets still run", async () => {
    const { owner, reader, fake } = await pair();
    for (const [name, overrides] of [
      ["Trade x profit", {}],
      ["Trailing Stop Loss 3 Ticks", {}],
      ["Back trailing stop loss trading", {}],
      ["Close Selection Bet Position", { ClosePositionImmediately: false }],
      ["Bet 10 Euro", { PlaceBetTimeSpan: "-0:25:00" }],
    ] as const) {
      const result = await reader.executeStrategy(name, WIN_MARKET, sel101, overrides);
      assert.equal(result.status, false, name);
      assert.equal(result.outcome, "Failed");
      assert.match(result.message!, /starts a bot, so nothing was executed.*read-only.*Bots run only in the process that owns DATA_DIR/s);
    }
    assert.equal(placeOrders(fake), 0);
    assert.equal(reader.state.bots.length, 1, "no bot was added");

    const now = await reader.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101);
    assert.equal(now.status, true, JSON.stringify(now));
    const past = await reader.executeStrategy("Bet 10 Euro", WIN_MARKET, sel101, { PlaceBetTimeSpan: "-0:35:00" });
    assert.equal(past.status, true, "a PlaceBetTimeSpan already passed places the bet now");
    assert.equal(placeOrders(fake), 2);

    // The engine itself cannot register a bot here either.
    const direct = await reader.strategies.execute("Bet 10 Euro", WIN_MARKET, sel101, { PlaceBetTimeSpan: "-0:25:00" });
    assert.equal(direct.status, false);
    assert.match(direct.message!, /read-only/);
    assert.equal(reader.state.bots.length, 1);
    owner.shutdown();
    reader.shutdown();
  });

  test("tool results carry a read-only warning; stop_bot is refused; status says bots do not run here", async () => {
    const { owner, reader } = await pair();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(reader, {}).connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

    const trade = await call("execute_strategy_settings", { strategyName: "Trade x profit", marketId: WIN_MARKET, selectionId: "101" });
    assert.equal(JSON.parse(trade.content[0].text).status, false);
    assert.match(trade.content[1].text, /^WARNING: this connector process is read-only/);
    const stored = await call("set_ai_agent_data_context_for_market", { marketId: WIN_MARKET, dataContextName: "EV", jsonData: { pick: 1 } });
    assert.equal(JSON.parse(stored.content[0].text).status, true);
    assert.match(stored.content[1].text, /kept in memory only/);
    const read = await call("get_bots");
    assert.equal(read.content.length, 1, "read-only tools carry no warning");
    const stop = await call("stop_bot", { botId: reader.state.bots[0].id, closePosition: true });
    assert.equal(stop.isError, true);
    assert.match(stop.content[0].text, /Bots run only in the process that owns DATA_DIR/);
    assert.equal(reader.state.bots[0].status, "running");
    const status = JSON.parse((await call("get_connector_status")).content[0].text);
    assert.equal(status.botsRunInThisProcess, false);
    assert.equal(status.persistence, "file (read-only)");
    assert.match(status.readOnly, /in use by another connector process/);
    await client.close();
    owner.shutdown();
    reader.shutdown();
  });
});
