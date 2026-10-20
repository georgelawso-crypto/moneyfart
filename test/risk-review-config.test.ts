// Regression test from an independent review (low): BETFAIR_JURISDICTION is looked up in a plain object, so prototype keys
// ("constructor", "__proto__") pass the lookup and crash with a TypeError instead of the
// validation message. Startup still fails, so this is cosmetic.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";

describe("review: BETFAIR_JURISDICTION parsing", () => {
  for (const value of ["constructor", "__proto__"]) {
    test(`"${value}" is rejected with the validation message`, () => {
      assert.throws(() => loadConfig({ BETFAIR_JURISDICTION: value }), /BETFAIR_JURISDICTION must be AU/);
    });
  }
});
