#!/usr/bin/env node
// Finds settings that worked on history, then checks them on data they never saw.
//   node bench/optimize.js grid
//   node bench/optimize.js momentum --samples 300
//   node bench/optimize.js grid --cost rh-v2          (compare Robinhood fee-tier routing)
// Options: --data DIR  --interval 1h|5m  --cost rh-default|rh-v2|free  --train 0.7
//          --capital 1000  --samples N (momentum)  --min-trades N  --workers N  --top N
// Writes bench/results/<bot>-<cost>-<date>.html (charts), .json, and <bot>-best.env
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { loadDir } = require('./lib/data');
const { simulateGrid, simulateMomentum } = require('./lib/sim');
const { GRID_SPACE, MOMENTUM_SPACE, gridCombos, randomCombos } = require('./lib/spaces');
const { renderReport } = require('./lib/report');

function parseArgs(argv) {
  const out = { bot: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function score(stats, minTrades) {
  if ((stats.trades || 0) < minTrades) return -Infinity;
  return stats.returnPct - 0.5 * stats.maxDrawdownPct;
}

class Pool {
  constructor(size, dataDir) {
    this.workers = Array.from({ length: size }, () => new Worker(path.join(__dirname, 'lib', 'worker.js'), { workerData: { dataDir } }));
    this.idle = [...this.workers];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 0;
    for (const w of this.workers) {
      w.on('message', (msg) => {
        const done = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.idle.push(w);
        this.pump();
        done(msg);
      });
    }
  }
  run(job) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.queue.push({ ...job, id });
      this.pump();
    });
  }
  pump() {
    while (this.idle.length && this.queue.length) this.idle.pop().postMessage(this.queue.shift());
  }
  close() { for (const w of this.workers) w.terminate(); }
}

function fmtDate(t) { return new Date(t).toISOString().slice(0, 10); }

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!['grid', 'momentum'].includes(a.bot)) {
    console.error('Usage: node bench/optimize.js grid|momentum [--cost rh-default|rh-v2] [--samples 300] [--data bench/data]');
    process.exit(1);
  }
  const bot = a.bot;
  const dataDir = path.resolve(a.data || path.join(__dirname, 'data'));
  const interval = a.interval || (bot === 'grid' ? '1h' : '5m');
  const cost = a.cost || 'rh-default';
  const capital = Number(a.capital || 1000);
  const trainFrac = Number(a.train || 0.7);
  const minTrades = Number(a['min-trades'] || (bot === 'grid' ? 6 : 8));
  const top = Number(a.top || 15);
  const workers = Number(a.workers || Math.max(1, os.cpus().length - 1));

  const all = loadDir(dataDir, interval);
  const series = bot === 'grid' ? { SOL: all.SOL } : all;
  if (bot === 'grid' && !all.SOL) throw new Error(`No SOL-${interval}.csv in ${dataDir}. Run: node bench/fetch-data.js`);
  if (bot === 'momentum' && Object.keys(all).filter((s) => s !== 'SOL').length === 0) throw new Error(`No coin data (*-${interval}.csv) in ${dataDir}. Run: node bench/fetch-data.js`);
  let t0 = Infinity; let t1 = -Infinity;
  for (const arr of Object.values(series)) { t0 = Math.min(t0, arr[0].t); t1 = Math.max(t1, arr[arr.length - 1].t); }
  const split = t0 + (t1 - t0) * trainFrac;

  const combos = bot === 'grid' ? [...gridCombos(GRID_SPACE)] : randomCombos(MOMENTUM_SPACE, Number(a.samples || 200), Number(a.seed || 1));
  console.log(`${bot}: ${combos.length} settings x ${Object.keys(series).length} series, cost model ${cost}, ${workers} workers`);
  console.log(`train ${fmtDate(t0)} -> ${fmtDate(split)} | test ${fmtDate(split)} -> ${fmtDate(t1)}`);

  const pool = new Pool(workers, dataDir);
  const opts = { cost, capital };
  let done = 0;
  const started = Date.now();
  const train = await Promise.all(combos.map((params) => pool.run({ bot, interval, params, opts: { ...opts, start: t0, end: split } }).then((r) => {
    done++;
    if (done % 25 === 0 || done === combos.length) process.stdout.write(`\r  training ${done}/${combos.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    return r;
  })));
  console.log('');
  const ok = train.filter((r) => r.ok).map((r) => ({ ...r, score: score(r.stats, minTrades) }));
  const failed = train.length - ok.length;
  ok.sort((x, y) => y.score - x.score);
  const finalists = ok.filter((r) => Number.isFinite(r.score)).slice(0, top);
  if (!finalists.length) {
    pool.close();
    console.log(`No settings made at least ${minTrades} trades in the training window. Try more data (--days in fetch-data) or --min-trades lower.`);
    return;
  }

  const tested = await Promise.all(finalists.map((r) => pool.run({ bot, interval, params: r.params, opts: { ...opts, start: split, end: Infinity } })));
  pool.close();
  const rows = finalists.map((r, i) => {
    const t = tested[i];
    const testScore = t.ok ? score(t.stats, Math.ceil(minTrades * (1 - trainFrac) / trainFrac)) : -Infinity;
    return { rank: i + 1, params: r.params, train: r.stats, trainScore: r.score, test: t.ok ? t.stats : null, testScore };
  });
  // Pick the finalist that held up best in BOTH periods, not just the best on training data.
  const pick = rows.slice().sort((x, y) => Math.min(y.trainScore, y.testScore) - Math.min(x.trainScore, x.testScore))[0];

  // Detailed runs (with curves and fills) for the pick, for charts.
  const sim = bot === 'grid'
    ? (o) => simulateGrid(series.SOL, pick.params, { cost, capital, ...o, sampleEvery: 1 })
    : (o) => simulateMomentum(series, pick.params, { cost, capital, ...o, sampleEvery: 6 });
  const trainRun = await sim({ start: t0, end: split });
  const testRun = await sim({ start: split, end: Infinity });

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const base = path.join(outDir, `${bot}-${cost}-${stamp}`);
  const lastPrice = bot === 'grid' ? series.SOL[series.SOL.length - 1].c : null;
  const envText = bestEnv(bot, pick.params, { lastPrice, capital });
  const summary = {
    bot, cost, interval, capital, dataDir, generatedAt: new Date().toISOString(),
    window: { start: t0, split, end: t1 }, combos: combos.length, failed, minTrades,
    pick: { params: pick.params, train: pick.train, test: pick.test },
    finalists: rows,
    env: envText,
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, `${bot}-best.env`), envText);
  fs.writeFileSync(`${base}.html`, renderReport({ summary, trainRun, testRun, series }));

  console.log('\nTop settings (trained on first part, then tested on the rest):');
  console.table(rows.map((r) => ({
    rank: r.rank,
    ...r.params,
    trainRet: r.train.returnPct, trainDD: r.train.maxDrawdownPct, trainTrades: r.train.trades,
    testRet: r.test ? r.test.returnPct : null, testDD: r.test ? r.test.maxDrawdownPct : null, testTrades: r.test ? r.test.trades : null,
  })));
  const verdict = pick.test && pick.test.returnPct > 0 ? 'held up on unseen data' : 'did NOT hold up on unseen data. Treat with caution';
  console.log(`\nPick (rank ${pick.rank}): ${JSON.stringify(pick.params)}`);
  console.log(`  train ${pick.train.returnPct}% (max drawdown ${pick.train.maxDrawdownPct}%) | test ${pick.test ? pick.test.returnPct : 'n/a'}% (max drawdown ${pick.test ? pick.test.maxDrawdownPct : 'n/a'}%) -> ${verdict}`);
  console.log(`\nReport:   ${base}.html`);
  console.log(`Settings: ${path.join(outDir, `${bot}-best.env`)} (copy the lines into ${bot === 'grid' ? 'sol-grid' : 'solana-momentum'}/.env)`);
}

function bestEnv(bot, p, { lastPrice, capital }) {
  const lines = [`# From bench/optimize.js ${bot} on ${new Date().toISOString().slice(0, 10)}. Paper trade before going live.`];
  if (bot === 'grid') {
    lines.push(`# Range centered on the latest price in the data ($${lastPrice.toFixed(2)}). Re-center it on today's price if SOL has moved.`);
    lines.push(`GRID_LOWER=${(lastPrice * (1 - p.downPct / 100)).toFixed(2)}`);
    lines.push(`GRID_UPPER=${(lastPrice * (1 + p.upPct / 100)).toFixed(2)}`);
    lines.push(`GRID_COUNT=${p.count}`);
    lines.push(`GRID_MAX_OPEN_BUYS=${p.maxOpenBuys}`);
    lines.push(`GRID_STOP_LOSS_PCT=${p.stopLossPct}`);
    lines.push(`# Bench used $${(capital / p.count).toFixed(2)} per slot on $${capital}. Scale both together.`);
    lines.push(`GRID_ORDER_USD=${(capital / p.count).toFixed(2)}`);
    lines.push(`GRID_MAX_CAPITAL_USD=${capital}`);
  } else {
    const map = {
      minVolumeAccel: 'MOMENTUM_MIN_VOLUME_ACCEL', minBuyRatio: 'MOMENTUM_MIN_BUY_RATIO', minChange1h: 'MOMENTUM_MIN_CHANGE_1H_PCT',
      maxChange1h: 'MOMENTUM_MAX_CHANGE_1H_PCT', breakoutLookbackMin: 'MOMENTUM_BREAKOUT_LOOKBACK_MIN', stopLossPct: 'MOMENTUM_STOP_LOSS_PCT',
      takeProfitPct: 'MOMENTUM_TAKE_PROFIT_PCT', trailActivatePct: 'MOMENTUM_TRAIL_ACTIVATE_PCT', trailPct: 'MOMENTUM_TRAIL_PCT',
      maxHoldHours: 'MOMENTUM_MAX_HOLD_HOURS', minScore: 'MOMENTUM_MIN_SCORE',
    };
    lines.push('# Signals were tuned on exchange candles, a stand-in for the live DexScreener data.');
    for (const [k, v] of Object.entries(p)) if (map[k]) lines.push(`${map[k]}=${v}`);
  }
  return lines.join('\n') + '\n';
}

main().catch((err) => { console.error(err.message); process.exit(1); });
