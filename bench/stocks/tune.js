#!/usr/bin/env node
// Should the live bot change rules? Candidates must beat the current rule (SPY trend, 10 months)
// on bars written down BEFORE running:
//   1. Better Sharpe in at least 3 of 4 five-year stretches of real history
//   2. Better Sharpe in at least 60% of 500 synthetic 20-year histories, at both block sizes
//   3. Median worst drop in synthetic histories at most 3 points deeper
//   4. Full-history CAGR at most 0.5 points lower
const path = require('path');
const { loadPrices, STRATEGIES, simulate, stats } = require('./lib');
const { bootstrap, scenario, SCENARIOS } = require('./synth');

const P = loadPrices(path.join(__dirname, 'data'));
const START = '2006-06-01';
const COST = 5;
const CANDIDATES = {
  'current: SPY trend 10m': ['trend', { smaMonths: 10 }],
  'buffer 1%': ['trendBuffer', { smaMonths: 10, bufferPct: 1 }],
  'buffer 2%': ['trendBuffer', { smaMonths: 10, bufferPct: 2 }],
  'buffer 3%': ['trendBuffer', { smaMonths: 10, bufferPct: 3 }],
  'multi-asset trend 10m': ['multi', { smaMonths: 10, assets: ['SPY', 'EFA', 'IEF', 'GLD'] }],
  'multi-asset trend 8m': ['multi', { smaMonths: 8, assets: ['SPY', 'EFA', 'IEF', 'GLD'] }],
  'multi-asset trend 12m': ['multi', { smaMonths: 12, assets: ['SPY', 'EFA', 'IEF', 'GLD'] }],
  'benchmark: hold SPY': ['hold', {}],
  'benchmark: 4-asset mix, no trend': ['mix', { assets: ['SPY', 'EFA', 'IEF', 'GLD'] }],
};
const run = (p, [name, params], opts = {}) => stats(simulate(p, STRATEGIES[name], params, { costBps: COST, ...opts }).curve);
const BASE = 'current: SPY trend 10m';

// 1. Real history, full and in four stretches.
const STRETCHES = [['2006-06-01', '2011-06-01'], ['2011-06-01', '2016-06-01'], ['2016-06-01', '2021-06-01'], ['2021-06-01', '2027-01-01']];
const real = {};
for (const [n, c] of Object.entries(CANDIDATES)) {
  const full = run(P, c, { startDate: START });
  // Each stretch starts trading at its own date; signals use the history before it.
  const parts = STRETCHES.map(([a, b]) => run(P, c, { startDate: a, endDate: b }));
  real[n] = { full, parts };
}
console.log(`Real history ${START} to ${P.dates[P.dates.length - 1]}, ${COST} bps per side, prices exclude dividends:`);
console.table(Object.fromEntries(Object.entries(real).map(([n, r]) => [n, {
  CAGR: r.full.cagrPct, worstDrop: r.full.maxDrawdownPct, sharpe: r.full.sharpe,
  ...Object.fromEntries(r.parts.map((p, k) => [`sharpe ${STRETCHES[k][0].slice(0, 4)}-${STRETCHES[k][1].slice(2, 4)}`, p.sharpe])),
}])));

// 2. Synthetic histories.
const syms = ['SPY', 'EFA', 'IEF', 'GLD', 'SHY'];
const synth = {};
for (const block of [126, 252]) {
  const res = Object.fromEntries(Object.keys(CANDIDATES).map((n) => [n, []]));
  for (let seed = 1; seed <= 500; seed++) {
    const S = bootstrap(P, { years: 20, block, seed, syms });
    for (const [n, c] of Object.entries(CANDIDATES)) res[n].push(run(S, c, { startDate: S.dates[260] }));
  }
  synth[block] = res;
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * q)]; };
console.log('\n500 synthetic 20-year histories each, stitched from 6-month and 12-month chunks of real days:');
console.table(Object.fromEntries(Object.keys(CANDIDATES).map((n) => {
  const row = {};
  for (const block of [126, 252]) {
    const r = synth[block][n];
    const b = synth[block][BASE];
    const tag = block === 126 ? '6m' : '12m';
    row[`${tag} median CAGR`] = med(r.map((x) => x.cagrPct));
    row[`${tag} bad-luck CAGR (5th pct)`] = pct(r.map((x) => x.cagrPct), 0.05);
    row[`${tag} median worst drop`] = med(r.map((x) => x.maxDrawdownPct));
    row[`${tag} beats current (Sharpe)`] = n === BASE ? '' : `${Math.round((r.filter((x, k) => x.sharpe > b[k].sharpe).length / r.length) * 100)}%`;
  }
  return [n, row];
})));

// 3. Verdict against the written-down bars.
console.log('\nVerdict (bars written before running):');
const base = real[BASE];
for (const n of Object.keys(CANDIDATES)) {
  if (n === BASE || n.startsWith('benchmark')) continue;
  const r = real[n];
  const c1 = r.parts.filter((p, k) => p.sharpe > base.parts[k].sharpe).length;
  const wins = [126, 252].map((bl) => synth[bl][n].filter((x, k) => x.sharpe > synth[bl][BASE][k].sharpe).length / 500);
  const ddWorse = Math.max(...[126, 252].map((bl) => med(synth[bl][n].map((x) => x.maxDrawdownPct)) - med(synth[bl][BASE].map((x) => x.maxDrawdownPct))));
  const cagrGap = r.full.cagrPct - base.full.cagrPct;
  const checks = [c1 >= 3, wins.every((w) => w >= 0.6), ddWorse <= 3, cagrGap >= -0.5];
  console.log(`  ${checks.every(Boolean) ? 'ADOPT' : 'reject'}  ${n.padEnd(24)} stretches ${c1}/4 ${checks[0] ? '✓' : '✗'} | synthetic ${wins.map((w) => Math.round(w * 100) + '%').join('/')} ${checks[1] ? '✓' : '✗'} | worst drop ${ddWorse > 0 ? '+' : ''}${ddWorse.toFixed(1)} ${checks[2] ? '✓' : '✗'} | CAGR ${cagrGap > 0 ? '+' : ''}${cagrGap.toFixed(2)} ${checks[3] ? '✓' : '✗'}`);
}

// 4. Handmade disasters.
console.log('\nHandmade scenarios, total return % (worst drop %):');
console.table(Object.fromEntries(Object.keys(SCENARIOS).map((sc) => {
  const S = scenario(sc);
  return [sc, Object.fromEntries(['current: SPY trend 10m', 'buffer 1%', 'buffer 2%', 'buffer 3%', 'benchmark: hold SPY'].map((n) => {
    const r = run(S, CANDIDATES[n], { startDate: S.dates[260] });
    return [n.replace('current: ', '').replace('benchmark: ', ''), `${r.totalPct} (${r.maxDrawdownPct})`];
  }))];
})));
