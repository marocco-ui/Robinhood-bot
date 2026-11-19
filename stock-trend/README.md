# stock-trend

Holds **SPY** while it closed last month above its 10-month average, and **SHY** (1 to 3 year Treasuries, close to cash) otherwise. It checks the signal once a month and trades about twice a year. It runs on your Mac and trades your Robinhood **Agentic** account directly through Robinhood's Trading MCP. No AI makes decisions.

## Why this strategy

From `node bench/stocks/run.js` (published settings, nothing tuned, Jun 2006 to Nov 2026, prices without dividends):

| | Yearly return | Worst drop | 2008 |
|---|---|---|---|
| Hold SPY | 8.9% | -56.5% | -38.3% |
| This bot | 6.75% | -28.9% | +3.0% |

It earns less than holding SPY in good years, and gives back far less in crashes. It still has down years (2015 -8%, 2018 -9%, 2022 -25%). All four average lengths tested (6, 8, 10, 12 months) beat holding SPY on return per unit of risk. Past results don't guarantee future ones.

## Setup (once)

```bash
node shared/scripts/rh-mcp-login.js          # log in (opens Robinhood in your browser)
cp stock-trend/.env.example stock-trend/.env # then edit it
node stock-trend/src/bot.js --status         # signal + holdings, trades nothing
```

## Run

```bash
node stock-trend/src/bot.js                  # paper mode by default
pm2 start stock-trend/ecosystem.config.js    # keep it running in the background
pm2 logs stock-trend
```

Go live only after paper mode has run for a while and you've funded the Agentic account: set `STOCK_MODE=live` and `STOCK_CONFIRM_LIVE=yes` in `stock-trend/.env`, then restart.

## What it does

Every 15 minutes during market hours (9:35 to 15:55 New York time):
1. Waits if an order is still open.
2. Once a month, reads SPY's completed monthly closes and picks SPY or SHY.
3. Sells anything it manages (SPY or SHY) that isn't the pick.
4. Buys the pick with settled cash, up to `STOCK_CAPITAL_USD` in total. In a cash account, sale proceeds settle the next business day, so a switch takes two days.

New deposits get invested into the current pick automatically, up to the cap. Every order goes through Robinhood's order review first, and any warning (buying power, halts) stops that order and gets logged. Orders carry an idempotency key, so a crash mid-order can't double it.

## Stop it

Ctrl+C, `pm2 stop stock-trend`, or create the file `stock-trend/STOP`. Positions stay as they are.

## Files

- `logs/events.jsonl`: every decision and order. `logs/trades.csv`: every fill.
- `data/state-<mode>.json`: what it's doing. `data/paper.json`: paper account.
- Your Robinhood login lives in `bots/.env.robinhood-mcp.json` (never pushed to GitHub). If the bot says the login expired, run the login script again.

## Taxes

Each switch out of SPY sells it, which can realize capital gains in a taxable account. Holding under a year makes them short-term.
