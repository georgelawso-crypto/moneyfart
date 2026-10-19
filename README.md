# TraderMaster MCP connector

An English rebuild of [DivXPro/TraderMaster](https://github.com/DivXPro/TraderMaster), a Chinese-language
"draw boxes on the price chart" betting game, as an **MCP server**. Add it to Claude as a connector and
Claude can play the game for you or with you: read live prices, look at the odds grid, place play-money
bets, and wait for them to settle.

No real money is involved. Every player starts with 10,000 credits.

## The game

Picture a live price chart. The space to the right of "now" (the future) is cut into a grid of **boxes**:

- **Columns** are back-to-back **30-second time windows** (12:30:00–12:30:30, 12:30:30–12:31:00, …).
- **Rows** are **price bands** of fixed height (for example 100.00–100.05).

You bet on a box. **If the price at the moment the box's window closes is inside its band, you win
`stake × odds`**; otherwise you lose the stake. Bands are half-open, `[low, high)`, so a price sitting
exactly on a boundary belongs to exactly one box.

Rules:

| Rule | Default |
| --- | --- |
| Window length | 30 s |
| Windows open for betting | the next 8 (about 4 minutes ahead) |
| Betting on a window closes | 10 s before the window opens |
| Minimum bet | 10 credits |
| Bets per box per player | 1 |
| House edge | 5% |
| Odds range | 1.01 – 99 (boxes that would pay under 1.01 aren't offered) |
| Starting balance | 10,000 credits |

If the price feed goes quiet (the market is closed or the oracle is down), betting pauses. Any bet whose
window closes without a fresh price is **refunded** rather than settled on a stale number.

### How the odds are set

Odds are computed live, then locked in when you bet:

1. **Volatility.** The server builds one-second candles from the feed and measures recent volatility: the
   root-mean-square of the last ~5 minutes of one-second price moves. Until it has enough data, and as a
   floor during quiet spells, it falls back to a typical volatility for that asset.
2. **Probability.** The price `T` seconds from now is modelled as a normal distribution centred on today's
   price, with spread `σ·√T`. This is the Bachelier model, the "arithmetic" cousin of Black-Scholes, and is
   what the original's `bs.ts` uses. The chance of finishing inside `[low, high)` is
   `Φ((high − price)/σ√T) − Φ((low − price)/σ√T)`.
3. **Odds.** `odds = 0.95 / probability`, rounded *down* to the cent and capped at 99. A box with a 20%
   chance pays 4.75: put 100 on it, get 475 back (375 profit). The expected return of every bet is at most
   95% of the stake, so the house always keeps its edge.

Band height is chosen per market from its first price: about half of a typical two-minute move, rounded to
a "nice" number (1, 2, 2.5 or 5 × 10ⁿ). That puts several plausible boxes near the price in every column.

### Markets

| Symbol | What | Price source |
| --- | --- | --- |
| `XAUUSD` | Gold (the original game's market) | [Pyth](https://pyth.network) oracle via the Hermes API |
| `BTCUSD` | Bitcoin | Pyth |
| `ETHUSD` | Ether | Pyth |
| `SOLUSD` | Solana | Pyth |
| `SIM` | Simulated random walk | Generated locally: always open, no network needed |

Gold trades on a weekday schedule, so outside those hours `XAUUSD` shows as stale and betting pauses.
Crypto trades 24/7.

## Tools

| Tool | What it does |
| --- | --- |
| `list_markets` | Every market with its price, feed status (`LIVE` / `STALE` / `WAITING`) and band size |
| `get_market` | Recent OHLC bars for one market, plus high/low, change and volatility |
| `get_prediction_grid` | The box grid for a market: upcoming windows × price bands with live odds, and how to build a `cell_id` |
| `place_bet` | Bet `amount` on a `cell_id` (`<SYMBOL>-<window start, unix seconds>-<band #>`) |
| `get_account` | Balance, win/loss record, pending bets (with where the price is now) and recent results |
| `wait_for_results` | Blocks for up to 55 s until your next bet settles, then reports it |
| `reset_account` | Starts a player over at 10,000 credits |

Every tool that touches an account takes a `player` name (default `player`). Use the same name on every
call to keep your balance. The server also sends Claude a short how-to-play guide when it connects, so you
can just say *"let's play TraderMaster on BTC"*.

Example grid, as Claude sees it:

```
SIM price 100.0812 at 12:58:24 UTC · band size 0.05 · volatility ≈ 0.011 per √s

Windows (cell_id = SIM-<start>-<band #>):
  W1  12:58:30–12:59:00  start 1792414710  opens in 6s  betting closed
  W2  12:59:00–12:59:30  start 1792414740  opens in 36s  betting closes in 25s
  ...
                         W1      W2      W3      W4
100.15–100.20 #2003  locked    7.39    7.46    7.78
100.10–100.15 #2002  locked    4.74    5.48    6.14
100.05–100.10 #2001  locked    4.20    5.04    5.76  ◀ price
100.00–100.05 #2000  locked    5.14    5.80    6.41
99.95–100.00 #1999   locked    8.67    8.33    8.46
```

## Running it

Requires Node.js 20 or newer.

```sh
npm install
npm run build
npm test
```

### Claude Code or Claude Desktop (local, stdio)

Claude Code:

```sh
claude mcp add tradermaster -- node /absolute/path/to/dist/index.js --stdio
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tradermaster": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js", "--stdio"]
    }
  }
}
```

### claude.ai custom connector (remote, HTTP)

Run it as a web service. Without `--stdio` it serves MCP over Streamable HTTP at `/mcp`:

```sh
HOST=0.0.0.0 PORT=3000 npm start
# or
docker build -t tradermaster-mcp . && docker run -p 3000:3000 tradermaster-mcp
```

Deploy that to any host that runs a long-lived Node process or container (Render, Fly.io, Railway, a VPS,
…) behind HTTPS. Then in Claude, open the connector settings, choose **Add custom connector**, and enter
`https://your-host/mcp`. `GET /health` reports status for uptime checks.

Serverless platforms that freeze the process between requests won't work: the market clock has to keep
ticking in the background to build candles and settle bets.

To try the HTTP mode locally with Claude Code: `claude mcp add --transport http tradermaster http://localhost:3000/mcp`.

### Configuration

All optional, set as environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | HTTP listen address (use `HOST=0.0.0.0` when deploying) |
| `MCP_PATH` | `/mcp` | Path of the MCP endpoint |
| `MCP_TRANSPORT` | `http` | Set to `stdio` instead of passing `--stdio` |
| `MARKETS` | all | Comma-separated subset, e.g. `BTCUSD,SIM` |
| `HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes endpoint (swap in a dedicated one if you have it) |
| `WINDOW_SECONDS` | `30` | Window length |
| `COLUMNS` | `8` | Windows open for betting |
| `LAYERS` | `9` | Price bands shown per window |
| `BET_CLOSE_SECONDS` | `10` | Betting closes this long before a window opens |
| `MIN_BET` | `10` | Minimum stake |
| `STARTING_BALANCE` | `10000` | Credits for a new player |
| `HOUSE_EDGE` | `0.05` | Fraction kept by the house |
| `MIN_ODDS` / `MAX_ODDS` | `1.01` / `99` | Odds limits |
| `STALE_AFTER_SECONDS` | `15` | A price older than this counts as stale |

To add a market, append an entry to `MARKETS` in `src/config.ts` with its
[Pyth price feed id](https://www.pyth.network/developers/price-feed-ids) and a typical annual volatility.

## How it's built

```
src/
  index.ts    entry point: starts the game, then serves MCP over stdio or HTTP
  http.ts     stateless Streamable HTTP endpoint (one short-lived MCP server per request)
  server.ts   the MCP tools, the instructions sent to Claude, and how results are worded
  game.ts     the game: grid of boxes, accounts, bet validation, settlement every second
  market.ts   turns a price stream into one-second candles and estimates volatility
  feeds.ts    Pyth Hermes poller (one batched request per second) and the simulated random walk
  pricing.ts  normal CDF, band probability, odds, band sizing
  config.ts   markets and game settings
test/         node:test suites, including full MCP round trips over memory and HTTP
```

The game runs in one Node process. A one-second clock closes a candle for every market and settles any bet
whose window has just closed. The MCP layer is thin: each tool call reads or changes that shared `Game`, so
the HTTP endpoint can be stateless and any number of Claude conversations can play at once.

## Differences from the original

The original is a Colyseus + React app: a multiplayer room streams the gold price to a canvas chart where
players click boxes. This version keeps the game and drops the UI so it works through Claude.

- **English throughout.** The design notes, rules and messages were Chinese.
- **Settlement uses the price at the close of the window.** The original's notes list this as one of four
  candidate rules ("rule C"). Its code settled on the price at the window's *start*, which made the window's
  width meaningless.
- **Odds are live.** The original priced each box once, when the box was created up to four minutes
  earlier, and always with a 30-second horizon. Here odds use the current price and the real time left until
  settlement, and are locked when you bet.
- **Volatility comes from the market.** The original used one fixed absolute volatility (1500 price units
  per √year) for every symbol. Here it is measured from each market's own recent moves.
- **Grid near the price.** The original generated bands from 0 up to twice the price in every column, which
  for gold at $10 bands meant hundreds of boxes per column. Here the grid is a window of bands around the
  current price.
- **No house-favouring loophole.** The original paid 1.01 on any box above 99% likely, so the player had the
  edge. Boxes now pay at most 95% of fair value, or aren't offered.
- **Stale prices refund.** The original kept settling on the last price if the feed stopped.
- **More markets, plus `SIM`.** BTC, ETH and SOL from Pyth, and a simulated market for offline play.

## Limitations

- **State is in memory.** Restarting the server wipes balances and pending bets.
- **No authentication.** Anyone with the URL can play, as any player name. It's play money, but don't expose
  it somewhere that matters.
- **One-second price sampling.** Prices are sampled once a second, and "the price when the window closes"
  means the last price received by that second.
- **Public Hermes rate limits.** Polling uses one batched request per second, well under the public
  endpoint's limits. For heavy use, point `HERMES_URL` at a dedicated endpoint.
