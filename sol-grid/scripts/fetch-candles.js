#!/usr/bin/env node
// Downloads historical candles from Coinbase's public API (no key) for backtesting.
//   node scripts/fetch-candles.js                 -> SOL-USD, 1h candles, last 180 days
//   node scripts/fetch-candles.js SOL-USD 900 60  -> 15m candles, last 60 days
// Writes data/candles-<symbol>-<seconds>s.csv
const fs = require('fs');
const path = require('path');

const symbol = process.argv[2] || 'SOL-USD';
const granularity = Number(process.argv[3] || 3600); // 60, 300, 900, 3600, 21600, 86400
const days = Number(process.argv[4] || 180);

async function main() {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const step = granularity * 300; // Coinbase returns max 300 candles per call
  const rows = new Map();
  for (let t = start; t < end; t += step) {
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}` +
      `&start=${new Date(t * 1000).toISOString()}&end=${new Date(Math.min(t + step, end) * 1000).toISOString()}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'bots-backtest' } });
    if (!res.ok) throw new Error(`Coinbase ${res.status}: ${await res.text()}`);
    for (const [time, low, high, open, close, volume] of await res.json()) rows.set(time, { time, open, high, low, close, volume });
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 350));
  }
  const sorted = [...rows.values()].sort((a, b) => a.time - b.time);
  const out = path.join(__dirname, '..', 'data', `candles-${symbol}-${granularity}s.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'time,open,high,low,close,volume\n' + sorted.map((r) => `${r.time},${r.open},${r.high},${r.low},${r.close},${r.volume}`).join('\n') + '\n');
  console.log(`\n${sorted.length} candles -> ${out}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
