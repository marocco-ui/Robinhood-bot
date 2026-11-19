# bench: tune the bots on history

Replays past prices through the **real bot code** (the same `grid.js` and `momentum.js` that trade live), finds settings that would have worked, then checks them on a stretch of history they never saw.

## Quick start (in Terminal, from the `bots` folder)

```bash
# 1. Download a year of candles (needs internet, about 20 minutes)
node bench/fetch-data.js --days 365

# 2. Stress test each bot. This is the main tool. Pass/fail report card.
node bench/stress.js grid
node bench/stress.js grid --cost rh-v2
node bench/stress.js momentum --samples 100

# 3. Only if a bot PASSED: open the sealed final exam, once
node bench/final-exam.js grid

# Quick single tune with charts (older, less strict)
node bench/optimize.js grid
```

The last 60 days of history are sealed (`--holdout-days 60`). Neither `optimize.js` nor `stress.js` ever looks at them. `final-exam.js` is the only thing that does.

## Stress test (`stress.js`)

Five checks. All five must pass before settings go anywhere near real money.

| Check | What it does | Passes when |
|---|---|---|
| Walk-forward | Tunes on 90 days, trades the next 30 unseen, slides forward 30 days, repeats | Unseen windows add up to a profit and at least 55% of them are profitable |
| Market types | Groups those windows into uptrend, sideways, downtrend (SOL or the coins moved more than 10%) | No market type averages worse than -8% per window |
| Stable settings | Nudges each setting one notch up and down | The pick is profitable and at least 70% of the nudged versions are too |
| Worse costs | Reruns with the spread 0.6% and 1.1% wider, fills that must trade 0.3% through, fees +50% | Still profitable with the spread 0.6% wider |
| Bad luck | Reshuffles the real unseen days in 5-day blocks, 2,000 times | Chance of a loss is 35% or less and the 95th-percentile drawdown is 25% or less |

Outputs in `bench/results/`: `<bot>-stress-<cost>-<date>.html` (report card), `.json` (every number), and `<bot>-candidate.json` (the settings tuned on the most recent window, which `final-exam.js` reads). The pass bars live in `CRITERIA` in `bench/lib/stress-core.js`.

Synthetic data with planted pumps should make momentum pass and the grid fail. If both pass or both fail on that data, something in the bench is broken.

## Final exam (`final-exam.js`)

Runs the candidate once on the sealed days and logs it in `bench/results/final-exam-ledger.json`. It refuses to run a candidate that failed its stress test, and refuses a second look at the same sealed days (`--force` overrides both). Re-tuning until the exam passes turns the exam into training data, and then the result means nothing. If it fails, wait a few weeks, fetch fresh data, and the new days become the next exam.

## Grid trend filter

`GRID_TREND_MA_HOURS` (0 = off) stops the grid from buying while SOL trades more than `GRID_TREND_BUFFER_PCT` below its moving average, and cancels resting buys. Sells keep working. The stress test tries 0, 72, 240 and 480 hours. Live, the bot backfills Coinbase hourly candles at startup so the filter works right away.

## optimize.js

Each run prints a table and writes three files to `bench/results/`:

| File | What it is |
|---|---|
| `<bot>-<cost>-<date>.html` | Report with charts. Open it in your browser |
| `<bot>-<cost>-<date>.json` | Every number behind the report |
| `<bot>-best.env` | The picked settings, ready to paste into that bot's `.env` |

## How it avoids fooling you

1. **Train/test split.** Settings are chosen on the first 70% of the history before the sealed days (`--train 0.7`), then run on the last 30%, which they never saw. The report leads with the unseen-data result.
2. **The pick has to hold up in both periods.** It's the finalist with the best *worse* score across training and test, not just the best training score.
3. **No look-ahead.** An order placed on one candle can only fill on a later one.
4. **Costs are built in.** Every fill pays the modeled spread and fees, and coins still held are valued at the bid (what you could sell for), not the mid.
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
node bench/fetch-data.js [--days 365]  (default 365; stress.js needs at least 240) [--symbols SOL,BONK] [--interval 5m|15m|1h]
node bench/optimize.js grid|momentum
    --cost rh-default|rh-v2|free   cost model (default rh-default)
    --data DIR                     candle folder (default bench/data)
    --interval 1h|5m               grid default 1h, momentum 5m
    --train 0.7                    share of history used to pick settings
    --capital 1000                 starting money in the simulation
    --samples 200                  momentum: how many random settings to try
    --min-trades N                 ignore settings with fewer trades
    --workers N                    CPU cores to use (default all but one)
    --holdout-days 60              sealed final-exam days to leave out
node bench/stress.js grid|momentum
    --cost, --data, --interval, --capital, --workers, --holdout-days   as above
    --train-days 90 --test-days 30 walk-forward window sizes
    --samples 100                  momentum: random settings tried per window
    --params FILE                  stress these exact settings instead of re-tuning
node bench/final-exam.js grid|momentum [--data DIR] [--capital 1000] [--force]
```

To change which settings get tried, edit the lists in `bench/lib/spaces.js`.

## Testing the bench itself

```bash
node bench/scripts/make-synthetic.js bench/data-synthetic 365   # fake data with planted pumps and a selloff
node bench/stress.js momentum --data bench/data-synthetic --samples 20
node --test bench/test/*.test.js
```

Synthetic data is only for checking that the bench works. Never pick settings from it.
