// Self-contained HTML report (no external files): stat tiles, equity vs buy-and-hold,
// price with trade markers (grid), P&L by coin (momentum), finalist and trade tables.
// Charts are SVG with a hover crosshair; light/dark follow the system setting.

const STYLE = `.viz-root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);
--s1:#2a78d6;--s2:#eb6834;--pos:#2a78d6;--neg:#e34948;--up:#006300;--down:#d03b3b}
@media (prefers-color-scheme:dark){.viz-root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--pos:#3987e5;--neg:#e66767;--up:#0ca30c;--down:#e66767}}
*{box-sizing:border-box}body{margin:0}
.viz-root{background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:28px;max-width:1000px;margin:0 auto;min-height:100vh}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 4px}h3{font-size:14px;margin:0}.th{margin:18px 0 8px}
.note,.sub{color:var(--ink2);margin:2px 0 12px}.sub{margin:2px 0 0;font-size:13px}
.verdict{padding:12px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface);margin:14px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:10px 0 14px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px}.tl{color:var(--ink2);font-size:12px}.tv{font-size:22px;font-weight:600;margin-top:2px}.tn{color:var(--muted);font-size:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 14px 6px;margin:0 0 14px}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;color:var(--ink2);font-size:12px}.key{display:inline-flex;align-items:center;gap:6px}.sw{width:14px;height:3px;border-radius:2px;display:inline-block}
.plot{position:relative}svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.s1{stroke:var(--s1)}.s2{stroke:var(--s2)}.ink{stroke:var(--ink2);stroke-width:1.5}
.s1-bg{background:var(--s1)}.s2-bg{background:var(--s2)}.ink-bg{background:var(--ink2)}
.dlabel{font-size:12px;fill:var(--ink2)}.level{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 4;opacity:.7}
.mark{stroke:var(--surface);stroke-width:1.5}.mark.buy{fill:var(--s1)}.mark.sell{fill:var(--s2)}
.bar.pos{fill:var(--pos)}.bar.neg{fill:var(--neg)}.val{fill:var(--ink);font-size:12px;font-variant-numeric:tabular-nums}
.cross{stroke:var(--muted);stroke-width:1}.hit{fill:transparent;cursor:crosshair}
.tip{position:absolute;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 9px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.12);white-space:nowrap}
.tip .d{color:var(--ink2);margin-bottom:2px}.tip i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:14px}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--grid);font-variant-numeric:tabular-nums}th{color:var(--ink2);font-weight:600}
.up{color:var(--up)}.down{color:var(--down)}code{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
pre{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;overflow-x:auto;font-size:12.5px}
`;

const HOVER_JS = `document.querySelectorAll('.plot').forEach(function (plot) {
  var data = JSON.parse(plot.querySelector('script[type="application/json"]').textContent);
  var svg = plot.querySelector('svg'), hit = plot.querySelector('.hit'), cross = plot.querySelector('.cross'), tip = plot.querySelector('.tip');
  var M = data.M, W = data.W;
  function money(v){var a=Math.abs(v);return (v<0?'-':'')+'$'+(a<1?a.toPrecision(3):a.toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2}));}
  function nearest(pts, t){var lo=0,hi=pts.length-1;while(lo<hi){var m=(lo+hi)>>1;if(pts[m][0]<t)lo=m+1;else hi=m;}if(lo>0&&Math.abs(pts[lo-1][0]-t)<Math.abs(pts[lo][0]-t))lo--;return pts[lo];}
  hit.addEventListener('mousemove', function (e) {
    var r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) * W / r.width;
    var t = data.tMin + (sx - M.l) / (W - M.l - M.r) * (data.tMax - data.tMin);
    cross.setAttribute('x1', sx); cross.setAttribute('x2', sx); cross.setAttribute('visibility', 'visible');
    var rows = data.series.map(function (s) { var p = nearest(s.pts, t); return '<div><i style="background:var(--'+(s.cls==='ink'?'ink2':s.cls)+')"></i>'+s.name+' <b>'+money(p[1])+'</b></div>'; });
    tip.innerHTML = '<div class="d">'+new Date(t).toISOString().slice(0,16).replace('T',' ')+'</div>'+rows.join('');
    tip.hidden = false;
    var px = e.clientX - plot.getBoundingClientRect().left;
    tip.style.left = (px > plot.clientWidth - 190 ? px - 180 : px + 14) + 'px'; tip.style.top = '18px';
  });
  hit.addEventListener('mouseleave', function () { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
});
`;

const W = 920;
const H = 300;
const M = { l: 64, r: 92, t: 16, b: 34 };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);
const money = (v) => `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

function downsample(points, max = 900) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function niceTicks(min, max, n = 5) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-12; v += step) ticks.push(+v.toPrecision(10));
  return ticks;
}

function fmtTick(v) {
  if (v < 0) return `-${fmtTick(-v)}`;
  const a = Math.abs(v);
  if (a >= 1000) return `$${(v / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  if (a >= 1) return `$${v.toFixed(a >= 100 ? 0 : 2)}`;
  return `$${v.toPrecision(2)}`;
}

let chartId = 0;

// series: [{ name, cls, points: [[t, v]] }]; markers: [{ t, v, kind: 'buy'|'sell', label }]
// hlines: [{ v, cls }]
function lineChart({ title, subtitle, series, markers = [], hlines = [] }) {
  const id = `c${chartId++}`;
  const all = series.flatMap((s) => s.points);
  let tMin = Math.min(...all.map((p) => p[0]));
  let tMax = Math.max(...all.map((p) => p[0]));
  if (tMax === tMin) tMax = tMin + 1;
  let vMin = Math.min(...all.map((p) => p[1]), ...markers.map((m) => m.v), ...hlines.map((h) => h.v));
  let vMax = Math.max(...all.map((p) => p[1]), ...markers.map((m) => m.v), ...hlines.map((h) => h.v));
  const pad = (vMax - vMin) * 0.06 || Math.abs(vMax) * 0.05 || 1;
  vMin -= pad; vMax += pad;
  const x = (t) => M.l + ((t - tMin) / (tMax - tMin)) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - (v - vMin) / (vMax - vMin)) * (H - M.t - M.b);

  const yt = niceTicks(vMin, vMax);
  const grid = yt.map((v) => `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmtTick(v)}</text>`).join('');
  const xt = [];
  for (let i = 0; i <= 5; i++) {
    const t = tMin + ((tMax - tMin) * i) / 5;
    xt.push(`<text class="tick" x="${x(t)}" y="${H - 10}" text-anchor="${i === 0 ? 'start' : i === 5 ? 'end' : 'middle'}">${fmtDate(t).slice(5)}</text>`);
  }
  const levels = hlines.map((h) => `<line class="${h.cls}" x1="${M.l}" x2="${W - M.r}" y1="${y(h.v)}" y2="${y(h.v)}"/>`).join('');
  const paths = series.map((s) => {
    const pts = downsample(s.points);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const last = pts[pts.length - 1];
    return `<path class="line ${s.cls}" d="${d}"/><text class="dlabel ${s.cls}-ink" x="${x(last[0]) + 8}" y="${y(last[1]) + 4}">${esc(s.name)}</text>`;
  }).join('');
  const marks = downsample(markers, 600).map((m) => {
    const cx = x(m.t);
    const cy = y(m.v);
    const tri = m.kind === 'buy'
      ? `M${cx},${cy - 6} L${cx - 5.5},${cy + 4} L${cx + 5.5},${cy + 4} Z`
      : `M${cx},${cy + 6} L${cx - 5.5},${cy - 4} L${cx + 5.5},${cy - 4} Z`;
    return `<path class="mark ${m.kind}" d="${tri}"><title>${esc(m.label)}</title></path>`;
  }).join('');

  const data = {
    series: series.map((s) => ({ name: s.name, cls: s.cls, pts: downsample(s.points) })),
    tMin, tMax, vMin, vMax, M, W, H,
  };
  const legend = series.map((s) => `<span class="key"><i class="sw ${s.cls}-bg"></i>${esc(s.name)}</span>`).join('') +
    (markers.length ? '<span class="key"><svg width="12" height="12"><path class="mark buy" d="M6,1 L1,10 L11,10 Z"/></svg>Buy</span><span class="key"><svg width="12" height="12"><path class="mark sell" d="M6,11 L1,2 L11,2 Z"/></svg>Sell</span>' : '');

  return `<figure class="card">
  <figcaption><h3>${esc(title)}</h3>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}<div class="legend">${legend}</div></figcaption>
  <div class="plot" id="${id}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
      ${grid}<line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/>${xt.join('')}
      ${levels}${paths}
      <line class="cross" x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" visibility="hidden"/>
      <rect class="hit" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}"/>
      ${marks}
    </svg>
    <div class="tip" hidden></div>
    <script type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
  </div>
</figure>`;
}

// Horizontal bars, positive = blue, negative = red, value label on every bar (few bars).
function barChart({ title, subtitle, rows }) {
  if (!rows.length) return '';
  const bh = 26;
  const gap = 2;
  const left = 110;
  const right = 90;
  const h = rows.length * (bh + gap) + 20;
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  const hasNeg = rows.some((r) => r.value < 0);
  const zero = hasNeg ? left + (W - left - right) / 2 : left;
  const scale = (hasNeg ? (W - left - right) / 2 : W - left - right) / maxAbs;
  const bars = rows.map((r, i) => {
    const yy = 10 + i * (bh + gap);
    const w = Math.max(1, Math.abs(r.value) * scale);
    const x0 = r.value >= 0 ? zero : zero - w;
    const cls = r.value >= 0 ? 'pos' : 'neg';
    const lx = r.value >= 0 ? zero + w + 6 : zero - w - 6;
    return `<text class="tick" x="${left - 10}" y="${yy + bh / 2 + 4}" text-anchor="end">${esc(r.label)}</text>
      <rect class="bar ${cls}" x="${x0}" y="${yy}" width="${w}" height="${bh}" rx="4"><title>${esc(r.label)}: ${money(r.value)}</title></rect>
      <text class="val" x="${lx}" y="${yy + bh / 2 + 4}" text-anchor="${r.value >= 0 ? 'start' : 'end'}">${money(r.value)}</text>`;
  }).join('');
  return `<figure class="card"><figcaption><h3>${esc(title)}</h3>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}</figcaption>
  <svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}"><line class="axis" x1="${zero}" x2="${zero}" y1="4" y2="${h - 6}"/>${bars}</svg></figure>`;
}

function table(headers, rows, cls = '') {
  return `<div class="tablewrap"><table class="${cls}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function tile(label, value, note) {
  return `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${value}</div>${note ? `<div class="tn">${esc(note)}</div>` : ''}</div>`;
}

// Buy-and-hold curve for comparison.
function holdCurve(run, series, capital) {
  const times = run.curve.map((p) => p[0]);
  const coins = run.bot === 'grid' ? ['SOL'] : run.symbols;
  const at = (arr, t) => {
    let lo = 0; let hi = arr.length - 1;
    if (t < arr[0].t) return null;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid - 1; }
    return arr[lo].c;
  };
  const base = {};
  for (const c of coins) base[c] = at(series[c], times[0]) ?? series[c].find((x) => x.t >= times[0])?.c;
  return times.map((t) => {
    const rel = coins.map((c) => { const p = at(series[c], t); return p && base[c] ? p / base[c] : 1; });
    return [t, (capital * rel.reduce((a, b) => a + b, 0)) / rel.length];
  });
}

function periodSection(label, note, run, series, capital) {
  const s = run.stats;
  const hold = holdCurve(run, series, capital);
  const holdName = run.bot === 'grid' ? 'Hold SOL' : 'Hold coins';
  let html = `<h2>${esc(label)}</h2><p class="note">${esc(note)}</p><div class="tiles">
    ${tile('Bot return', pct(s.returnPct), `${money(capital)} → ${money(s.endValue)}`)}
    ${tile(holdName, pct(s.holdReturnPct), 'same period')}
    ${tile('Max drawdown', `${s.maxDrawdownPct.toFixed(2)}%`, 'worst peak-to-trough')}
    ${tile(run.bot === 'grid' ? 'Round trips' : 'Trades', run.bot === 'grid' ? s.roundTrips : s.trades, run.bot === 'grid' ? `${s.trades} fills` : `win rate ${s.winRatePct}%`)}
    ${tile('Sharpe (daily)', s.sharpe.toFixed(2), 'return vs volatility')}
  </div>`;
  html += lineChart({
    title: 'Equity: bot vs buy and hold',
    subtitle: `${fmtDate(run.curve[0][0])} to ${fmtDate(run.curve[run.curve.length - 1][0])}${s.halted ? `. Halted: ${s.halted}` : ''}`,
    series: [{ name: 'Bot', cls: 's1', points: run.curve }, { name: holdName, cls: 's2', points: hold }],
  });
  if (run.bot === 'grid') {
    html += lineChart({
      title: 'SOL price with grid fills',
      subtitle: `Grid ${money(run.cfg.lower)} to ${money(run.cfg.upper)}, ${run.cfg.count} slots, ${run.cfg.stepPct}% steps. Dashed lines are the grid levels.`,
      series: [{ name: 'SOL', cls: 'ink', points: run.priceCurve }],
      markers: run.fills.map((f) => ({ t: f.t, v: f.price, kind: f.side, label: `${f.side} ${f.qty} SOL @ ${money(f.price)} (${fmtDate(f.t)})` })),
      hlines: run.levels.map((v) => ({ v, cls: 'level' })),
    });
  } else {
    const rows = Object.entries(run.bySymbol).map(([k, v]) => ({ label: k.replace('-USD', ''), value: v })).sort((a, b) => b.value - a.value);
    html += barChart({ title: 'Realized P&L by coin', subtitle: 'Closed trades only', rows });
    if (run.exits.length) {
      html += '<h3 class="th">Trades</h3>' + table(
        ['Closed', 'Coin', 'P&L', 'P&L %', 'Held (h)', 'Exit reason'],
        run.exits.slice(-60).reverse().map((e) => [
          new Date(e.t).toISOString().slice(0, 16).replace('T', ' '), esc(e.symbol.replace('-USD', '')),
          `<span class="${e.pnl >= 0 ? 'up' : 'down'}">${money(e.pnl)}</span>`, pct(e.pnlPct), e.heldHours, esc(e.reason),
        ]),
      ) + (run.exits.length > 60 ? `<p class="note">Showing the last 60 of ${run.exits.length} trades.</p>` : '');
    }
  }
  return html;
}

function renderReport({ summary, trainRun, testRun, series }) {
  chartId = 0;
  const { bot, cost, capital, window: w, pick } = summary;
  const held = pick.test && pick.test.returnPct > 0;
  const finalists = summary.finalists.map((r) => [
    r.rank,
    esc(Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')),
    pct(r.train.returnPct), `${r.train.maxDrawdownPct.toFixed(1)}%`, r.train.trades,
    r.test ? pct(r.test.returnPct) : 'n/a', r.test ? `${r.test.maxDrawdownPct.toFixed(1)}%` : 'n/a', r.test ? r.test.trades : 'n/a',
    r === summary.finalists.find((f) => JSON.stringify(f.params) === JSON.stringify(pick.params)) ? '<b>pick</b>' : '',
  ]);
  const caveat = bot === 'momentum'
    ? 'Momentum signals here come from exchange candles (volume and up-candle share), a stand-in for the live DexScreener on-chain data. Stops are checked on each candle close.'
    : 'Fills: a resting order fills only when a later candle trades through it, after the modeled spread.';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(bot)} bench, ${esc(cost)}</title>
<style>
${STYLE}</style></head><body><main class="viz-root">
<h1>${bot === 'grid' ? 'SOL grid bot' : 'Momentum bot'}: bench results</h1>
<p class="note">Cost model <code>${esc(cost)}</code>, ${money(capital)} starting capital, ${summary.combos} settings tested. Training ${fmtDate(w.start)} to ${fmtDate(w.split)}, test ${fmtDate(w.split)} to ${fmtDate(w.end)}. Generated ${esc(summary.generatedAt.slice(0, 16).replace('T', ' '))} UTC.</p>
<div class="verdict"><b>${held ? 'The picked settings made money on data they never saw.' : 'The picked settings did NOT make money on data they never saw.'}</b>
 Training ${pct(pick.train.returnPct)}, test ${pct(pick.test ? pick.test.returnPct : null)} (buy and hold over the test window: ${pct(pick.test ? pick.test.holdReturnPct : null)}). ${held ? 'Paper trade them before going live.' : 'Don\'t go live with these. Try more history, the other cost model, or a different search space.'}</div>
${periodSection('Test period (unseen data)', 'The settings were chosen without looking at this part of the history. This is the honest estimate.', testRun, series, capital)}
${periodSection('Training period', 'The settings were chosen to do well here, so these numbers flatter the bot.', trainRun, series, capital)}
<h2>Top settings</h2><p class="note">Ranked by training score (return minus half the max drawdown). The pick is the one that held up best in both periods.</p>
${table(['#', 'Settings', 'Train', 'Train DD', 'Train trades', 'Test', 'Test DD', 'Test trades', ''], finalists)}
<h2>Settings file</h2><p class="note">Saved as <code>bench/results/${bot}-best.env</code>.</p><pre>${esc(summary.env)}</pre>
<p class="note">${esc(caveat)} Past results don't guarantee future ones.</p>
</main>
<script>
${HOVER_JS}</script></body></html>`;
}

module.exports = { renderReport, lineChart, barChart, table, tile, esc, pct, money, fmtDate, STYLE, HOVER_JS };
