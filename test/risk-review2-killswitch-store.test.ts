// Regression test from a second independent review (high): KillSwitchStore.engage() starts with get(), which reads kill-switch.json. A
// read error other than ENOENT (EMFILE, EIO, EACCES on DATA_DIR...) makes get() report a synthetic
// "counts as engaged" state, and engage() returns it as the result WITHOUT setting the in-memory flag
// or writing the file ("if (current) return current"). The engage call reports success (no fileError,
// so no warning note), but once the read error clears the file is still absent: get() reads ENOENT,
// clears memory, and the switch is off again with nobody having released it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Connector } from "../src/connector.js";
import type { OrderRequest } from "../src/exchange/types.js";
import { FakeBetfair, WIN_MARKET } from "./fakeBetfair.js";

const TAG = { name: "test", ref: "test" };

function order(selectionId: number, side: "BACK" | "LAY", price: number, size: number): OrderRequest {
  return { selectionId, handicap: 0, side, price, size, persistenceType: "LAPSE" };
}

describe("review 2: a transient read error while engaging the kill switch", () => {
  test("EMFILE on the first read: engage reports success, then the switch is off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bat-review2-ks-"));
    const c = new Connector(loadConfig({ BETFAIR_JURISDICTION: "com", RECORD_INTERVAL_SECONDS: "0", BOT_INTERVAL_SECONDS: "0", DATA_DIR: dir }), new FakeBetfair());
    const readFileSync = fs.readFileSync;
    let failures = 1;
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).endsWith("kill-switch.json") && failures-- > 0) throw Object.assign(new Error("EMFILE: too many open files, open"), { code: "EMFILE" });
      return (readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync;
    let report: Awaited<ReturnType<Connector["engageKillSwitch"]>>;
    try {
      report = await c.engageKillSwitch("losing too fast");
    } finally {
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = readFileSync;
    }

    const [bet] = await c.exchange.placeOrders(WIN_MARKET, [order(101, "BACK", 3.0, 10)], TAG);
    c.shutdown();
    assert.equal(
      bet.status,
      "FAILURE",
      `engage returned ${JSON.stringify(report.killSwitch)} (notes: ${report.notes.length}, file written: ${fs.existsSync(path.join(dir, "kill-switch.json"))}); ` +
        `a new 10 back was then placed (${bet.status}, matched ${bet.sizeMatched})`,
    );
  });
});
