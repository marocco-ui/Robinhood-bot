# bots

Two crypto bots on the official Robinhood Crypto Trading API. No npm dependencies (Node 18.17+).

| Bot | Folder | What it does |
|---|---|---|
| Grid | `sol-grid/` | Buys SOL in steps as it falls and sells each lot one step higher. Makes money in sideways chop. |
| Momentum | `solana-momentum/` | Reads on-chain DexScreener data (volume spikes, buy pressure) for Solana tokens Robinhood lists, buys breakouts on Robinhood, exits on stop, target, or trailing stop. |
| Bench | `bench/` | Replays history through both bots to pick settings, with charts. |

Both start in **paper mode**: real Robinhood prices, simulated orders. Nothing touches real money until you set `TRADING_MODE=live`.

## Setup (once)

```bash
cd bots

# 1. Make your Robinhood API key pair. The private key is saved to bots/.env.robinhood (never printed).
node shared/scripts/rh-keygen.js

# 2. On robinhood.com (web classic) > crypto account settings > API, create a credential.
#    Paste the PUBLIC key it printed. For paper testing, read-only permissions are enough.
#    Put the API key Robinhood shows you on the RH_API_KEY= line in bots/.env.robinhood.

# 3. Check the connection (read-only):
node shared/scripts/rh-check.js

# 4. Per-bot settings:
cp sol-grid/.env.example sol-grid/.env
cp solana-momentum/.env.example solana-momentum/.env

# 5. Tests (no network needed):
cd sol-grid && npm test && cd ../solana-momentum && npm test && cd ..
```

No Robinhood keys yet? Paper mode falls back to Coinbase public prices so you can still watch the bots run. Those prices don't include Robinhood's spread, so treat results as optimistic.

## Stress test on history first

```bash
node bench/fetch-data.js --days 365          # download a year of candles
node bench/stress.js grid                    # pass/fail report card
node bench/stress.js momentum --samples 100
node bench/final-exam.js grid                # only after a PASS, and only once
```

See `bench/README.md` for how it works and what the results mean.

## Run

```bash
pm2 start ecosystem.config.js     # both bots
pm2 logs                          # live console
bash solana-momentum/send-digest.sh   # summary from the real status files
```

## Where the logs are

Every decision is written to disk, so you can always check what a bot actually did:

| File | Contents |
|---|---|
| `<bot>/logs/events.jsonl` | One JSON line per event: scans with every check's value, orders, fills, errors |
| `<bot>/logs/trades.csv` | Every fill (opens in Numbers/Excel) |
| `<bot>/data/status.json` | Latest snapshot (used by send-digest.sh) |
| `<bot>/data/state.json` | The bot's memory. Survives restarts; don't edit while it runs |
| `<bot>/logs/pm2-*.log` | Console output when run under pm2 |

## Emergency controls

| Action | Grid | Momentum |
|---|---|---|
| Pause | `touch sol-grid/STOP` (cancels orders, halts) | `touch solana-momentum/STOP` (no new entries; exits keep working) |
| Sell everything the bot bought | `cd sol-grid && npm run flatten` | `cd solana-momentum && npm run liquidate` |
| Status | `npm run status` | `npm run status` |
| Resume after a halt | `npm run reset-halt` | `npm run reset-halt` |

The bots only ever sell coins they bought themselves. SOL or anything else you already hold is never counted or sold.

## Things to know before going live

- **Robinhood's spread is about 2%** on SOL and these tokens (checked Nov 18, 2026: SOL bid $74.24 / ask $75.67). Every buy-then-sell pays roughly that. That's why grid steps are forced to at least 3%, and why the backtester assumes a 1.9% spread.
- **Both bots share Robinhood's ~100 requests/min account limit.** Each defaults to 40/min.
- **Start live small.** Run paper for a week or two, read `events.jsonl` and `trades.csv`, then go live with a fraction of the capital.
- The grid's stop-loss and the momentum bot's portfolio stop sell at market. In a fast crash, fills can be worse than the trigger price.
- `rh-keygen.js` writes `.env.robinhood` with permission 600. Don't commit it, sync it to shared drives, or paste it anywhere. If it leaks, delete the credential on Robinhood and make a new one.
