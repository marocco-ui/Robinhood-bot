// Monthly ETF rotation strategies on daily data. Zero dependencies.
// Signals use closes up to the last trading day of a month; trades fill at the next day's open.
const fs = require('fs');
const path = require('path');

function loadPrices(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
  const raw = {};
  for (const f of files) {
    const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
    raw[path.basename(f, '.csv')] = new Map(rows.map((r) => [r[0], { o: +r[1], c: +r[4] }]));
  }
  // Keep only dates every symbol has, so all series line up index by index.
  const syms = Object.keys(raw);
  const dates = [...raw[syms[0]].keys()].filter((d) => syms.every((s) => raw[s].has(d))).sort();
  const open = {};
  const close = {};
  for (const s of syms) {
    open[s] = dates.map((d) => raw[s].get(d).o);
    close[s] = dates.map((d) => raw[s].get(d).c);
  }
  const monthEnds = [];
  for (let i = 0; i < dates.length - 1; i++) if (dates[i].slice(0, 7) !== dates[i + 1].slice(0, 7)) monthEnds.push(i);
  return { dates, open, close, syms, monthEnds };
}

// ---------- signals (all use data at or before index i) ----------
const ret = (P, s, i, months) => {
  const j = P.monthEnds[P.monthEnds.indexOf(i) - months];
  return j === undefined ? null : P.close[s][i] / P.close[s][j] - 1;
};
const sma = (P, s, i, months) => {
  const k = P.monthEnds.indexOf(i);
  if (k < months - 1) return null;
  let sum = 0;
  for (let m = 0; m < months; m++) sum += P.close[s][P.monthEnds[k - m]];
  return sum / months;
};

const SECTORS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB'];

// Each strategy: (P, i, params) -> { SYMBOL: weight } summing to 1, or null if not enough history.
const STRATEGIES = {
  // Buy and hold the S&P 500.
  hold: { params: {}, space: {}, fn: () => ({ SPY: 1 }) },

  // Faber (2007): hold SPY above its 10-month moving average, else short-term Treasuries.
  trend: {
    params: { smaMonths: 10 },
    space: { smaMonths: [6, 8, 10, 12] },
    fn: (P, i, p) => {
      const m = sma(P, 'SPY', i, p.smaMonths);
      if (m === null) return null;
      return P.close.SPY[i] > m ? { SPY: 1 } : { SHY: 1 };
    },
  },

  // Antonacci Global Equity Momentum (2012-2014): if US stocks beat T-bills over 12 months,
  // hold the stronger of US or international stocks; otherwise hold bonds.
  gem: {
    params: { lookback: 12 },
    space: { lookback: [6, 9, 12, 15] },
    fn: (P, i, p) => {
      const us = ret(P, 'SPY', i, p.lookback);
      const intl = ret(P, 'EFA', i, p.lookback);
      const bills = ret(P, 'SHY', i, p.lookback);
      if (us === null) return null;
      if (us <= bills) return { IEF: 1 };
      return us >= intl ? { SPY: 1 } : { EFA: 1 };
    },
  },

  // Sector momentum (industry momentum, Moskowitz and Grinblatt 1999): hold the top N of 9
  // sectors by trailing return, but go to T-bills when SPY is below its 10-month average.
  sectors: {
    params: { lookback: 6, top: 3, smaMonths: 10 },
    space: { lookback: [3, 6, 9, 12], top: [2, 3, 4], smaMonths: [0, 10] },
    fn: (P, i, p) => {
      const scores = SECTORS.map((s) => [s, ret(P, s, i, p.lookback)]);
      if (scores.some(([, r]) => r === null)) return null;
      if (p.smaMonths) {
        const m = sma(P, 'SPY', i, p.smaMonths);
        if (m === null) return null;
        if (P.close.SPY[i] <= m) return { SHY: 1 };
      }
      const picks = scores.sort((a, b) => b[1] - a[1]).slice(0, p.top).map(([s]) => s);
      return Object.fromEntries(picks.map((s) => [s, 1 / picks.length]));
    },
  },
};

// ---------- simulation ----------
// Rebalances at the open after each month end. costBps is charged on the value traded, each side.
function simulate(P, strat, params, { startDate, endDate, costBps = 5, capital = 10000 } = {}) {
  const { dates, open, close } = P;
  const start = startDate ? dates.findIndex((d) => d >= startDate) : 0;
  let end = endDate ? dates.findIndex((d) => d >= endDate) : dates.length;
  if (end === -1) end = dates.length;
  let cash = capital;
  let shares = {};
  let target = null;
  let pending = null;
  let turnover = 0;
  let trades = 0;
  const curve = [];
  const isMonthEnd = new Set(P.monthEnds);
  for (let i = start; i < end; i++) {
    if (pending) {
      // Trade at today's open.
      const value = cash + Object.entries(shares).reduce((v, [s, q]) => v + q * open[s][i], 0);
      const next = {};
      let traded = 0;
      const syms = new Set([...Object.keys(shares), ...Object.keys(pending)]);
      for (const s of syms) {
        const want = (pending[s] || 0) * value;
        const have = (shares[s] || 0) * open[s][i];
        traded += Math.abs(want - have);
        if (pending[s]) next[s] = want / open[s][i];
      }
      const cost = (traded * costBps) / 1e4;
      // Scale holdings down to pay the cost.
      const scale = (value - cost) / value;
      for (const s of Object.keys(next)) next[s] *= scale;
      if (traded > value * 0.001) trades++;
      turnover += traded / value;
      shares = next;
      cash = 0;
      pending = null;
    }
    const eq = cash + Object.entries(shares).reduce((v, [s, q]) => v + q * close[s][i], 0);
    curve.push([dates[i], eq]);
    if (isMonthEnd.has(i) && i < end - 1) {
      const w = strat.fn(P, i, params);
      if (w && JSON.stringify(w) !== JSON.stringify(target)) { pending = w; target = w; }
      else if (w && !Object.keys(shares).length) pending = w;
    }
  }
  return { curve, turnover, trades };
}

function stats(curve) {
  if (curve.length < 2) return null;
  const years = (Date.parse(curve[curve.length - 1][0]) - Date.parse(curve[0][0])) / (365.25 * 864e5);
  const total = curve[curve.length - 1][1] / curve[0][1];
  let peak = -Infinity;
  let mdd = 0;
  const daily = [];
  for (let k = 0; k < curve.length; k++) {
    const v = curve[k][1];
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, 1 - v / peak);
    if (k) daily.push(v / curve[k - 1][1] - 1);
  }
  const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / daily.length);
  return {
    cagrPct: +((total ** (1 / years) - 1) * 100).toFixed(2),
    totalPct: +((total - 1) * 100).toFixed(1),
    maxDrawdownPct: +(mdd * 100).toFixed(1),
    sharpe: +(sd ? (mean / sd) * Math.sqrt(252) : 0).toFixed(2),
    years: +years.toFixed(1),
  };
}

function yearly(curve) {
  const out = {};
  let prev = curve[0][1];
  for (let k = 0; k < curve.length; k++) {
    const y = curve[k][0].slice(0, 4);
    const last = k === curve.length - 1 || curve[k + 1][0].slice(0, 4) !== y;
    if (last) { out[y] = +((curve[k][1] / prev - 1) * 100).toFixed(1); prev = curve[k][1]; }
  }
  return out;
}

function combos(space) {
  const keys = Object.keys(space);
  if (!keys.length) return [{}];
  const out = [];
  const rec = (k, acc) => {
    if (k === keys.length) { out.push({ ...acc }); return; }
    for (const v of space[keys[k]]) rec(k + 1, { ...acc, [keys[k]]: v });
  };
  rec(0, {});
  return out;
}

module.exports = { loadPrices, STRATEGIES, simulate, stats, yearly, combos, SECTORS };
