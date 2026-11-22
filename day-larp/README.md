# day-larp

A **paper-only** SPY day trader. It reads Robinhood quotes and never places an order; there is no live mode.

The rule is intraday momentum (Gao, Han, Li and Zhou, Journal of Financial Economics, 2018): SPY's move from yesterday's close to 10:00 ET predicts its move from 15:30 to 16:00 ET. Each trading day it:

1. 10:00 ET: measures the morning move.
2. 15:30 ET: "enters" at the real ask (long) or bid (short).
3. 15:57 ET: "exits" at the real bid or ask, and logs the result.

It tracks two versions with $1,000 of paper money each: long only when the morning was up (the published rule), and long when up, short when down. Days when the market isn't trading at those times (holidays, the 1pm early closes) are skipped.

Why paper: on Robinhood's real 30-minute SPY data (Feb 2 to Nov 20 2026, the only real intraday history it has), the rule made +0.6% before costs and lost 3 to 9% after. A forward record shows whether it's real before any money goes near it.

```bash
pm2 start day-larp/ecosystem.config.js
pm2 logs day-larp
node day-larp/src/larp.js --report     # running record
```

Daily results: `day-larp/logs/days.csv`. Uses the same Robinhood login as stock-trend.
