// Regression test from a third independent review (medium): KillSwitchStore.get() reads any error other than ENOENT as "engaged". That is
// the safe answer for new bets, but the owner's botTick (every BOT_INTERVAL_SECONDS) and riskCheck
// act on it by stopping every running bot (connector.ts stopBotsIfKilled -> bots.stopAll), which is
// permanent: once the read error clears the switch is off again, yet the bots stay stopped and their
// positions are left unmanaged (no stop-loss, no close before the off - for an Australian sport
// position, the last chance to close it at all). Two failed reads in a row (botTick's and
// stopBotsIfKilled's) are enough, e.g. EMFILE for a moment or a DATA_DIR on a flaky network share.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe("review 3: a transient kill switch read error", () => {
  test("stops every bot for good, although nobody engaged the switch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bat-review3-ks-"));
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir }), new FakeBetfair());
    try {
      const started = await c.executeStrategy("Lay Trade", WIN_MARKET, [{ selectionId: 101, handicap: 0 }]);
      assert.equal(started.outcome, "Started", JSON.stringify(started));

      const readFileSync = fs.readFileSync;
      let failures = 2;
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(file).endsWith("kill-switch.json") && failures-- > 0) throw Object.assign(new Error("EMFILE: too many open files, open"), { code: "EMFILE" });
        return (readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
      }) as typeof fs.readFileSync;
      try {
        await quietly(() => c.botTick());
      } finally {
        (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = readFileSync;
      }

      assert.equal(c.killSwitch(), undefined, "the switch was never engaged");
      const [bot] = c.bots.list();
      assert.equal(bot.status, "running", `bot ${bot.id} is ${bot.status}: ${bot.log.map((l) => l.message).slice(-1)[0]}; its position is no longer managed`);
    } finally {
      c.shutdown();
    }
  });
});
