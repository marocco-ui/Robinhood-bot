# bench: tune the bots on history

Replays past prices through the **real bot code** (the same `grid.js` and `momentum.js` that trade live), finds settings that would have worked, then checks them on a stretch of history they never saw.

## Quick start (in Terminal, from the `bots` folder)

```bash
# 1. Download ~4 months of candles (needs internet, takes a few minutes)
node bench/fetch-data.js

# 2. Tune each bot (uses all your CPU cores)
node bench/optimize.js grid
node bench/optimize.js momentum --samples 300

# 3. Compare Robinhood's two cost models
node bench/optimize.js grid --cost rh-v2
```

Each run prints a table and writes three files to `bench/results/`:

| File | What it is |
|---|---|
| `<bot>-<cost>-<date>.html` | Report with charts. Open it in your browser |
| `<bot>-<cost>-<date>.json` | Every number behind the report |
| `<bot>-best.env` | The picked settings, ready to paste into that bot's `.env` |

## How it avoids fooling you

1. **Train/test split.** Settings are chosen on the first 70% of the history (`--train 0.7`), then run on the last 30%, which they never saw. The report leads with the unseen-data result.
2. **The pick has to hold up in both periods.** It's the finalist with the best *worse* score across training and test, not just the best training score.
3. **No look-ahead.** An order placed on one candle can only fill on a later one.
4. **Costs are built in.** Every fill pays the modeled spread and fees.
5. **Minimum trades.** Settings that barely traded are thrown out (`--min-trades`), because 2 lucky trades aren't evidence.

The verdict line at the top of each report tells you whether the pick made money on unseen data. If it says it didn't, don't go live with those settings.

## Cost models (`--cost`)

| Name | Spread | Maker fee | Taker fee | What it models |
|---|---|---|---|---|
| `rh-default` | 1.9% | 0 | 0 | How the bots trade today (Robinhood market maker routing; cost is in the spread) |
| `rh-v2` | 0.1% | 0.50% | 0.95% | Robinhood exchange routing via API v2 fee-tier orders, new-account tier |
| `free` | 0 | 0 | 0 | Sanity check only. Shows whether a strategy has any edge before costs |

Resting grid orders pay the maker fee. Market orders (all momentum trades) pay the taker fee.

## Limits

- **Momentum signals are a stand-in.** Live, the bot reads DexScreener's on-chain volume and buy/sell counts, and there's no free historical archive of those. The bench uses exchange candles instead: volume spike = last hour vs. the 6h average, buy pressure = share of volume on up candles. Treat momentum results as a rough guide, and confirm them with paper trading.
- **Stops are checked on candle closes** (every 5 minutes for momentum). Live checks every 15 seconds, so real stops can trigger earlier, sometimes better and sometimes worse.
- **The past isn't the future.** A grid tuned on a sideways market loses in a crash, and the bench can only show you what already happened. That's what paper trading and the stop-losses are for.

## Options

```
node bench/fetch-data.js [--days 120] [--symbols SOL,BONK] [--interval 5m|15m|1h]
node bench/optimize.js grid|momentum
    --cost rh-default|rh-v2|free   cost model (default rh-default)
    --data DIR                     candle folder (default bench/data)
    --interval 1h|5m               grid default 1h, momentum 5m
    --train 0.7                    share of history used to pick settings
    --capital 1000                 starting money in the simulation
    --samples 200                  momentum: how many random settings to try
    --min-trades N                 ignore settings with fewer trades
    --workers N                    CPU cores to use (default all but one)
```

To change which settings get tried, edit the lists in `bench/lib/spaces.js`.

## Testing the bench itself

```bash
node bench/scripts/make-synthetic.js     # fake data with planted pumps and a selloff
node bench/optimize.js grid --data bench/data-synthetic
node --test bench/test/*.test.js
```

Synthetic data is only for checking that the bench works. Never pick settings from it.
