#!/usr/bin/env node
// Downloads historical candles for the bench. Run this in your own Terminal (needs internet).
//   node bench/fetch-data.js                 -> SOL 1h + 5m, momentum coins 5m, last 365 days
//   node bench/fetch-data.js --days 240
//   node bench/fetch-data.js --symbols SOL,BONK --interval 5m
// Sources: Coinbase public API first, Binance.US as a fallback. No API keys needed.
// Output: bench/data/<SYMBOL>-<interval>.csv  (time_ms,open,high,low,close,volume)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const UNIVERSE = Object.keys(require('../solana-momentum/src/universe'));
const SECONDS = { '5m': 300, '15m': 900, '1h': 3600 };

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(`--${k}`); return i === -1 ? d : a[i + 1]; };
  return {
    days: Number(get('days', 365)),
    symbols: get('symbols', null),
    interval: get('interval', null),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'bots-bench' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
  throw new Error(`rate limited: ${url}`);
}

async function fromCoinbase(symbol, interval, days) {
  const gran = SECONDS[interval];
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const step = gran * 300;
  const rows = new Map();
  let first = true;
  for (let t = start; t < end; t += step) {
    const url = `https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=${gran}` +
      `&start=${new Date(t * 1000).toISOString()}&end=${new Date(Math.min(t + step, end) * 1000).toISOString()}`;
    const data = await getJson(url);
    if (data === null) {
      if (first) return null; // product doesn't exist on Coinbase
      continue;
    }
    first = false;
    for (const [time, low, high, open, close, volume] of data) rows.set(time * 1000, [time * 1000, open, high, low, close, volume]);
    await sleep(140);
  }
  return [...rows.values()].sort((a, b) => a[0] - b[0]);
}

async function fromBinanceUS(symbol, interval, days) {
  const end = Date.now();
  let start = end - days * 86400000;
  const rows = new Map();
  for (const quote of ['USDT', 'USD']) {
    const probe = await getJson(`https://api.binance.us/api/v3/klines?symbol=${symbol}${quote}&interval=${interval}&limit=1`);
    if (!probe || !probe.length) continue;
    while (start < end) {
      const data = await getJson(`https://api.binance.us/api/v3/klines?symbol=${symbol}${quote}&interval=${interval}&startTime=${start}&limit=1000`);
      if (!data || !data.length) break;
      for (const k of data) rows.set(k[0], [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
      start = data[data.length - 1][0] + SECONDS[interval] * 1000;
      await sleep(120);
    }
    return [...rows.values()].sort((a, b) => a[0] - b[0]);
  }
  return null;
}

async function fetchOne(symbol, interval, days) {
  let rows = null;
  let source = 'coinbase';
  try { rows = await fromCoinbase(symbol, interval, days); } catch (err) { console.log(`  coinbase error: ${err.message}`); }
  if (!rows || rows.length < 100) {
    source = 'binance.us';
    try { rows = await fromBinanceUS(symbol, interval, days); } catch (err) { console.log(`  binance.us error: ${err.message}`); }
  }
  if (!rows || rows.length < 100) return { symbol, interval, ok: false };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${symbol}-${interval}.csv`);
  fs.writeFileSync(file, 'time,open,high,low,close,volume\n' + rows.map((r) => r.join(',')).join('\n') + '\n');
  return { symbol, interval, ok: true, source, candles: rows.length, from: new Date(rows[0][0]).toISOString().slice(0, 10), to: new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10) };
}

async function main() {
  const { days, symbols, interval } = parseArgs();
  const jobs = [];
  if (symbols) {
    for (const s of symbols.split(',')) for (const iv of (interval ? [interval] : ['5m'])) jobs.push([s.trim().toUpperCase(), iv]);
  } else {
    jobs.push(['SOL', '1h'], ['SOL', '5m']);
    for (const s of UNIVERSE) if (s !== 'SOL') jobs.push([s, '5m']);
  }
  console.log(`Downloading ${jobs.length} series, ${days} days each. A year of 5m candles takes about 20 minutes.`);
  const results = [];
  for (const [s, iv] of jobs) {
    process.stdout.write(`${s} ${iv} ... `);
    const r = await fetchOne(s, iv, days);
    results.push(r);
    console.log(r.ok ? `${r.candles} candles from ${r.source} (${r.from} to ${r.to})` : 'not available');
  }
  const missing = results.filter((r) => !r.ok).map((r) => r.symbol);
  if (missing.length) console.log(`\nNo data for: ${missing.join(', ')}. The bench skips those coins.`);
  console.log(`\nSaved to ${DATA_DIR}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
