// Stress-test report card: overall verdict, pass/fail per check, and the evidence behind each.
const { lineChart, table, tile, esc, pct, fmtDate, STYLE, HOVER_JS } = require('./report');

const W = 920;

function status(pass) {
  // Icon + word, never color alone.
  return pass ? '<span class="chip ok">✓ PASS</span>' : '<span class="chip bad">✗ FAIL</span>';
}

function histogramSvg(hist) {
  if (!hist || !hist.length) return '';
  const H = 180;
  const M = { l: 40, r: 16, t: 10, b: 30 };
  const max = Math.max(...hist.map((b) => b.count));
  const bw = (W - M.l - M.r) / hist.length;
  const lo = hist[0].from;
  const hi = hist[hist.length - 1].to;
  const x0 = (v) => M.l + ((v - lo) / (hi - lo)) * (W - M.l - M.r);
  const bars = hist.map((b, i) => {
    const h = (b.count / max) * (H - M.t - M.b);
    const cls = b.to <= 0 ? 'neg' : b.from >= 0 ? 'pos' : 'mid';
    return `<rect class="bar ${cls}" x="${(M.l + i * bw + 1).toFixed(1)}" y="${(H - M.b - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${b.from.toFixed(1)}% to ${b.to.toFixed(1)}%: ${b.count} runs</title></rect>`;
  }).join('');
  const zero = lo < 0 && hi > 0 ? `<line class="axis" x1="${x0(0)}" x2="${x0(0)}" y1="${M.t}" y2="${H - M.b}"/><text class="tick" x="${x0(0)}" y="${H - 12}" text-anchor="middle">0%</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of simulated returns">
    <line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/>${bars}${zero}
    <text class="tick" x="${M.l}" y="${H - 12}">${lo.toFixed(1)}%</text><text class="tick" x="${W - M.r}" y="${H - 12}" text-anchor="end">${hi.toFixed(1)}%</text></svg>`;
}

function paramsText(p) {
  return Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ');
}

function renderReportCard({ summary, stitched, stitchedHold }) {
  const s = summary;
  const v = s.verdict;
  const title = s.bot === 'grid' ? 'SOL grid bot' : 'Momentum bot';
  const holdName = s.bot === 'grid' ? 'Hold SOL' : 'Hold coins';

  const checksTable = table(['Check', 'Result', 'To pass', ''], v.checks.map((c) => [esc(c.name), esc(c.result), esc(c.rule), status(c.pass)]));

  const foldsTable = table(
    ['#', 'Tested on (unseen)', 'Market', 'Bot', holdName, 'Trades', 'Drawdown', 'Settings picked from the 90 days before'],
    s.folds.map((f) => [f.index, `${fmtDate(f.testStart)} to ${fmtDate(f.testEnd)}`, f.regime, pct(f.test.returnPct), pct(f.test.holdReturnPct), f.test.trades, `${f.test.maxDrawdownPct.toFixed(1)}%`, `<span class="small">${esc(paramsText(f.params))}</span>`]),
  );

  const regimeTable = table(
    ['Market type', 'Windows', 'Bot avg per window', `${holdName} avg`, 'Windows profitable'],
    s.regimes.map((r) => [r.regime, r.windows, pct(r.avgReturnPct), pct(r.avgHoldPct), `${Math.round(r.winShare * 100)}%`]),
  );

  const plateauTable = table(
    ['Changed setting', 'From', 'To', 'Return (all test windows)'],
    [['<b>picked settings</b>', '', '', `<b>${pct(s.plateau.base.returnPct)}</b>`],
      ...s.plateau.neighbors.map((n) => [esc(n.changed), n.from, n.to, `<span class="${n.returnPct > 0 ? 'up' : 'down'}">${pct(n.returnPct)}</span>`])],
  );

  const costTable = table(['Scenario', 'Return (all test windows)'], s.costs.map((c) => [esc(c.name), `<span class="${c.returnPct > 0 ? 'up' : 'down'}">${pct(c.returnPct)}</span>`]));

  const mc = s.monteCarlo;
  const mcHtml = mc ? `<div class="tiles">
      ${tile('Chance of losing money', `${mc.probLossPct}%`, `${mc.sims.toLocaleString()} reshuffled histories`)}
      ${tile('Typical outcome', pct(mc.medianReturnPct), 'median')}
      ${tile('Bad-luck outcome', pct(mc.p5ReturnPct), '5th percentile')}
      ${tile('Bad-luck drawdown', `${mc.p95MaxDrawdownPct}%`, '95th percentile')}
    </div><figure class="card"><figcaption><h3>Simulated returns over ${mc.days} trading days</h3><p class="sub">Each bar counts reshuffled histories ending in that return range. Bars left of 0% lost money.</p></figcaption>${histogramSvg(mc.histogram)}</figure>`
    : '<p class="note">Not enough out-of-sample days for a Monte Carlo run.</p>';

  const chart = stitched.length ? lineChart({
    title: 'Out-of-sample equity, all windows chained',
    subtitle: 'Only days the settings had never seen. The range/settings are re-picked every 30 days, like you would live.',
    series: [{ name: 'Bot', cls: 's1', points: stitched }, { name: holdName, cls: 's2', points: stitchedHold }],
  }) : '';

  const next = v.pass
    ? `<b>Passed every check.</b> Next: <code>node bench/final-exam.js ${s.bot}</code> runs these settings once on the sealed ${s.holdout.days} days. Then paper trade.`
    : `<b>Failed ${v.checks.filter((c) => !c.pass).length} of ${v.checks.length} checks.</b> Not ready for real money. Fix the weak point the failing checks point at, then stress test again. Don't open the final exam yet.`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} stress test</title><style>${STYLE}
.chip{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap}
.chip.ok{color:var(--up);border:1px solid var(--up)}.chip.bad{color:var(--down);border:1px solid var(--down)}
.verdict.pass{border-left:4px solid var(--up)}.verdict.fail{border-left:4px solid var(--down)}
.bar.mid{fill:var(--muted)}.small{font-size:11.5px;color:var(--ink2)}
</style></head><body><main class="viz-root">
<h1>${esc(title)}: stress test report card</h1>
<p class="note">Cost model <code>${esc(s.cost)}</code>, ${s.interval} candles, history ${fmtDate(s.history.start)} to ${fmtDate(s.history.end)}. ${s.folds.length} windows of ${s.trainDays} days tuning + ${s.testDays} days unseen trading${s.combosPerWindow ? `, ${s.combosPerWindow} settings tried per window` : ''}. The final ${s.holdout.days} days (${fmtDate(s.holdout.start)} to ${fmtDate(s.holdout.end)}) are sealed and were not used.</p>
<div class="verdict ${v.pass ? 'pass' : 'fail'}">${v.pass ? '✓' : '✗'} ${next}</div>
<h2>Checks</h2>${checksTable}
${chart}
<h2>1. Walk-forward windows</h2><p class="note">Each row: settings tuned on the 90 days before, then traded on the next 30 days without peeking. This is the most honest estimate of live results.</p>${foldsTable}
<h2>2. By market type</h2><p class="note">Uptrend/downtrend = the benchmark moved more than 10% in that window.</p>${regimeTable}
<h2>3. Stable settings</h2><p class="note">Candidate (tuned on the most recent window): <code>${esc(paramsText(s.candidate))}</code>. Each row nudges one setting a notch. If small nudges flip the result, the original was luck.</p>${plateauTable}
<h2>4. Worse costs</h2><p class="note">Same candidate settings, across all test windows, with costs made deliberately worse.</p>${costTable}
<h2>5. Bad luck</h2><p class="note">The real out-of-sample days, reshuffled in 5-day blocks into thousands of alternate orders. Shows the range of outcomes the same edge could produce.</p>${mcHtml}
<p class="note">Generated ${esc(s.generatedAt.slice(0, 16).replace('T', ' '))} UTC. Past results don't guarantee future ones.</p>
</main><script>
${HOVER_JS}</script></body></html>`;
}

module.exports = { renderReportCard };
