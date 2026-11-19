# sol-grid

Grid bot for SOL-USD on Robinhood.

## How it works

The range `GRID_LOWER`–`GRID_UPPER` is cut into `GRID_COUNT` slots with equal % steps. Each slot:

1. Rests a limit **buy** at its bottom price.
2. When that fills, rests a limit **sell** one step up.
3. When that fills, it banks the step (minus Robinhood's spread) and goes back to step 1.

Only the `GRID_MAX_OPEN_BUYS` slots nearest below the price hold buy orders, and total money in play is capped at `GRID_MAX_CAPITAL_USD`. Buys that drift too far below the price get canceled to free up cash.

**When it loses:** in a strong downtrend it keeps buying all the way down and ends up holding SOL bought at higher prices. `GRID_STOP_LOSS_PCT` (default 10% below `GRID_LOWER`) sells the grid's coins and halts. In a strong uptrend it sells everything and then sits in cash while SOL keeps climbing.

## Pick settings with real history

```bash
npm run candles     # downloads 180 days of hourly SOL candles from Coinbase (public, no key)
npm run sweep       # tries 20 range/slot combos, sorted by return
npm run backtest -- --lower 60 --upper 95 --count 8
```

The backtester runs the same engine code as the live bot. A buy only fills when a *later* candle's low reaches it, after a 1.9% Robinhood spread (`--spread-bps 190`). Past chop doesn't guarantee future chop.

## Run

```bash
cp .env.example .env    # edit the range around the current price
npm start               # foreground
npm run pm2:start       # background with auto-restart
```

Changing the range, slot count or order size while the grid holds coins or orders is refused. Run `npm run flatten` first, or put the old settings back.

## Commands

| Command | What it does |
|---|---|
| `npm run status` | Slots, P&L, price |
| `npm run cancel-all` | Cancel grid orders, keep coins |
| `npm run flatten` | Cancel orders, market-sell the grid's coins, halt |
| `npm run reset-halt` | Clear a halt (stop-loss, STOP file, flatten) |
| `touch STOP` | Running bot cancels its orders and halts |

On a normal stop (Ctrl+C, `pm2 stop`), resting orders are canceled so nothing trades while the bot is off (`GRID_CANCEL_ON_EXIT=true`). On restart it re-places them.
