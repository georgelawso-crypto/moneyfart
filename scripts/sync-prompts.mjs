#!/usr/bin/env node
// Vendors the prompt library (docs/Prompts) from StefanBelo/BetfairAiTrading into ./prompts.
//
//   node scripts/sync-prompts.mjs                 # shallow-clone the upstream repo
//   node scripts/sync-prompts.mjs /path/to/clone  # use an existing checkout
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "https://github.com/StefanBelo/BetfairAiTrading.git";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "prompts");

let checkout = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
let tempDir;
if (!checkout) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betfair-ai-trading-"));
  checkout = path.join(tempDir, "repo");
  execFileSync("git", ["clone", "--depth", "1", UPSTREAM, checkout], { stdio: "inherit" });
}

try {
  const source = path.join(checkout, "docs", "Prompts");
  if (!fs.existsSync(source)) throw new Error(`${source} does not exist`);
  const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  fs.rmSync(target, { recursive: true, force: true });
  let count = 0;
  const copy = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) copy(from);
      else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
        const to = path.join(target, path.relative(source, from));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        count++;
      }
    }
  };
  copy(source);
  fs.copyFileSync(path.join(checkout, "LICENSE"), path.join(target, "LICENSE"));
  fs.writeFileSync(
    path.join(target, "SOURCE.md"),
    [
      "# Prompt library source",
      "",
      `These ${count} prompts are vendored from [StefanBelo/BetfairAiTrading](https://github.com/StefanBelo/BetfairAiTrading/tree/${commit}/docs/Prompts)`,
      `at commit \`${commit}\`, under the MIT license in [LICENSE](LICENSE) (Copyright (c) 2025 Stefan Belopotocan).`,
      "",
      "Refresh with `npm run sync-prompts`.",
      "",
    ].join("\n"),
  );
  console.log(`Vendored ${count} prompts from ${commit}`);
} finally {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}
