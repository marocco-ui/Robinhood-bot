# solana-momentum (v2)

Momentum bot: **on-chain signals from DexScreener, orders on Robinhood.**

## Universe

Solana-native tokens Robinhood lists: BONK, WIF, PENGU, POPCAT, JUP, RAY, PYTH, TRUMP, JTO, RENDER, MEW, W, HNT. SOL is excluded by default because the grid bot trades it. Mint addresses are in `src/universe.js`. Each one is checked on every scan: DexScreener's symbol must match, and its price must be within 5% of Robinhood's.

## Entry (every check must pass)

| Check | Default | Meaning |
|---|---|---|
| spread | ≤ 3% | Robinhood bid/ask spread |
| liquidity | ≥ $1M | Deepest on-chain pool |
| volumeAccel | ≥ 1.5x | Last hour's volume vs. the 6h hourly average |
| change1h | 1% to 15% | Rising, but not already vertical |
| buyRatio | ≥ 55% | Buys vs. sells in the last hour, on-chain |
| history | ≥ 80% of 60 min | Enough Robinhood price history (first entry is possible ~1h after start) |
| breakout | > 60-min high + 0.3% | Price is breaking out |
| score | ≥ 45 | Weighted blend used to rank candidates |

At most one entry per scan (60s). Run `npm run scan` to see every check's value for every token, without trading.

## Exits

Stop loss −12%, take profit +30%, trailing stop (once up 12%, exit after an 8% drop from the high), and a 48h max hold. After an exit, that token can't be re-entered for 6h.

## Circuit breakers

- Down 8% on the day: no new entries until the next UTC day.
- Down 30% overall: sell everything and halt.
- `touch STOP`: no new entries. Open positions keep their exits.

## What was wrong with v1 (why it never traded)

1. The breakout check was called with no price history, so it always failed, and it was required.
2. It read `volume.h4` and `priceChange.h4`. DexScreener only has m5/h1/h6/h24, so every token scored −100% volume.
3. Prices were inverted (tokens per dollar), which would have fired stops and targets backwards.
4. It scanned the same first 50 of ~288k Jupiter tokens every cycle, then got rate-limited (all the 429s in bot.log).
5. The portfolio stop ignored open positions.
6. Live trading was never implemented.
7. `send-digest.sh` printed hardcoded numbers.

## Legacy files

v1 had more files (`src/bot.js`, `src/log-bridge.js`, `src/modules/jupiter.js`, `state.js`, `alerts.js`, `log-bridge.sh`). Nothing in v2 uses them, so they're not in this repo.
