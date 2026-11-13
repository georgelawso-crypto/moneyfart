# Full engine replay

Feeds a CSV of real prices into the Game engine and runs the strategy:
independent realizedSigma, at least 3% edge, quarter-Kelly, 5% house edge.

```sh
git checkout legit-replay
npm install
npm run build
node dist/replay.js your_prices.csv
node dist/weekly.js
```

CSV columns: time,close (unix seconds, price). Header row required.

The full grid uses the game's own band sizes. A positive held-out multiple
means the vol-floor disagreement survived those bands. A multiple of 1.00
means it mostly passed and did not make money.
