#!/usr/bin/env node
// Stress test: tries to break a bot before real money does.
//   node bench/stress.js grid
//   node bench/stress.js momentum --samples 100
//   node bench/stress.js grid --cost rh-v2
// Checks (all on data BEFORE the sealed final exam):
//   1. Walk-forward: re-tune on each 90-day window, trade the next 30 days unseen, repeat.
//   2. Market types: those unseen windows grouped into uptrend / downtrend / sideways.
//   3. Plateau: do settings one notch away from the pick still make money?
//   4. Worse costs: wider spread, harder fills.
//   5. Bad luck: thousands of reshuffled histories of the real out-of-sample days.
// Writes bench/results/<bot>-stress-<cost>-<date>.html (report card), .json, and
// <bot>-candidate.json (the settings final-exam.js will grade).
// Options: --data DIR --interval 1h|5m --cost NAME --holdout-days 60 --train-days 90
//          --test-days 30 --samples 100 (momentum) --capital 1000 --workers N
//          --params FILE (stress specific settings instead of re-tuning)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDir } = require('./lib/data');
const { Pool } = require('./lib/pool');
const { GRID_SPACE, MOMENTUM_SPACE, MOMENTUM_SELECTIVE_SPACE, gridCombos, randomCombos } = require('./lib/spaces');
const { makeFolds, regimeOf, compound, neighbors, bootstrap, grade, CRITERIA, DAY } = require('./lib/stress-core');
const { renderReportCard } = require('./lib/report-card');

function parseArgs(argv) {
  const out = { bot: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const fmt = (t) => new Date(t).toISOString().slice(0, 10);
const score = (s, minTrades) => ((s.trades || 0) < minTrades ? -Infinity : s.returnPct - 0.5 * s.maxDrawdownPct);

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!['grid', 'momentum'].includes(a.bot)) {
    console.error('Usage: node bench/stress.js grid|momentum [--cost rh-default|rh-v2] [--samples 100] [--params file.json]');
    process.exit(1);
  }
  const bot = a.bot;
  const dataDir = path.resolve(a.data || path.join(__dirname, 'data'));
  const interval = a.interval || (bot === 'grid' ? '1h' : '5m');
  const cost = a.cost || 'rh-default';
  const capital = Number(a.capital || 1000);
  const holdoutDays = Number(a['holdout-days'] ?? 60);
  const trainDays = Number(a['train-days'] || 90);
  const testDays = Number(a['test-days'] || 30);
  const workers = Number(a.workers || Math.max(1, os.cpus().length - 1));
  const space = bot === 'grid' ? GRID_SPACE : a.space === 'selective' ? MOMENTUM_SELECTIVE_SPACE : MOMENTUM_SPACE;
  const perDay = interval === '1h' ? 24 : interval === '15m' ? 96 : 288;

  const all = loadDir(dataDir, interval);
  const series = bot === 'grid' ? { SOL: all.SOL } : all;
  if (bot === 'grid' && !all.SOL) throw new Error(`No SOL-${interval}.csv in ${dataDir}. Run: node bench/fetch-data.js --days 365`);
  let t0 = Infinity; let dataEnd = -Infinity;
  for (const arr of Object.values(series)) { t0 = Math.min(t0, arr[0].t); dataEnd = Math.max(dataEnd, arr[arr.length - 1].t); }
  const tEnd = dataEnd - holdoutDays * DAY;
  const folds = makeFolds(t0, tEnd, trainDays, testDays);
  if (folds.length < 3) {
    throw new Error(`Only ${folds.length} walk-forward windows fit in ${((tEnd - t0) / DAY).toFixed(0)} days (after the ${holdoutDays}-day sealed exam). ` +
      'Fetch more history: node bench/fetch-data.js --days 365');
  }

  const fixedParams = a.params ? JSON.parse(fs.readFileSync(path.resolve(a.params), 'utf8')) : null;
  const combos = fixedParams ? null : bot === 'grid' ? [...gridCombos(space)] : randomCombos(space, Number(a.samples || 100), Number(a.seed || 1));
  const minTrades = bot === 'grid' ? Math.max(3, Math.round(trainDays / 20)) : Math.max(5, Math.round(trainDays / 6));
  console.log(`${bot} stress test, cost ${cost}, ${workers} workers`);
  console.log(`history ${fmt(t0)} -> ${fmt(tEnd)} (${folds.length} windows of ${trainDays}d train + ${testDays}d test). Sealed exam ${fmt(tEnd)} -> ${fmt(dataEnd)} is NOT used.`);

  const pool = new Pool(workers, dataDir);
  const run = (params, opts, detail = false) => pool.run({ bot, interval, params, detail, opts: { cost, capital, sampleEvery: perDay, ...opts } });
  const started = Date.now();
  const progress = (label, done, total) => {
    const line = `  ${label} ${done}/${total} (${((Date.now() - started) / 1000).toFixed(0)}s)`;
    if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
    else if (done === total || done % Math.max(1, Math.round(total / 10)) === 0) console.log(line);
  };

  // ---------- 1+2. walk-forward ----------
  let done = 0;
  const totalTrain = fixedParams ? 0 : folds.length * combos.length;
  const foldResults = await Promise.all(folds.map(async (f, i) => {
    let pick = fixedParams;
    let trainStats = null;
    if (!fixedParams) {
      const results = await Promise.all(combos.map((p) => run(p, { start: f.trainStart, end: f.trainEnd }).then((r) => { progress('tuning', ++done, totalTrain); return r; })));
      const ranked = results.filter((r) => r.ok).map((r) => ({ ...r, score: score(r.stats, minTrades) })).sort((x, y) => y.score - x.score);
      const best = ranked.find((r) => Number.isFinite(r.score)) || ranked[0];
      pick = best.params;
      trainStats = best.stats;
    }
    const test = await run(pick, { start: f.testStart, end: f.testEnd }, true);
    if (!test.ok) throw new Error(`Fold ${i + 1} test failed: ${test.error}`);
    return { ...f, index: i + 1, params: pick, train: trainStats, test: test.stats, daily: test.daily, curve: test.curve, regime: regimeOf(test.stats.holdReturnPct) };
  }));
  console.log('');

  const regimes = ['uptrend', 'sideways', 'downtrend'].map((r) => {
    const fs2 = foldResults.filter((f) => f.regime === r);
    if (!fs2.length) return null;
    const avg = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
    return { regime: r, windows: fs2.length, avgReturnPct: +avg(fs2.map((f) => f.test.returnPct)).toFixed(2), avgHoldPct: +avg(fs2.map((f) => f.test.holdReturnPct)).toFixed(2), winShare: fs2.filter((f) => f.test.returnPct > 0).length / fs2.length };
  }).filter(Boolean);

  // ---------- candidate: what you'd deploy today = settings tuned on the latest window ----------
  const candidate = fixedParams || foldResults[foldResults.length - 1].params;

  // Every check below runs each window's OWN picked settings on that window's unseen days.
  // (Reusing the latest settings across all windows would test them on days they were tuned on.)
  const walk = async (paramsFor, opts = {}) => {
    const rs = await Promise.all(foldResults.map((f) => run(paramsFor(f), { start: f.testStart, end: f.testEnd, ...opts })));
    const bad = rs.find((r) => !r.ok);
    if (bad) return { returnPct: NaN, error: bad.error };
    return { returnPct: +compound(rs.map((r) => r.stats.returnPct)).toFixed(2), trades: rs.reduce((x, r) => x + (r.stats.trades || 0), 0) };
  };

  // ---------- 3. plateau: nudge one setting a notch in every window ----------
  process.stdout.write('  plateau ...');
  const base = await walk((f) => f.params);
  const nudges = [];
  for (const [k, values] of Object.entries(space)) {
    if (values.length < 2) continue;
    for (const dir of [-1, 1]) {
      const shift = (p) => {
        const i = values.indexOf(p[k]);
        const j = i + dir;
        return i === -1 || j < 0 || j >= values.length ? null : { ...p, [k]: values[j] };
      };
      // Skip a nudge that is impossible in every window (setting already at the edge everywhere).
      if (!foldResults.some((f) => shift(f.params))) continue;
      nudges.push({ changed: k, from: '', to: dir < 0 ? 'one notch lower' : 'one notch higher', paramsFor: (f) => shift(f.params) || f.params });
    }
  }
  const nbResults = await Promise.all(nudges.map(async ({ paramsFor, ...n }) => ({ ...n, ...(await walk(paramsFor)) })));
  const plateau = { base, neighbors: nbResults.filter((n) => Number.isFinite(n.returnPct)) };

  // ---------- 4. worse costs ----------
  process.stdout.write(' costs ...');
  const { COSTS } = require('./lib/data');
  const c = COSTS[cost];
  const scenarios = [
    { key: 'base', name: `As modeled (${cost})`, opts: {} },
    { key: 'spread+60', name: 'Spread +0.6%', opts: { costOverrides: { spreadBps: c.spreadBps + 60 } } },
    { key: 'spread+110', name: 'Spread +1.1%', opts: { costOverrides: { spreadBps: c.spreadBps + 110 } } },
    { key: 'fills', name: 'Harder fills (price must trade 0.3% through)', opts: { fillBufferBps: 30 } },
    { key: 'fees', name: 'Fees +50%', opts: { costOverrides: { makerFeeBps: c.makerFeeBps * 1.5, takerFeeBps: c.takerFeeBps * 1.5 } } },
    { key: 'all', name: 'All of the above (spread +0.6%, harder fills, fees +50%)', opts: { fillBufferBps: 30, costOverrides: { spreadBps: c.spreadBps + 60, makerFeeBps: c.makerFeeBps * 1.5, takerFeeBps: c.takerFeeBps * 1.5 } } },
  ];
  const costs = await Promise.all(scenarios.map(async (sc) => ({ key: sc.key, name: sc.name, ...(await walk((f) => f.params, sc.opts)) })));

  // ---------- 5. bad luck ----------
  process.stdout.write(' monte carlo ...\n');
  const oosDaily = foldResults.flatMap((f) => f.daily || []);
  const monteCarlo = bootstrap(oosDaily, { sims: 2000, block: 5, seed: 42 });
  pool.close();

  const gradeResult = grade({ folds: foldResults, regimes, plateau, costs, monteCarlo });

  // ---------- stitched out-of-sample equity vs hold ----------
  const holdAt = makeHoldLookup(series, bot);
  const stitched = [];
  const stitchedHold = [];
  let eq = capital;
  let hv = capital;
  for (const f of foldResults) {
    const curve = f.curve || [];
    if (!curve.length) continue;
    const scale = eq / capital;
    const h0 = holdAt(curve[0][0]);
    for (const [t, v] of curve) {
      stitched.push([t, v * scale]);
      const h = holdAt(t);
      stitchedHold.push([t, hv * (h0 && h ? h / h0 : 1)]);
    }
    eq = curve[curve.length - 1][1] * scale;
    const hEnd = holdAt(curve[curve.length - 1][0]);
    hv = hv * (h0 && hEnd ? hEnd / h0 : 1);
  }

  // ---------- outputs ----------
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const base2 = path.join(outDir, `${bot}-stress-${cost}-${stamp}`);
  const summary = {
    bot, cost, interval, capital, generatedAt: new Date().toISOString(),
    history: { start: t0, end: tEnd }, holdout: { start: tEnd, end: dataEnd, days: holdoutDays },
    trainDays, testDays, combosPerWindow: combos ? combos.length : 0, criteria: CRITERIA,
    verdict: gradeResult,
    folds: foldResults.map(({ daily, curve, ...f }) => f),
    regimes, candidate, plateau, costs, monteCarlo,
  };
  fs.writeFileSync(`${base2}.json`, JSON.stringify(summary, null, 2));
  fs.writeFileSync(`${base2}.html`, renderReportCard({ summary, stitched, stitchedHold }));
  fs.writeFileSync(path.join(outDir, `${bot}-candidate.json`), JSON.stringify({
    bot, cost, interval, params: candidate, stressPassed: gradeResult.pass,
    stressReport: path.basename(`${base2}.html`), holdout: summary.holdout, createdAt: summary.generatedAt,
  }, null, 2));

  // ---------- console ----------
  console.log('\nWalk-forward windows (each tuned on the 90 days before, then traded unseen):');
  console.table(foldResults.map((f) => ({ window: f.index, test: `${fmt(f.testStart)}..${fmt(f.testEnd)}`, market: f.regime, bot: f.test.returnPct, hold: f.test.holdReturnPct, trades: f.test.trades, drawdown: f.test.maxDrawdownPct })));
  console.log('\nReport card:');
  for (const ch of gradeResult.checks) console.log(`  ${ch.pass ? 'PASS' : 'FAIL'}  ${ch.name}: ${ch.result}`);
  console.log(`\n${gradeResult.pass ? 'PASSED every check. Next: node bench/final-exam.js ' + bot : 'FAILED. Not ready for real money. See the report for where it breaks.'}`);
  console.log(`Candidate settings: ${JSON.stringify(candidate)}`);
  console.log(`Report: ${base2}.html`);
}

// Price (grid: SOL) or equal-weight basket index (momentum) at time t, for the hold line.
function makeHoldLookup(series, bot) {
  const coins = bot === 'grid' ? ['SOL'] : Object.keys(series).filter((s) => s !== 'SOL');
  const at = (arr, t) => {
    if (!arr.length || t < arr[0].t) return null;
    let lo = 0; let hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid - 1; }
    return arr[lo].c;
  };
  const first = {};
  for (const cn of coins) first[cn] = series[cn][0].c;
  return (t) => {
    const rel = coins.map((cn) => { const p = at(series[cn], t); return p ? p / first[cn] : null; }).filter((x) => x !== null);
    return rel.length ? rel.reduce((x, y) => x + y, 0) / rel.length : null;
  };
}

main().catch((err) => { console.error(err.message); process.exit(1); });
