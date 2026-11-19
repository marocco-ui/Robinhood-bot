#!/usr/bin/env node
// Replays historical candles through the real GridEngine + PaperBroker.
//   node src/backtest.js data/candles-SOL-USD-3600s.csv
//   node src/backtest.js data/candles-SOL-USD-3600s.csv --lower 120 --upper 200 --count 12
//   node src/backtest.js data/candles-SOL-USD-3600s.csv --sweep
// Fills: a resting buy fills if a later candle's low touches it, a sell if the high does.
// Orders placed on a candle can only fill on the next one (no look-ahead).
const fs = require('fs');
const path = require('path');
const { GridEngine } = require('./grid');
const { validate } = require('./config');
const { PaperBroker } = require('../../shared/brokers');

function loadCandles(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1);
  return lines.map((l) => {
    const [time, open, high, low, close] = l.split(',').map(Number);
    return { time: time < 1e12 ? time * 1000 : time, open, high, low, close };
  });
}

class ReplayFeed {
  constructor(candles, symbol, spreadBps) {
    this.candles = candles;
    this.symbol = symbol;
    this.half = spreadBps / 2 / 1e4;
    this.i = 0;
  }
  now() { return this.candles[this.i].time; }
  async getQuotes() {
    const c = this.candles[this.i];
    return new Map([[this.symbol, { symbol: this.symbol, bid: c.close * (1 - this.half), ask: c.close * (1 + this.half), mid: c.close, ts: c.time }]]);
  }
  async getMatchQuotes() {
    const c = this.candles[this.i];
    // Lowest ask and highest bid during the candle, after Robinhood's spread.
    return new Map([[this.symbol, { symbol: this.symbol, bid: c.close * (1 - this.half), ask: c.close * (1 + this.half), low: c.low * (1 + this.half), high: c.high * (1 - this.half) }]]);
  }
}

const quietLog = { event() {}, error() {}, trade() {} };

async function run(candles, cfg, { spreadBps = 190, feeBps = 0, startingCash = 1000 } = {}) {
  const feed = new ReplayFeed(candles, cfg.symbol, spreadBps);
  const broker = new PaperBroker({
    priceSource: feed,
    startingCash,
    feeBps,
    pairs: { [cfg.symbol]: { symbol: cfg.symbol, assetCode: 'SOL', quoteIncrement: '0.01', assetIncrement: '0.000001', minOrderSize: 0.000001, maxOrderSize: Infinity, status: 'tradable' } },
  });
  broker.sync = broker.sync.bind(broker);
  const engine = new GridEngine({ cfg: { ...cfg, statusEveryTicks: 1e9 }, broker, log: quietLog, now: () => feed.now() });
  await engine.init();

  let peak = startingCash;
  let maxDd = 0;
  for (feed.i = 0; feed.i < candles.length; feed.i++) {
    await engine.tick();
    const price = candles[feed.i].close;
    const equity = broker.cash + (broker.holdings.SOL || 0) * price;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
    if (engine.state.halted) break;
  }
  const last = candles[Math.min(feed.i, candles.length - 1)].close;
  const first = candles[0].close;
  const equity = broker.cash + (broker.holdings.SOL || 0) * last;
  return {
    lower: cfg.lower,
    upper: cfg.upper,
    count: cfg.gridCount,
    stepPct: +cfg.stepPct.toFixed(2),
    roundTrips: engine.state.roundTrips,
    realizedPnl: +engine.state.realizedPnl.toFixed(2),
    finalEquity: +equity.toFixed(2),
    returnPct: +(((equity - startingCash) / startingCash) * 100).toFixed(2),
    maxDrawdownPct: +(maxDd * 100).toFixed(2),
    heldSolAtEnd: +(broker.holdings.SOL || 0).toFixed(4),
    halted: engine.state.halted ? engine.state.halted.reason : null,
    solBuyHoldPct: +(((last - first) / first) * 100).toFixed(2),
  };
}

function parseArgs(argv) {
  const out = { file: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; } else out.flags[key] = true;
    } else out.file = argv[i];
  }
  return out;
}

function makeCfg(base) {
  const cfg = {
    mode: 'paper', symbol: 'SOL-USD', lower: 60, upper: 95, gridCount: 8, spacing: 'geometric',
    orderUsd: 50, maxCapitalUsd: 600, maxOpenBuys: 4, stopLossPct: 10, minSpacingPct: 3,
    cancelOnExit: false, ...base,
  };
  validate(cfg);
  return cfg;
}

async function main() {
  const { file, flags } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('Usage: node src/backtest.js <candles.csv> [--lower N --upper N --count N --order N --capital N --fee-bps N --sweep]');
    process.exit(1);
  }
  const candles = loadCandles(path.resolve(file));
  const opts = { feeBps: Number(flags['fee-bps'] ?? 0), spreadBps: Number(flags['spread-bps'] ?? 190), startingCash: Number(flags.cash ?? 1000) };
  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  console.log(`${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} -> ${new Date(candles[candles.length - 1].time).toISOString().slice(0, 10)}, ` +
    `SOL range $${Math.min(...lows).toFixed(2)}-$${Math.max(...highs).toFixed(2)}, spread ${opts.spreadBps} bps, fee ${opts.feeBps} bps/side`);

  if (flags.sweep) {
    const first = candles[0].close;
    const rows = [];
    for (const width of [0.15, 0.25, 0.35, 0.5]) {
      for (const count of [4, 6, 8, 12, 16]) {
        const base = { lower: +(first * (1 - width)).toFixed(2), upper: +(first * (1 + width)).toFixed(2), gridCount: count, orderUsd: 50, maxCapitalUsd: 600 };
        try { rows.push(await run(candles, makeCfg(base), opts)); } catch (err) { /* grid too tight */ }
      }
    }
    rows.sort((a, b) => b.returnPct - a.returnPct);
    console.table(rows);
    return;
  }

  const cfg = makeCfg({
    lower: Number(flags.lower ?? 60), upper: Number(flags.upper ?? 95), gridCount: Number(flags.count ?? 8),
    orderUsd: Number(flags.order ?? 50), maxCapitalUsd: Number(flags.capital ?? 600), maxOpenBuys: Number(flags['open-buys'] ?? 4),
    stopLossPct: Number(flags['stop-loss'] ?? 10),
  });
  console.table([await run(candles, cfg, opts)]);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { run, loadCandles, makeCfg, ReplayFeed };
