# Betfair AI Trading connector

An [MCP](https://modelcontextprotocol.io) connector that brings [StefanBelo/BetfairAiTrading](https://github.com/StefanBelo/BetfairAiTrading) to Claude.

BetfairAiTrading is a library of 120+ prompts for analysing and trading Betfair Exchange markets. The prompts are written for the MCP server inside the [BFExplorer](http://bfexplorer.net/) desktop app (Windows, paid). This connector **reverse-engineers that server** and reimplements it on the **Betfair Exchange API**. It runs on any OS, locally or as a remote claude.ai connector, and the prompt library is bundled.

```
Claude (claude.ai / Desktop / Code)
        │  MCP: Streamable HTTP (per-session) or stdio
        ▼
Betfair AI Trading connector
  ├─ BFExplorer tools (snake_case, TOON/JSON outputs as recorded)
  ├─ trade recorder ─► candles, price history, weight of money, ...
  ├─ strategy engine + bots (profit/loss targets, trailing stops, timed closes)
  ├─ paper exchange (live order book, real results) │ live exchange
  └─ prompt library (126 prompts, MIT, vendored)
        │  JSON-RPC
        ▼
Betfair Exchange API
```

It runs in **paper trading mode by default**: bets are matched against the live Betfair order book and settled with real results, without real money. Live mode needs `TRADING_MODE=live`.

## How the reverse engineering was done

BFExplorer is closed source. Its MCP behaviour was rebuilt from evidence in the upstream repository, with every claim graded by source:

- recorded agent sessions containing BFExplorer's real tool calls and outputs,
- captured data-context JSON files and F#/C# SDK examples,
- decoded `.bots` strategy files and the author's calibration logs,
- the field contracts that 126 prompts rely on,
- BFExplorer's changelog.

Where sources disagreed, the newest recorded output won. Some examples of what that settled:

| Question | Answer from the recordings |
| --- | --- |
| Tool names | Current BFExplorer exposes snake_case names (`get_active_market`, `execute_strategy_settings_with_parameters`, …). The PascalCase names in most prompts are older names for the same tools. |
| Market tool output | TOON text such as `activeBetfairMarket:` with `selections[N]{selectionId,name,price,totalMatched,status}`. `price` is the **last traded price**. Strings containing spaces are always quoted. Rows are sorted by price before the off and keep that order in-play. |
| Selection ids | Plain strings such as `"98427997"` since 2026; the old `"id_0.00"` form is still accepted on input. |
| Data contexts | JSON `{market:{6 keys}, selectionsData:[{selectionId, name, data}], data}`. Each provider writes its own keys into `data`, e.g. `candleStickData` + `vwaPrice` + `backLayRatio`. |
| Candles | Each 5-minute window starts at the first trade at least 300 s after the previous window, open = previous close, only the last 12 windows. Verified across 715 transitions. |
| "Trade x profit" | Template "Place Bet and Close Selection Bet Position", driven with dotted parameters such as `{"OpenBetPosition.BetType":"Lay","CloseBetPosition.Profit":9}`. The profit is a percentage of the opening risk. |

The connector reproduces these behaviours, and the TOON encoder matches BFExplorer's recorded text byte for byte.

## Tools

The 24 BFExplorer tools are listed below; `execute_console_script`, which runs F# inside BFExplorer, cannot be reproduced. `TOOL_NAMES=snake` (the default) registers the current names. `legacy` registers the PascalCase names the prompts use, and `both` registers both. The server instructions and each prompt's notes map one naming style to the other.

| Tool (legacy name) | What it does |
| --- | --- |
| `get_active_market` (GetActiveMarket) | Active market as TOON. Takes an optional `marketId` so a conversation can stay pinned to its own race. |
| `get_market` (GetMarket) | Any market as TOON. It also works after settlement, when runners show Winner/Loser. |
| `get_monitored_markets` (GetBetfairMonitoredMarkets) | Markets being monitored and recorded |
| `open_market` (OpenMarket) | Start monitoring a market and make it active |
| `activate_market_selection` (ActivateBetfairMarketSelection) | Set the active market/selection; later calls can then omit their ids |
| `get_available_data_context_providers` | Available, partial and BFExplorer-only providers with their data keys |
| `get_all_data_context_for_market` / `get_data_context_for_market_selection` / `get_data_context` | Data contexts in BFExplorer's envelope |
| `set_ai_agent_data_context_for_market` (SetAIAgentDataContextForBetfairMarket) | Store the agent's JSON analysis for a market |
| `get_ai_agent_data_context_feedback` | Stored analyses across settled markets, joined with winners, BSP and your profit |
| `get_all_strategy_settings`, `get_strategy_setting`, `get_all_strategy_templates`, `get_strategy_template`, `create_strategy_settings` | Strategy settings and templates |
| `execute_strategy_settings` / `_on_selections` / `_with_parameters` (ExecuteBfexplorerStrategySettings…) | Run a strategy. Results start with `{"status":true\|false, …}` as in BFExplorer, followed by details. `status` is false whenever nothing was placed because a condition was not met (odds range, no price, limits, minimum bet), so a prompt cannot report a bet that never happened. Genuine no-ops, such as closing an already flat position, return true with a message. |
| `get_all_bet_results` | Settled bets grouped like BFExplorer (`betResults` → `selectionsBets` → bets), plus totals, commission and per-strategy ROI |
| `get_my_favourite_bet_events` / `…_markets` | BFExplorer's default bet-event groups (GB/IE racing, football, in-play tennis, …) |
| `get_application_commands` / `execute_application_command` | RecordNow, StopAllBots, RemoveClosedMarkets, ClearActiveMarket, RetryBetfairLogin |

Tools that only this connector has:

| Tool | What it does |
| --- | --- |
| `find_markets` | Search markets. In-play events and outrights are included, and each result has status and in-play flags. |
| `get_market_details` | Rich JSON view: best prices and sizes, bet delay, minutes to start, book % |
| `get_current_orders` | Unsettled bets and each selection's position. BFExplorer has no position readback. |
| `cancel_bets` | Cancel specific bets, or everything with an explicit `all:true` |
| `get_account_funds` | Balance and exposure |
| `get_bots` / `stop_bot` | Inspect or stop the bots that manage trading positions |
| `save_strategy_settings` / `delete_strategy_settings` | Update custom settings. Overwriting a built-in needs `overwrite:true`. |
| `get_connector_status` | Mode, limits, Betfair login and connectivity, delayed-key detection |
| `search_strategy_prompts` / `get_strategy_prompt` | Search and load library prompts, with compatibility notes |

The 126 prompts are also exposed as MCP prompts and as `betfair-prompts://` resources. BFExplorer's four MCP resources (`bfexplorer://activeBetfairMarket` etc.) are provided too.

## Data contexts

| Provider | Data keys | Notes |
| --- | --- | --- |
| MarketSelectionsCandleStickData | `candleStickData`, `vwaPrice`, `backLayRatio` | BFExplorer's 5-minute candle algorithm, built from trades recorded since `open_market`. `vwaPrice` uses the whole traded ladder, so it is available immediately. |
| MarketSelectionsPriceHistoryData | `timePriceVolumes` | One row per recorded trade, with that trade's own volume |
| MarketSelectionsTradedPricesData | `tradedPricesData` | Start/end/min/max price, volume since monitoring began, back/lay ratios |
| MarketSelectionsPriceMetricData | `priceMetricsData` | Hourly OHLC + VWAP, the last 2 hours |
| WeightOfMoneyData | `averageBackTraded`, `averageLayTraded`, `offeredPrices` (`betType` Back/Lay), `tradedPrices`, `weightOfMoneySummary` | Full ladder depth |
| BetfairSpData | `price`, `betfairSP`, `industryStartingPrice`, `eVforPriceOrBetfairSP`, … | |
| HorsesBaseBetfairFormData | `forecastPrice`, `form`, `officialRating`, `weight` (lbs), … | |
| HorseRacingWinToBePlacedData | `winToBePlacedData` + market `placeMarket` | Finds and records the sibling PLACE market |
| HorsesBetfairRaceInfoData *(partial)* | `horseDetail {age, gender, pastRaces, weight}` | `pastRaces` covers only races this connector saw settle |

Several BFExplorer providers need third-party feeds the connector doesn't have: Racing Post, Timeform, At The Races, Racing TV, OLBG, RacingStatto, Nigel's race data, BFExplorer's own databases and live scores. These come back under `unavailableDataContexts` with a reason, and the rest of the call still succeeds. `search_strategy_prompts` marks each prompt `full` or `partial` and lists the missing tools and data. 43 prompts run fully.

How each part of the trade data is reconstructed:

- **Trades:** diffs of Betfair's traded-volume ladder (EX_TRADED) between polls.
- **Who initiated a trade:** a print at or below the previous best back price was a backer; at or above the best lay price, a layer.
- **Polling:** monitored markets are polled every `RECORD_INTERVAL_SECONDS`, and markets with running bots every `BOT_INTERVAL_SECONDS`.
- **History depth:** BFExplorer reads history from Betfair's website, so its history starts earlier. Here, history starts at `open_market`, so open markets early.
- **Delayed app keys:** these return no traded volume. Candles then come from price changes, and volume-based fields are omitted.

## Strategies and bots

| Template | Notes |
| --- | --- |
| Place Bet | `BetType`, `Stake`, `StakeType` (Stake/Liability/Payout/BankrollPercentage), `Odds`, `PriceImprovement`, `OfferMyBet`, `Minimum/MaximumOdds`, `Minimum/MaximumOddsDifference`, `AllowPlacingBetInPlay`, `AtInPlayKeepBet`, `PlaceBetTimeSpan` (placed later by a bot), `SortSelectionsBy` + `ExecuteOnSelection`, `StrategyReference` |
| Place Bet - Fill or Kill | Cancels whatever is unmatched after `BetMatchingTimeout` |
| Place Bet and Close Selection Bet Position | Entry, then a bot closes on the `CloseBetPosition` target: Money, Ticks or Percentage profit or loss, a close time such as `ClosePositionTimeSpan: "-0:00:05"`, or immediately. Unfilled closing bets are re-priced. |
| Close Selection / Close Market Bet Position | Green up now, or with a bot on targets. Refuses when unmatched opposite bets could over-hedge. |
| Tick Offset, Trailing Stop Loss | |
| Place Dutching Bets | RequiredProfit / TotalStake. All legs are checked before anything is placed; nothing is placed if any leg fails. |
| Cancel Bets, Sequence Execution | |

Built-in settings carry the names the prompts use:

- **Fixed-stake bets:** Bet 10 Euro, Lay 10 Euro, Back 2 Euro, Lay 2 Euro, Bet 10 Euro Fill or Kill.
- **Trading:** Trade x profit, Trade 20% profit, Trade 5/3 ticks, Trade 2 Ticks Profit or 10 Ticks Loss, Trading Strategy, Back/Lay Trade.
- **Trailing stops:** Trailing Stop Loss 3 Ticks, Back trailing stop loss trading.
- **Position management:** Close Selection/Market Bet Position, Cancel Selection/Market Bets.
- **Dutching:** Dutch to profit 10 Euro (profit target), Dutch for 10 Euro and Dutch 10 Euro stake (total stake).
- **Candlestick-prompt trades:** Back scalping strategy, Back hedge strategy, Conservative back strategy, Technical back strategy, Lay fade strategy, Lay resistance trading, Conservative lay strategy, Steam momentum trading, Drift momentum trading.

Stakes are in your account currency.

Parameters can be flat, dotted (`OpenBetPosition.Stake`) or nested objects. Unknown parameter names reject the execution before any bet is placed; BFExplorer silently ignores them. The one exception is `PressureInfo`, a reporting-only field one bundled prompt adds to its parameter JSON, which is ignored.

How the trading templates behave:

- **Targets win:** a profit, loss or close-time target takes precedence over `ClosePositionImmediately`.
- **Close Selection Bet Position:** given targets, it starts a bot instead of closing at once.
- **Bots don't over-hedge:** a bot counts resting closing bets from anyone (other bots, manual closes) before it hedges.
- **Restart-safe:** each bet's `customerOrderRef` is saved before it is sent, and any unconfirmed bet is reconciled first after a restart, so nothing is placed twice.
- **Fill or Kill:** if the cancel can't be confirmed, the result says the bet may still be resting.

## Paper trading

Paper mode aims to keep paper results honest, so a strategy shouldn't look profitable only because the simulator is generous:

- **Immediate matching:** orders match against the live ladder, best price first. Liquidity the simulator has already used can't be matched again.
- **Resting orders:** fill only on evidence (the book crossing them, or traded volume beyond the queue ahead of them), never from a stale last traded price.
- **In-play and timing:** in-play orders wait out the bet delay. Pre-off LAPSE orders lapse at the off.
- **Non-runners:** bets on the removed runner are voided, unmatched bets are cancelled, and earlier bets on other runners get the reduction factor.
- **Account rules:** Betfair's minimum bet size and payout rule and a funds check apply. Commission uses each market's base rate (`PAPER_COMMISSION_RATE` is the fallback).
- **Settlement:** uses real results, including dead heats. Markets that close while the connector isn't watching are settled on the next poll.
- **Out-of-order snapshots:** a market snapshot older than one already processed is ignored, so a stale book can't create a phantom fill.
- **Undatable volume:** traded volume that can't be dated relative to the off or a non-runner removal is not credited to orders.

## Safety

- **Paper by default.** In live mode the server instructions tell Claude to confirm bets unless you asked for autonomous execution. Library prompts that place bets are flagged and carry the same note.
- **Limits:** `MAX_STAKE` and `MAX_LIABILITY` apply to every risk-adding bet, including dutch totals. Closing bets are exempt but sized exactly, and they never reverse a position.
- **Idempotent live orders:** each order carries a `customerRef` and `customerOrderRef`. A timeout is checked against Betfair before anything is reported, and an unconfirmed bet is reported as `UNKNOWN` rather than "failed", so the model won't double-bet.
- **Betfair login:**
  - after a failed login the connector stops trying until `RetryBetfairLogin`, so a wrong password can't lock your account;
  - a temporary ban blocks logins for 20 minutes;
  - network errors back off exponentially;
  - keepAlive renews the session.
- **HTTP:**
  - a token is required, unless you explicitly opt in to an unauthenticated loopback server in paper mode;
  - browser `Origin`s are refused unless allowlisted;
  - unauthenticated requests carrying proxy headers are refused;
  - the `Host` header is checked on loopback binds;
  - each conversation gets its own MCP session and its own active market.
- **Persistence:** `DATA_DIR` holds the paper ledger, AI contexts, custom settings, bots and settled results.
  - **Lock:** one process owns `DATA_DIR`. Its lock has a heartbeat and is considered stale after 2 minutes, which also works for containers sharing a volume.
  - **Second process:** it runs read-only and never runs bots. It takes over, merging its changes, when the owner exits.
  - **Safe saves:** saves are fsynced and atomic and happen on every exit path. A corrupt or older-version state file is backed up, never overwritten.
  - **Limits:** stored AI contexts are capped at 1 MB each, 50 names per market and 50 MB in total.

## Setup

1. Get a Betfair **application key** from [developer.betfair.com](https://developer.betfair.com/). A delayed key works for paper trading, with delayed prices and no traded volumes. It can also place real bets.
2. `npm install && npm run build`, then copy `.env.example` to `.env` and fill it in.

**Claude Code**

```bash
claude mcp add betfair-ai-trading \
  -e BETFAIR_APP_KEY=... -e BETFAIR_USERNAME=... -e BETFAIR_PASSWORD=... -e DATA_DIR=$HOME/.betfair-ai-trading \
  -- node /path/to/moneyfart/dist/index.js --stdio
```

**Claude Desktop**: add the same command under `mcpServers` in `claude_desktop_config.json`, with `"args": ["/path/to/moneyfart/dist/index.js", "--stdio"]` and the variables under `"env"`.

**claude.ai (remote custom connector)**

```bash
docker build -t betfair-ai-trading-connector .
docker run -d --restart unless-stopped -p 3000:3000 -v betfair-data:/data \
  -e BETFAIR_APP_KEY=... -e BETFAIR_USERNAME=... -e BETFAIR_PASSWORD=... \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) betfair-ai-trading-connector
```

Serve it over HTTPS, then go to **Settings → Connectors → Add custom connector** and use `https://<host>/mcp/<MCP_AUTH_TOKEN>`. The token in the path is the credential, so keep the URL private. Clients that can send headers can use `/mcp` with `Authorization: Bearer <token>` instead.

Things to know about hosting:

- **Region:** Betfair blocks API access from some countries, including the US, so host somewhere Betfair is available to you (e.g. London).
- **One long-lived instance:** run a single always-on process, not serverless. Monitoring, bots and sessions live in the process.

**Existing BFExplorer clients:** `BFEXPLORER_COMPAT=1` serves MCP at `/` on port 10043, the way fast-agent, LM Studio and the upstream C#/Python agents expect.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BETFAIR_APP_KEY`, `BETFAIR_USERNAME`, `BETFAIR_PASSWORD` | | Credentials (or `BETFAIR_SESSION_TOKEN`) |
| `BETFAIR_CERT_FILE`, `BETFAIR_KEY_FILE` | | Non-interactive (certificate) login |
| `BETFAIR_API_URL`, `BETFAIR_IDENTITY_URL` | .com endpoints | Other jurisdictions (.it, .es) |
| `BETFAIR_KEEPALIVE_MINUTES` | 240 (10 on .it/.es) | Session keepAlive interval |
| `TRADING_MODE` | `paper` | `live` places real-money bets |
| `MAX_STAKE`, `MAX_LIABILITY` | 25, 250 | Per-bet limits on risk-adding bets |
| `PAPER_STARTING_BALANCE`, `PAPER_COMMISSION_RATE`, `PAPER_CURRENCY` | 1000, 0.05, GBP | Paper account (commission rate is the fallback when a market's base rate is unknown) |
| `MIN_BET_SIZE`, `MIN_BET_PAYOUT` | per currency | Override Betfair's minimum bet rules |
| `RECORD_INTERVAL_SECONDS`, `BOT_INTERVAL_SECONDS` | 30, 5 | Polling of monitored markets / markets with bots |
| `MAX_MONITORED_MARKETS`, `MAX_RECORDED_MARKETS`, `MAX_TRADES_PER_SELECTION` | 20, 60, 5000 | Memory bounds |
| `TOOL_NAMES` | `snake` | `snake`, `legacy` (PascalCase) or `both` |
| `DISPLAY_TIMEZONE` | Europe/London | Zone for data-context times (BFExplorer uses the host's local zone) |
| `BFEXPLORER_STRICT` | off | Drop connector additions (e.g. `inPlay` in market TOON) |
| `DATA_DIR` | | Persistence directory |
| `MCP_AUTH_TOKEN`, `HOST`, `PORT` | , 127.0.0.1, 3000 | HTTP transport |
| `MCP_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call the server |
| `MCP_MAX_SESSIONS` | 100 | Concurrent HTTP MCP sessions (least recently used evicted; idle sessions expire after 30 minutes) |
| `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK` | off | Local paper-mode server without a token |
| `BFEXPLORER_COMPAT` | off | Serve MCP at `/` on port 10043 |

## Limitations

- **Third-party data:** the BFExplorer-only providers listed above are not available.
- **Shorter history:** history starts when a market is opened here, whereas BFExplorer's starts earlier, as described under Data contexts.
- **Bot reaction time:** bots act on polls (default 5 s), not on the streaming API, so very fast scalping is out of scope.
- **Paper simplifications:**
  - each-way, BSP and line markets are refused in paper mode;
  - reduction factors use a simple multiplicative rule;
  - dead heats on multi-place markets use the average share.
- **One live process per `DATA_DIR`:** a read-only second process can still run an immediate Close Selection/Market at the same time as the owner's bots, so don't point two live connectors at the same account and `DATA_DIR`.
- **Settled-result retention:** Betfair keeps runner results for 90 days and cleared orders for 90 days.

## Development

```bash
npm test             # 397 tests: unit, module, MCP end-to-end and HTTP
npm run typecheck
npm run dev          # from source
npm run sync-prompts # refresh prompts/ from upstream
```

| Path | Purpose |
| --- | --- |
| `src/format.ts` | TOON encoder, time/id/status formats |
| `src/recorder.ts` | Trade reconstruction and aggressor classification |
| `src/markets.ts` | Catalogues (incl. closed markets), books, monitoring, settled archive, BFExplorer market payload |
| `src/contexts/` | Data-context providers and envelope |
| `src/exchange/` | Paper and live exchanges, position maths |
| `src/strategies/` | Templates, built-ins, engine, bots |
| `src/prompts.ts` | Prompt library, tool-name mapping, compatibility |
| `src/server.ts`, `src/http.ts`, `src/index.ts`, `src/connector.ts` | MCP surface, transports, wiring |

## Credits

The prompt library in [`prompts/`](prompts/) is vendored from [StefanBelo/BetfairAiTrading](https://github.com/StefanBelo/BetfairAiTrading) (MIT, © 2025 Stefan Belopotocan); see [prompts/SOURCE.md](prompts/SOURCE.md). BFExplorer is a separate product. This connector is independent of it and is not affiliated with Betfair.

Betting involves financial risk. Test strategies in paper mode first.
