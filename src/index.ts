#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JURISDICTIONS, checkLiveSafety, loadConfig } from "./config.js";
import { Connector } from "./connector.js";
import { checkHttpSecurity, createHttpServer } from "./http.js";
import { createServer } from "./server.js";

const log = (message: string) => console.error(`[betfair-ai-trading] ${message}`);

async function main() {
  const config = loadConfig();
  const useStdio = process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio";
  checkLiveSafety(config);
  if (!useStdio) checkHttpSecurity(config);

  const connector = new Connector(config);
  let stopped = false;
  const shutdown = (code = 0) => {
    if (!stopped) {
      stopped = true;
      connector.shutdown();
    }
    process.exit(code);
  };
  // Synchronous save on any exit path (natural drain after stdin EOF, process.exit, signals).
  process.on("exit", () => {
    if (!stopped) {
      stopped = true;
      connector.shutdown();
    }
  });
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`));

  if (!connector.betfairConfigured) log("Betfair credentials are not configured; only the prompt library tools will work.");
  log(`trading mode: ${connector.exchange.mode.toUpperCase()}, Betfair: ${JURISDICTIONS[config.betfair.jurisdiction].label}, tool names: ${config.output.toolNames}`);
  const t = config.trading;
  log(
    `risk limits: stake ${t.maxStake}, liability ${t.maxLiability} per bet; ${t.maxMarketLiability} per market; ${t.maxTotalExposure} open in total; ` +
      `daily loss ${t.dailyLossLimit}${connector.killSwitch() ? "; KILL SWITCH ENGAGED (no new risk)" : ""}`,
  );
  connector.start();

  if (useStdio) {
    const transport = new StdioServerTransport();
    transport.onclose = () => shutdown(0);
    process.stdin.on("end", () => shutdown(0));
    await createServer(connector).connect(transport);
    return;
  }

  const { host, port, authToken } = config.http;
  const server = createHttpServer(connector);
  server.listen(port, host, () => {
    const shown = host.includes(":") ? `[${host}]` : host;
    log(`MCP endpoint: http://${shown}:${port}/mcp${authToken ? "/<MCP_AUTH_TOKEN>" : ""}`);
  });
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
