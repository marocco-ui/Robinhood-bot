#!/usr/bin/env node
// Final exam: run the stress-tested candidate ONCE on the sealed holdout days it has never seen.
//
//   node bench/final-exam.js grid          (uses bench/results/grid-candidate.json)
//   node bench/final-exam.js momentum
//   options: --data DIR  --capital 1000  --force
//
// Every attempt is written to bench/results/final-exam-ledger.json. Running the exam again on
// the same sealed days, then tweaking settings until it passes, turns the exam into more
// training data and the result stops meaning anything. So a repeat needs --force, and the
// report says how many times those days have been looked at.
const fs = require('fs');
const path = require('path');
const { loadDir } = require('./lib/data');
const { simulateGrid, simulateMomentum } = require('./lib/sim');
const { lineChart, table, tile, esc, pct, fmtDate, STYLE, HOVER_JS } = require('./lib/report');

const DAY = 86400000;

function parseArgs(argv) {
  const out = { bot: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

// Price-only benchmark curve (no costs), scaled to starting capital.
function holdCurve(series, bot, start, end, capital, points) {
  const syms = bot === 'grid' ? ['SOL'] : Object.keys(series);
  const idx = {};
  for (const s of syms) idx[s] = { arr: series[s], i: 0, first: null };
  const priceAt = (s, t) => {
    const o = idx[s];
    while (o.i + 1 < o.arr.length && o.arr[o.i + 1].t <= t) o.i++;
    return o.arr[o.i].t <= t ? o.arr[o.i].c : null;
  };
  const out = [];
  for (const [t] of points) {
    let sum = 0;
    let n = 0;
    for (const s of syms) {
      const p = priceAt(s, Math.min(t, end));
      if (p == null || idx[s].arr[0].t > start) continue;
      if (idx[s].first == null) idx[s].first = priceAt(s, start) || p;
      sum += p / idx[s].first;
      n++;
    }
    if (n) out.push([t, capital * (sum / n)]);
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!['grid', 'momentum'].includes(a.bot)) {
    console.error('usage: node bench/final-exam.js <grid|momentum> [--data DIR] [--capital 1000] [--force]');
    process.exit(1);
  }
  const bot = a.bot;
  const outDir = path.join(__dirname, 'results');
  const candFile = path.join(outDir, `${bot}-candidate.json`);
  if (!fs.existsSync(candFile)) throw new Error(`No ${bot}-candidate.json yet. Run: node bench/stress.js ${bot}`);
  const cand = JSON.parse(fs.readFileSync(candFile, 'utf8'));
  const capital = Number(a.capital || 1000);
  const force = Boolean(a.force);

  if (!cand.stressPassed && !force) {
    console.error(`The ${bot} candidate FAILED its stress test (${cand.stressReport}).`);
    console.error('Fix the weak points and stress test again. Opening the exam now wastes it. Override with --force.');
    process.exit(2);
  }

  const dataDir = path.resolve(a.data || path.join(__dirname, 'data'));
  const series = loadDir(dataDir, cand.interval);
  if (!Object.keys(series).length) throw new Error(`No ${cand.interval} candles in ${dataDir}`);
  const dataEnd = Math.max(...Object.values(series).map((s) => s[s.length - 1].t));
  // Exam = everything from the sealed start to the latest candle. Newer data fetched since the
  // stress test is also unseen, so it is fair to include.
  const start = cand.holdout.start;
  const end = dataEnd;
  if ((end - start) / DAY < 7) throw new Error('Less than 7 sealed days available. Was the data re-fetched with a shorter --days?');

  const ledgerFile = path.join(outDir, 'final-exam-ledger.json');
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : [];
  const prior = ledger.filter((e) => e.bot === bot && e.end > start && e.start < end);
  if (prior.length && !force) {
    console.error(`These sealed days were already used ${prior.length} time(s) for ${bot}:`);
    for (const e of prior) console.error(`  ${e.at.slice(0, 16)}  ${pct(e.returnPct)}  ${JSON.stringify(e.params)}`);
    console.error('A second look is no longer a blind test. Wait for new data (fetch again in a few weeks) or pass --force.');
    process.exit(3);
  }

  console.log(`${bot} final exam, cost ${cand.cost}, sealed days ${fmtDate(start)} -> ${fmtDate(end)} (${((end - start) / DAY).toFixed(0)} days)`);
  const opts = { cost: cand.cost, capital, start, end, sampleEvery: cand.interval === '5m' ? 12 : 1 };
  const res = bot === 'grid' ? await simulateGrid(series.SOL, cand.params, opts) : await simulateMomentum(series, cand.params, opts);
  const s = res.stats;
  const passed = s.returnPct > 0 && s.returnPct > s.holdReturnPct;

  const entry = {
    bot, at: new Date().toISOString(), start, end, cost: cand.cost, params: cand.params,
    returnPct: s.returnPct, holdReturnPct: s.holdReturnPct, maxDrawdownPct: s.maxDrawdownPct, trades: s.trades,
    passed, forced: force, priorLooks: prior.length,
  };
  ledger.push(entry);
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));

  const holdName = bot === 'grid' ? 'Hold SOL' : 'Hold coins';
  const hold = holdCurve(series, bot, start, end, capital, res.curve);
  const title = bot === 'grid' ? 'SOL grid bot' : 'Momentum bot';
  const verdict = passed
    ? `<b>Passed.</b> Made money on days it had never seen and beat ${holdName.toLowerCase()}. Next step: paper trade these settings live for 2 to 4 weeks before real money.`
    : `<b>Did not pass.</b> ${s.returnPct <= 0 ? 'Lost money' : `Trailed ${holdName.toLowerCase()}`} on the sealed days. Treat that as the honest answer. Don't re-tune against these days.`;
  const warn = prior.length ? `<p class="note">Warning: these days were looked at ${prior.length} time(s) before (forced). This result is no longer a blind test.</p>` : '';

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const htmlFile = path.join(outDir, `${bot}-final-exam-${stamp}.html`);
  fs.writeFileSync(htmlFile, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} final exam</title><style>${STYLE}
.verdict.pass{border-left:4px solid var(--up)}.verdict.fail{border-left:4px solid var(--down)}</style></head><body><main class="viz-root">
<h1>${esc(title)}: final exam</h1>
<p class="note">Sealed days ${fmtDate(start)} to ${fmtDate(end)}, cost model <code>${esc(cand.cost)}</code>, $${capital} start. Settings come from the stress test and were never tuned on these days.</p>
<div class="verdict ${passed ? 'pass' : 'fail'}">${passed ? '✓' : '✗'} ${verdict}</div>${warn}
<div class="tiles">${tile('Bot return', pct(s.returnPct))}${tile(holdName, pct(s.holdReturnPct))}${tile('Max drawdown', `${s.maxDrawdownPct.toFixed(1)}%`)}${tile('Trades', String(s.trades))}</div>
${lineChart({ title: 'Equity on the sealed days', subtitle: 'Bot vs simply holding, same starting cash', series: [{ name: 'Bot', cls: 's1', points: res.curve }, { name: holdName, cls: 's2', points: hold }] })}
<h2>Settings</h2>${table(['Setting', 'Value'], Object.entries(cand.params).map(([k, v]) => [esc(k), esc(String(v))]))}
<p class="note">Attempt ${ledger.filter((e) => e.bot === bot).length} for ${bot} in the ledger. Past results don't guarantee future ones.</p>
</main><script>
${HOVER_JS}</script></body></html>`);

  console.log(`bot ${pct(s.returnPct)} vs ${holdName.toLowerCase()} ${pct(s.holdReturnPct)}, drawdown ${s.maxDrawdownPct.toFixed(1)}%, ${s.trades} trades`);
  console.log(passed ? 'PASSED the final exam. Next: paper trade it.' : 'Did NOT pass the final exam.');
  console.log(`Report: ${htmlFile}`);
  console.log(`Logged to ${ledgerFile}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
