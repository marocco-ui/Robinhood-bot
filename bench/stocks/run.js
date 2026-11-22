#!/usr/bin/env node
// Stock strategy stress test. Every strategy runs with the settings its authors published,
// so nothing is tuned on this data. Then: market periods, every nearby setting, worse costs,
// and reshuffled bad-luck histories.
//
//   node bench/stocks/run.js [--data DIR] [--start 2006-06-01] [--cost 5]
const path = require('path');
const fs = require('fs');
const { loadPrices, STRATEGIES, simulate, stats, yearly, combos } = require('./lib');

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dataDir = path.resolve(get('data', path.join(__dirname, 'data')));
const start = get('start', '2006-06-01');
const costBps = Number(get('cost', 5));
const P = loadPrices(dataDir);

// Market periods to check separately.
const PERIODS = [
  ['2008 crash', '2007-10-09', '2009-03-10'],
  ['Recovery 2009-2012', '2009-03-10', '2013-01-01'],
  ['Bull 2013-2019', '2013-01-01', '2020-02-19'],
  ['COVID crash', '2020-02-19', '2020-03-24'],
  ['Rebound 2020-2021', '2020-03-24', '2022-01-03'],
  ['2022 bear', '2022-01-03', '2022-10-13'],
  ['2022-now', '2022-10-13', '2027-01-01'],
];

function sub(curve, a, b) {
  const s = curve.filter(([d]) => d >= a && d < b);
  return s.length > 1 ? +((s[s.length - 1][1] / s[0][1] - 1) * 100).toFixed(1) : null;
}

// Block bootstrap of monthly returns: chance of trailing SPY over 5 years.
function monthly(curve) {
  const out = [];
  for (let k = 1; k < curve.length; k++) if (curve[k][0].slice(0, 7) !== curve[k - 1][0].slice(0, 7)) out.push(curve[k - 1][1]);
  out.push(curve[curve.length - 1][1]);
  return out.slice(1).map((v, k) => v / out[k] - 1);
}
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapVsHold(stratM, holdM, { months = 60, block = 6, sims = 3000 } = {}) {
  const n = Math.min(stratM.length, holdM.length);
  const r = rng(7);
  let behind = 0;
  let lose = 0;
  for (let s = 0; s < sims; s++) {
    let a = 1;
    let b = 1;
    for (let m = 0; m < months; m += block) {
      const k = Math.floor(r() * (n - block));
      for (let j = 0; j < block && m + j < months; j++) { a *= 1 + stratM[k + j]; b *= 1 + holdM[k + j]; }
    }
    if (a < b) behind++;
    if (a < 1) lose++;
  }
  return { probTrailHoldPct: +((behind / sims) * 100).toFixed(1), probLossPct: +((lose / sims) * 100).toFixed(1) };
}

const results = {};
const hold = simulate(P, STRATEGIES.hold, {}, { startDate: start, costBps });
const holdM = monthly(hold.curve);
for (const [name, strat] of Object.entries(STRATEGIES).filter(([n]) => ['hold', 'trend', 'gem', 'sectors'].includes(n))) {
  const run = name === 'hold' ? hold : simulate(P, strat, strat.params, { startDate: start, costBps });
  const s = stats(run.curve);
  const r = { params: strat.params, ...s, tradesPerYear: +(run.trades / s.years).toFixed(1), turnoverPerYear: +(run.turnover / s.years).toFixed(2) };
  r.periods = Object.fromEntries(PERIODS.map(([n, a, b]) => [n, sub(run.curve, a, b)]));
  r.yearly = yearly(run.curve);
  if (name !== 'hold') {
    // Every combination in the setting grid, not just one notch: how many beat holding?
    const grid = combos(strat.space).map((p) => ({ p, ...stats(simulate(P, strat, p, { startDate: start, costBps }).curve) }));
    r.grid = { tried: grid.length, beatHoldCagr: grid.filter((g) => g.cagrPct > s.cagrPct * 0 + results.hold.cagrPct).length, beatHoldSharpe: grid.filter((g) => g.sharpe > results.hold.sharpe).length, worstCagr: Math.min(...grid.map((g) => g.cagrPct)), bestCagr: Math.max(...grid.map((g) => g.cagrPct)) };
    r.costs = Object.fromEntries([5, 25, 50].map((c) => [`${c}bps`, stats(simulate(P, strat, strat.params, { startDate: start, costBps: c }).curve).cagrPct]));
    r.luck = bootstrapVsHold(monthly(run.curve), holdM);
  }
  r.curve = run.curve.filter((_, k) => k % 5 === 0);
  results[name] = r;
}

const fmt = (x) => (x === null || x === undefined ? '' : `${x > 0 ? '+' : ''}${x}`);
console.log(`Data ${P.dates[0]} -> ${P.dates[P.dates.length - 1]}, trading from ${start}, cost ${costBps}bps per side, prices exclude dividends.\n`);
console.table(Object.fromEntries(Object.entries(results).map(([n, r]) => [n, { CAGR: r.cagrPct, total: r.totalPct, maxDD: r.maxDrawdownPct, sharpe: r.sharpe, tradesYr: r.tradesPerYear }])));
console.log('Return by market period (%):');
console.table(Object.fromEntries(PERIODS.map(([p]) => [p, Object.fromEntries(Object.entries(results).map(([n, r]) => [n, fmt(r.periods[p])]))])));
console.log('Robustness:');
console.table(Object.fromEntries(Object.entries(results).filter(([n]) => n !== 'hold').map(([n, r]) => [n, {
  'settings tried': r.grid.tried, 'beat hold CAGR': r.grid.beatHoldCagr, 'beat hold Sharpe': r.grid.beatHoldSharpe, 'CAGR range': `${r.grid.worstCagr}..${r.grid.bestCagr}`,
  'CAGR @25bps': r.costs['25bps'], 'CAGR @50bps': r.costs['50bps'], '5yr: P(trail hold)': `${r.luck.probTrailHoldPct}%`, '5yr: P(loss)': `${r.luck.probLossPct}%`,
}])));
const yrs = Object.keys(results.hold.yearly);
console.log('Yearly (%):');
console.table(Object.fromEntries(yrs.map((y) => [y, Object.fromEntries(Object.entries(results).map(([n, r]) => [n, r.yearly[y]]))])));
const outDir = path.join(__dirname, '..', 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'stocks-stress.json'), JSON.stringify({ start, costBps, generatedAt: new Date().toISOString(), results }, null, 1));
