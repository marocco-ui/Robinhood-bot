#!/usr/bin/env node
// Replays history through the REAL stock-trend code (TrendEngine + PaperBroker), one trading day
// at a time, fast. Catches bugs a strategy formula can't: settlement delays, the capital cap,
// order flow. Prices: each day trades at that day's open (spread 1 bp); equity marked at the close.
//
//   node bench/stocks/replay.js [--start 2006-06-01] [--capital 1000] [--cash 1000] [--risk SPY --safe SHY --sma 10]
const path = require('path');
const { loadPrices, STRATEGIES, simulate, stats, yearly } = require('./lib');
const { TrendEngine } = require('../../stock-trend/src/engine');
const { PaperBroker } = require('../../stock-trend/src/brokers');

const quietLog = () => ({ trades: [], events: [], event(t, d) { this.events.push({ t, ...d }); }, error() {}, trade(x) { this.trades.push(x); } });

// Run the engine over prices P from startDate. Returns daily equity curve and trades.
async function replay(P, { startDate = '2006-06-01', endDate, capitalUsd = 1000, cash = 1000, risk = 'SPY', safe = 'SHY', smaMonths = 10, deposits = {}, engineOpts = {} } = {}) {
  const start = P.dates.findIndex((d) => d >= startDate);
  const end = endDate ? P.dates.findIndex((d) => d >= endDate) : P.dates.length;
  let i = start;
  // 10:00 New York is 14:00 or 15:00 UTC; 15:00 is inside the session either way.
  const now = () => new Date(`${P.dates[i]}T15:00:00Z`);
  const spread = 0.5 / 1e4;
  const quotes = {
    quote: async (s) => ({ last: P.open[s][i], bid: P.open[s][i] * (1 - spread), ask: P.open[s][i] * (1 + spread) }),
    // Completed month-end closes strictly before today.
    monthCloses: async (s, n) => P.monthEnds.filter((j) => j < i).slice(-n).map((j) => ({ month: P.dates[j].slice(0, 7), close: P.close[s][j] })),
  };
  const paper = { cash, positions: {}, unsettled: [], orders: {} };
  const broker = new PaperBroker({ quotes, state: paper, now });
  const log = quietLog();
  const engine = new TrendEngine({
    cfg: { mode: 'paper', risk, safe, smaMonths, capitalUsd, maxOrderUsd: capitalUsd, minOrderUsd: 1, cashReserveUsd: 1, ignoreHours: true, ...engineOpts },
    broker, log, now,
  });
  const curve = [];
  let idle = 0;
  for (; i < (end === -1 ? P.dates.length : end); i++) {
    if (deposits[P.dates[i]]) paper.cash += deposits[P.dates[i]];
    for (let k = 0; k < 6; k++) {
      const r = await engine.tick();
      if (['hold', 'waiting', 'blocked'].includes(r.action)) break;
    }
    broker.settle();
    const invested = Object.entries(paper.positions).reduce((v, [s, q]) => v + q * P.close[s][i], 0);
    const pending = paper.unsettled.reduce((a, u) => a + u.amount, 0);
    curve.push([P.dates[i], paper.cash + pending + invested]);
    if (invested < 0.5 * (paper.cash + pending + invested)) idle++;
  }
  return { curve, trades: log.trades, events: log.events, idleDays: idle, final: paper };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const j = args.indexOf(`--${k}`); return j >= 0 ? args[j + 1] : d; };
  const P = loadPrices(path.resolve(get('data', path.join(__dirname, 'data'))));
  const startDate = get('start', '2006-06-01');
  const opts = { startDate, capitalUsd: Number(get('capital', 1000)), cash: Number(get('cash', 1000)), risk: get('risk', 'SPY'), safe: get('safe', 'SHY'), smaMonths: Number(get('sma', 10)) };
  const t0 = Date.now();
  const r = await replay(P, opts);
  const s = stats(r.curve);
  const formula = stats(simulate(P, STRATEGIES.trend, { smaMonths: opts.smaMonths }, { startDate, costBps: 1, capital: opts.cash }).curve);
  console.log(`Replayed ${r.curve.length} trading days (${r.curve[0][0]} to ${r.curve[r.curve.length - 1][0]}) through the real bot code in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Bot:     $${r.curve[r.curve.length - 1][1].toFixed(2)}  CAGR ${s.cagrPct}%  max drawdown ${s.maxDrawdownPct}%  ${r.trades.length} fills`);
  console.log(`Formula: CAGR ${formula.cagrPct}%  max drawdown ${formula.maxDrawdownPct}%  (strategy math, trades the day after month end)`);
  console.log(`Days with more than half the money uninvested: ${r.idleDays}`);
  const y = yearly(r.curve);
  console.log('Yearly:', Object.entries(y).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join('  '));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { replay };
