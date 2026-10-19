#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Connector } from "./connector.js";
import { createHttpServer, isLoopback } from "./http.js";
import { createServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const useStdio = process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio";
  const connector = new Connector(config);

  const shutdown = () => {
    connector.stopRecorder();
    connector.state.saveNow();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!connector.betfairConfigured) {
    console.error("[betfair-ai-trading] Betfair credentials are not configured; only the prompt library tools will work.");
  }
  console.error(`[betfair-ai-trading] trading mode: ${connector.exchange.mode.toUpperCase()}`);
  connector.startRecorder();

  if (useStdio) {
    await createServer(connector).connect(new StdioServerTransport());
    return;
  }

  const { host, port, authToken } = config.http;
  if (!authToken && !isLoopback(host)) {
    throw new Error(
      `Refusing to listen on ${host} without MCP_AUTH_TOKEN: anyone reaching this server could trade on your Betfair account. Set MCP_AUTH_TOKEN (e.g. \`openssl rand -hex 32\`).`,
    );
  }
  const server = createHttpServer(connector);
  server.listen(port, host, () => {
    const shown = host.includes(":") ? `[${host}]` : host;
    console.error(`[betfair-ai-trading] MCP endpoint: http://${shown}:${port}/mcp${authToken ? "/<MCP_AUTH_TOKEN>" : ""}`);
  });
}

main().catch((error) => {
  console.error(`[betfair-ai-trading] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
