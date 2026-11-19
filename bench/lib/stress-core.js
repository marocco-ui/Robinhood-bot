// Pure helpers for the stress test (kept separate so they're easy to unit test).
const DAY = 86400000;

// Rolling walk-forward windows: train on `trainDays`, test on the next `testDays`, then slide
// forward by `testDays`. Test windows never overlap, and each test window is unseen by the
// training run that picked its settings.
function makeFolds(start, end, trainDays, testDays) {
  const folds = [];
  for (let s = start; s + (trainDays + testDays) * DAY <= end + DAY; s += testDays * DAY) {
    const trainEnd = s + trainDays * DAY;
    folds.push({ trainStart: s, trainEnd, testStart: trainEnd, testEnd: Math.min(trainEnd + testDays * DAY, end) });
  }
  return folds;
}

// Market type of a window from the benchmark's return over it.
function regimeOf(holdReturnPct, threshold = 10) {
  if (holdReturnPct >= threshold) return 'uptrend';
  if (holdReturnPct <= -threshold) return 'downtrend';
  return 'sideways';
}

function compound(returnsPct) {
  return (returnsPct.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100;
}

// Settings one step away from `params` in each direction, along each axis of `space`.
function neighbors(params, space) {
  const out = [];
  for (const [k, values] of Object.entries(space)) {
    const i = values.indexOf(params[k]);
    if (i === -1) continue;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= values.length) continue;
      out.push({ changed: k, from: params[k], to: values[j], params: { ...params, [k]: values[j] } });
    }
  }
  return out;
}

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

// Block bootstrap of daily returns: reshuffles real out-of-sample days (in 5-day blocks, to
// keep streaks) into thousands of alternate histories, to see how bad luck could get.
function bootstrap(daily, { sims = 2000, block = 5, seed = 42 } = {}) {
  if (daily.length < block * 2) return null;
  const rnd = mulberry32(seed);
  const n = daily.length;
  const finals = [];
  const dds = [];
  for (let k = 0; k < sims; k++) {
    let v = 1;
    let peak = 1;
    let dd = 0;
    let filled = 0;
    while (filled < n) {
      const startIdx = Math.floor(rnd() * (n - block + 1));
      for (let j = 0; j < block && filled < n; j++, filled++) {
        v *= 1 + daily[startIdx + j];
        peak = Math.max(peak, v);
        dd = Math.max(dd, (peak - v) / peak);
      }
    }
    finals.push((v - 1) * 100);
    dds.push(dd * 100);
  }
  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  return {
    sims,
    days: n,
    probLossPct: +((finals.filter((x) => x < 0).length / sims) * 100).toFixed(1),
    p5ReturnPct: +percentile(finals, 5).toFixed(2),
    medianReturnPct: +percentile(finals, 50).toFixed(2),
    p95ReturnPct: +percentile(finals, 95).toFixed(2),
    medianMaxDrawdownPct: +percentile(dds, 50).toFixed(2),
    p95MaxDrawdownPct: +percentile(dds, 95).toFixed(2),
    histogram: histogram(finals, 24),
  };
}

function histogram(values, bins) {
  const lo = values[0];
  const hi = values[values.length - 1];
  const w = (hi - lo) / bins || 1;
  const counts = Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
  return counts.map((c, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, count: c }));
}

// Pass/fail thresholds. Deliberately strict: a bot has to survive all of them.
const CRITERIA = {
  walkForwardMinReturnPct: 0,      // compounded out-of-sample return must be positive
  walkForwardMinWinFolds: 0.55,    // and most test windows profitable
  regimeWorstAvgPct: -8,           // no market type may average worse than this per window
  plateauMinShare: 0.7,            // 70% of neighboring settings still profitable
  costSpreadBumpBps: 60,           // still profitable with the spread 0.6% wider
  monteCarloMaxProbLoss: 35,       // at most a 35% chance of losing money
  monteCarloMaxP95Drawdown: 25,    // bad-luck (95th percentile) drawdown under 25%
};

function grade({ folds, regimes, plateau, costs, monteCarlo }, c = CRITERIA) {
  const checks = [];
  const oos = compound(folds.map((f) => f.test.returnPct));
  const winShare = folds.filter((f) => f.test.returnPct > 0).length / (folds.length || 1);
  checks.push({
    name: 'Walk-forward (out of sample)',
    pass: folds.length > 0 && oos > c.walkForwardMinReturnPct && winShare >= c.walkForwardMinWinFolds,
    result: `${oos >= 0 ? '+' : ''}${oos.toFixed(2)}% total, ${Math.round(winShare * 100)}% of ${folds.length} windows profitable`,
    rule: `total > ${c.walkForwardMinReturnPct}% and ≥ ${Math.round(c.walkForwardMinWinFolds * 100)}% of windows profitable`,
  });
  const worst = regimes.length ? regimes.reduce((a, b) => (b.avgReturnPct < a.avgReturnPct ? b : a)) : null;
  checks.push({
    name: 'Every market type',
    pass: Boolean(worst) && worst.avgReturnPct > c.regimeWorstAvgPct,
    result: worst ? `worst: ${worst.regime} averages ${worst.avgReturnPct.toFixed(2)}% per window` : 'no windows',
    rule: `no market type averages below ${c.regimeWorstAvgPct}% per window`,
  });
  const profitableShare = plateau.neighbors.length ? plateau.neighbors.filter((n) => n.returnPct > 0).length / plateau.neighbors.length : 0;
  checks.push({
    name: 'Stable settings (plateau)',
    pass: plateau.base.returnPct > 0 && profitableShare >= c.plateauMinShare,
    result: `base ${plateau.base.returnPct.toFixed(2)}%, ${Math.round(profitableShare * 100)}% of ${plateau.neighbors.length} nearby settings profitable`,
    rule: `base profitable and ≥ ${Math.round(c.plateauMinShare * 100)}% of nearby settings profitable`,
  });
  const bump = costs.find((x) => x.key === 'spread+60');
  checks.push({
    name: 'Worse costs',
    pass: Boolean(bump) && bump.returnPct > 0,
    result: bump ? `${bump.returnPct >= 0 ? '+' : ''}${bump.returnPct.toFixed(2)}% with spread +0.6%` : 'n/a',
    rule: 'still profitable with the spread 0.6% wider',
  });
  checks.push({
    name: 'Bad luck (Monte Carlo)',
    pass: Boolean(monteCarlo) && monteCarlo.probLossPct <= c.monteCarloMaxProbLoss && monteCarlo.p95MaxDrawdownPct <= c.monteCarloMaxP95Drawdown,
    result: monteCarlo ? `${monteCarlo.probLossPct}% chance of loss, bad-luck drawdown ${monteCarlo.p95MaxDrawdownPct}%` : 'not enough days',
    rule: `chance of loss ≤ ${c.monteCarloMaxProbLoss}% and 95th-percentile drawdown ≤ ${c.monteCarloMaxP95Drawdown}%`,
  });
  return { checks, pass: checks.every((x) => x.pass), oosReturnPct: oos, winShare };
}

module.exports = { makeFolds, regimeOf, compound, neighbors, bootstrap, grade, CRITERIA, mulberry32, DAY };
