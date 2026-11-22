// Synthetic markets for stress testing.
//   bootstrap(): alternate histories stitched from random blocks of REAL daily returns, all symbols
//                on the same days, so their relationships (stocks down, bonds up) are kept.
//   scenario():  handmade SPY/SHY paths for specific disasters.
// Both return the same shape as loadPrices(), so every strategy and the replay bench can run on them.

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Weekday dates from a start date.
function weekdays(n, start = '2000-01-03') {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function fromReturns(dates, rets, syms, start = 100) {
  // rets[s][k] = [overnight, intraday] returns for day k. Builds open and close series.
  const open = {};
  const close = {};
  for (const s of syms) {
    open[s] = [];
    close[s] = [];
    let c = start;
    for (let k = 0; k < dates.length; k++) {
      const [on, intra] = rets[s][k];
      const o = c * (1 + on);
      c = o * (1 + intra);
      open[s].push(o);
      close[s].push(c);
    }
  }
  const monthEnds = [];
  for (let i = 0; i < dates.length - 1; i++) if (dates[i].slice(0, 7) !== dates[i + 1].slice(0, 7)) monthEnds.push(i);
  return { dates, open, close, syms, monthEnds };
}

// Alternate history: `years` long, built from random `block`-day runs of real days.
function bootstrap(P, { years = 20, block = 126, seed = 1, syms = P.syms } = {}) {
  const r = rng(seed);
  const n = Math.round(years * 252);
  const dates = weekdays(n);
  const rets = Object.fromEntries(syms.map((s) => [s, []]));
  while (rets[syms[0]].length < n) {
    const k0 = 1 + Math.floor(r() * (P.dates.length - block - 1));
    for (let k = k0; k < k0 + block && rets[syms[0]].length < n; k++) {
      for (const s of syms) rets[s].push([P.open[s][k] / P.close[s][k - 1] - 1, P.close[s][k] / P.open[s][k] - 1]);
    }
  }
  return fromReturns(dates, rets, syms);
}

// Handmade scenarios. Each phase: [trading days, total SPY move]. SHY drifts +3%/yr throughout.
const SCENARIOS = {
  'crash then V (COVID-like)': [[504, 0.25], [23, -0.34], [126, 0.45], [252, 0.15]],
  'long bear (2008-like)': [[504, 0.25], [357, -0.55], [504, 0.6]],
  'slow bleed (2022-like)': [[504, 0.25], [252, -0.25], [252, 0.2]],
  'whipsaw: flat, big swings': [[252, 0.1], ...Array.from({ length: 12 }, (_, i) => [42, i % 2 ? 0.07 : -0.07]), [252, 0.1]],
  'steady melt-up': [[1260, 1.0]],
  'lost decade (2000-2009-like)': [[252, 0.1], [630, -0.45], [756, 0.9], [378, -0.5], [504, 0.5]],
};

function scenario(name, { noise = 0.008, seed = 7 } = {}) {
  const phases = SCENARIOS[name];
  if (!phases) throw new Error(`Unknown scenario ${name}`);
  const r = rng(seed);
  const n = phases.reduce((a, [d]) => a + d, 0) + 300; // 300 warm-up days (flat-ish up)
  const dates = weekdays(n);
  const spy = [];
  const all = [[300, 0.08], ...phases];
  for (const [days, total] of all) {
    const drift = Math.log(1 + total) / days;
    // Daily noise, re-centred so each phase lands exactly on its total move.
    const z = Array.from({ length: days }, () => (r() + r() + r() - 1.5) * 2 * noise);
    const mean = z.reduce((a, b) => a + b, 0) / days;
    for (let k = 0; k < days; k++) spy.push(drift + z[k] - mean);
  }
  const shyDaily = Math.log(1.03) / 252;
  const rets = { SPY: [], SHY: [] };
  for (const g of spy) {
    const total = Math.exp(g) - 1;
    rets.SPY.push([total * 0.3, (1 + total) / (1 + total * 0.3) - 1]); // 30% of the move overnight
    rets.SHY.push([0, Math.exp(shyDaily) - 1]);
  }
  return fromReturns(dates, rets, ['SPY', 'SHY']);
}

module.exports = { bootstrap, scenario, SCENARIOS, rng };
