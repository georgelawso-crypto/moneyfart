# Betfair AI Trading connector

An [MCP](https://modelcontextprotocol.io) connector that brings [StefanBelo/BetfairAiTrading](https://github.com/StefanBelo/BetfairAiTrading) to Claude.

BetfairAiTrading is a library of 120+ AI prompts for Betfair Exchange analysis and execution. The prompts are written for the [BFExplorer](http://bfexplorer.net/) desktop app's MCP server. This connector gives you the same tool surface (`GetActiveMarket`, `GetAllDataContextForMarket`, `ExecuteBfexplorerStrategySettings`, …), but talks to the **Betfair Exchange API directly**. It runs on any OS and can be deployed as a remote connector for claude.ai. The prompt library is bundled, so Claude can find and run those prompts unchanged.

```
Claude (claude.ai / Desktop / Code)
        │  MCP (Streamable HTTP or stdio)
        ▼
Betfair AI Trading connector ── prompt library (128 prompts, MIT, vendored)
        │  JSON-RPC
        ▼
Betfair Exchange API (markets, prices, orders, account)
```

It runs in **paper trading mode by default**. In paper mode, bets are matched against the live Betfair order book and settled with real results, but no money is used. Real-money betting needs `TRADING_MODE=live`.

## What you get

| Area | Tools |
| --- | --- |
| Markets | `FindMarkets`, `OpenMarket`, `GetActiveMarket`, `GetMarket`, `GetBetfairMonitoredMarkets`, `ActivateBetfairMarketSelection` |
| Data contexts | `GetAvailableDataContextProviders`, `GetAllDataContextForMarket`, `GetDataContextForMarketSelection`, `SetAIAgentDataContextForBetfairMarket` |
| Strategies | `GetAllBfexplorerStrategySettings`, `GetAllBfexplorerStrategyTemplates`, `GetBfexplorerStrategySetting`, `SaveBfexplorerStrategySettings`, `ExecuteBfexplorerStrategySettings`, `ExecuteBfexplorerStrategySettingsOnSelections`, `ExecuteBfexplorerStrategySettingsWithParameters` |
| Bets & account | `GetCurrentOrders` (with per-selection P/L positions), `CancelBets`, `GetAccountFunds`, `GetAllBetResults` (P/L, strike rate and ROI per strategy) |
| Prompt library | `SearchStrategyPrompts`, `GetStrategyPrompt`, plus every prompt as an MCP prompt and as a `betfair-prompts://` resource |
| Diagnostics | `GetConnectorStatus` |

Tool names, argument names and the `"<selectionId>_<handicap>"` selection id format (e.g. `"12345678_0.00"`) match BFExplorer, so the library prompts need no edits.

### Data contexts

| Context | Source |
| --- | --- |
| `HorsesBaseBetfairFormData` | Betfair runner metadata: form, official rating, weight, age, jockey, trainer, draw, days since last run, headgear, forecast price |
| `WeightOfMoneyData` | Full offered-price ladder: unmatched backers' vs layers' money, backing pressure (whole book and near book), VWAP, traded-price distribution |
| `MarketSelectionsTradedPricesData` | Start/end/min/max price, traded volume, VWAP, back/lay aggressor ratios estimated from recorded trades |
| `BetfairSpData` | Projected near/far SP, actual SP, SP stakes taken, forecast price (`industryStartingPrice`), EV of the better of price or SP |
| `MarketSelectionsPriceHistoryData` | Price history recorded while the market is monitored |
| `MarketSelectionsCandleStickData` | OHLC + volume candles built from the recorded history |
| *anything you store* | `SetAIAgentDataContextForBetfairMarket` stores JSON that `GetAllDataContextForMarket` can read back |

BFExplorer also offers contexts built from third-party feeds: Racing Post, Timeform, At The Races, Racing TV, OLBG, RacingStatto and Nigel's race data. The connector doesn't have those feeds. When a prompt asks for one, the connector reports it as unavailable and the rest of the call still succeeds. `SearchStrategyPrompts` marks each prompt `full` or `partial` and lists the missing contexts. `onlyFullySupported: true` filters the list down to the 42 prompts that work completely.

History-based contexts fill up while a market is monitored. `OpenMarket` starts recording, and the connector polls monitored markets every `RECORD_INTERVAL_SECONDS`. Open markets early to get richer candlesticks.

### Strategies

Strategy *settings* are named configurations of a *template*, as in BFExplorer:

| Template | What it does |
| --- | --- |
| Place Bet | One back or lay bet. Stake can be a stake, a liability or a bankroll %. Price is the best available or a limit price, with an optional tick offset, min/max odds and an in-play rule |
| Tick Offset | Trade: entry bet, then for the matched part an offset bet `ProfitTicks` better, sized to green up for an equal profit |
| Close Selection Bet Position / Close Market Bet Position | Cancel unmatched bets, then hedge (green up) at the best available price |
| Cancel Bets | Cancel unmatched bets on a selection or across the market |
| Dutching | Back several selections for equal profit or a fixed total stake |

Built-in settings: `Bet 10 Euro`, `Lay 10 Euro`, `Bet 2 Euro`, `Lay 2 Euro`, `Back Trade`, `Lay Trade`, `Close Selection Bet Position`, `Close Market Bet Position`, `Cancel Selection Bets`, `Cancel Market Bets`, `Dutch to profit 10 Euro`, `Dutch 10 Euro stake`. Stakes are in your account currency. Create your own with `SaveBfexplorerStrategySettings`, or override parameters per call with `ExecuteBfexplorerStrategySettingsWithParameters`.

### Safety

- Paper mode is the default. Live mode needs `TRADING_MODE=live`, and the server instructions then tell Claude to confirm bets with you unless you've asked for autonomous execution. The execute and cancel tools are marked destructive, so clients ask for approval.
- `MAX_STAKE` and `MAX_LIABILITY` reject any risk-adding bet over the limit. Hedge and offset bets are exempt because they reduce exposure.
- The HTTP server refuses to listen on a non-loopback address unless `MCP_AUTH_TOKEN` is set. On loopback it rejects foreign `Host` headers to block DNS rebinding.

## Setup

1. Get a Betfair **application key** ([developer.betfair.com](https://developer.betfair.com/); the free delayed key works for paper trading).
2. Install and build:

   ```bash
   npm install
   npm run build
   cp .env.example .env   # fill in BETFAIR_APP_KEY, BETFAIR_USERNAME, BETFAIR_PASSWORD
   ```

The connector reads its configuration from environment variables (see [.env.example](.env.example)). Without Betfair credentials, only the prompt-library tools work.

### Claude Code

```bash
claude mcp add betfair-ai-trading \
  -e BETFAIR_APP_KEY=... -e BETFAIR_USERNAME=... -e BETFAIR_PASSWORD=... \
  -- node /path/to/moneyfart/dist/index.js --stdio
```

### Claude Desktop

```json
{
  "mcpServers": {
    "betfair-ai-trading": {
      "command": "node",
      "args": ["/path/to/moneyfart/dist/index.js", "--stdio"],
      "env": {
        "BETFAIR_APP_KEY": "...",
        "BETFAIR_USERNAME": "...",
        "BETFAIR_PASSWORD": "...",
        "DATA_DIR": "/path/to/moneyfart/data"
      }
    }
  }
}
```

### claude.ai (remote custom connector)

Run the HTTP server somewhere Claude can reach over HTTPS, for example with Docker:

```bash
docker build -t betfair-ai-trading-connector .
docker run -d -p 3000:3000 -v betfair-data:/data \
  -e BETFAIR_APP_KEY=... -e BETFAIR_USERNAME=... -e BETFAIR_PASSWORD=... \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  betfair-ai-trading-connector
```

Put it behind HTTPS (any PaaS that runs containers: Fly.io, Render, Railway, a VPS with Caddy, …). Then in claude.ai go to **Settings → Connectors → Add custom connector** and use:

```
https://<your-host>/mcp/<MCP_AUTH_TOKEN>
```

The token in the path *is* the credential, so keep the URL private. Clients that support headers can instead use `https://<your-host>/mcp` with `Authorization: Bearer <MCP_AUTH_TOKEN>`.

> **Hosting region matters.** Betfair blocks API access from some countries, including the US. Run the connector in a region where Betfair is available to your account, e.g. London.

The HTTP transport is stateless Streamable HTTP. Market monitoring, the paper ledger and stored data contexts live in the process (and in `DATA_DIR` when set), so run **one long-lived instance**, not a serverless function.

## Using it

Ask Claude things like:

- "Find the next UK horse race and open it."
- "Run the Weight of Money analysis prompt on the active market."
- "Use the BetfairSpData favourite strategy on the 15:30 at Ascot, paper trading."
- "Show my paper P/L by strategy for the last 7 days."

A typical prompt run goes `FindMarkets` → `OpenMarket` → `GetActiveMarket` → `GetAllDataContextForMarket` → analysis → `ExecuteBfexplorerStrategySettings` → `GetAllBetResults` after the race.

## Limitations

- **No streaming bots.** Strategies run once when called. Anything that needs continuous monitoring after entry (stop losses, trailing stops, timed exits) isn't implemented. Offset bets rest on the exchange.
- **Paper fills are approximate.** Immediate fills take the displayed liquidity. Resting orders fill when the best price reaches them or the market trades through. Runner removals don't apply reduction factors, and commission is a flat `PAPER_COMMISSION_RATE` on net market winnings.
- **Settlement depends on Betfair still returning the closed market.** Betfair keeps returning closed markets for a limited time, so keep the connector running, or call `GetAllBetResults` / `GetCurrentOrders` after races finish.
- **Delayed app keys** give delayed prices (`isMarketDataDelayed: true` in market headers) and may omit traded volumes.

## Development

```bash
npm test            # unit + end-to-end tests against an in-memory fake Betfair API
npm run typecheck
npm run dev         # run from source (HTTP on 127.0.0.1:3000)
npm run sync-prompts  # refresh prompts/ from upstream BetfairAiTrading
```

Layout:

| Path | Purpose |
| --- | --- |
| `src/betfair/` | API client (interactive/certificate login, session refresh, JSON-RPC), types, price ladder |
| `src/markets.ts` | Market search, catalogue/book fetching, BFExplorer-style market views, price recording |
| `src/dataContexts.ts` | Data context providers |
| `src/exchange.ts` | Paper and live exchanges (placement, matching, settlement, funds) |
| `src/strategies.ts` | Strategy templates, settings and execution engine |
| `src/prompts.ts` | Prompt library loader, search and rendering |
| `src/server.ts` | MCP tools, prompts and resources |
| `src/http.ts`, `src/index.ts` | HTTP and stdio transports |

## Credits

The prompt library in [`prompts/`](prompts/) is vendored from [StefanBelo/BetfairAiTrading](https://github.com/StefanBelo/BetfairAiTrading) (MIT, © 2025 Stefan Belopotocan); see [prompts/SOURCE.md](prompts/SOURCE.md). BFExplorer is a separate product. This connector is independent of it and isn't affiliated with Betfair.

Betting involves financial risk. Test strategies in paper mode first.
