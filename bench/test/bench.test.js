// Run: node --test bench/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadDir, ReplayFeed, CandleSignals } = require('../lib/data');
const { simulateGrid, simulateMomentum, Tracker } = require('../lib/sim');
const { gridCombos, randomCombos } = require('../lib/spaces');
const { renderReport } = require('../lib/report');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-synthetic.js'), dir, '20']);
const one = loadDir(dir, '1h');
const five = loadDir(dir, '5m');

test('replay feed never shows a candle before its time', async () => {
  const feed = new ReplayFeed({ SOL: one.SOL.slice(0, 5) }, { spreadBps: 0 });
  const seen = [];
  while (feed.step()) seen.push([feed.now(), feed.candle('SOL').t]);
  for (const [now, ct] of seen) assert.ok(ct <= now);
  assert.strictEqual(seen.length, 5);
});

test('resting orders match only against the candle that just closed', async () => {
  const feed = new ReplayFeed({ SOL: one.SOL.slice(0, 3) }, { spreadBps: 0 });
  feed.step();
  const q = (await feed.getMatchQuotes(['SOL-USD'])).get('SOL-USD');
  assert.strictEqual(q.low, one.SOL[0].l);
});

test('candle signals: volume acceleration and up-volume share', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const candles = [];
  for (let i = 0; i < 84; i++) candles.push({ t: t0 + i * 300000, o: 1, h: 1, l: 1, c: 1, v: 10 });
  for (let i = 72; i < 84; i++) Object.assign(candles[i], { v: 30, c: 1.01, o: 1 }); // last hour: 3x volume, all up
  const feed = new ReplayFeed({ X: candles }, { spreadBps: 0 });
  while (feed.step());
  const m = new CandleSignals(feed, 300000).metricsFor('X');
  // 6h avg hourly = (60*10 + 12*30)/6 = 160, last hour = 360 -> 2.25x
  assert.ok(Math.abs(m.volumeAccel - 2.25) < 1e-9, m.volumeAccel);
  assert.strictEqual(m.buyRatio1h, 1);
});

test('stats do not depend on chart sampling', async () => {
  const p = { downPct: 20, upPct: 20, count: 6, maxOpenBuys: 3, stopLossPct: 10 };
  const a = await simulateGrid(one.SOL, p, { sampleEvery: 1 });
  const b = await simulateGrid(one.SOL, p, { sampleEvery: 1e12 });
  assert.deepStrictEqual(a.stats, b.stats);
});

test('simulations are deterministic', async () => {
  const a = await simulateMomentum(five, { minVolumeAccel: 1.5 }, { sampleEvery: 1e12 });
  const b = await simulateMomentum(five, { minVolumeAccel: 1.5 }, { sampleEvery: 1e12 });
  assert.deepStrictEqual(a.stats, b.stats);
});

test('test window starts fresh: no state leaks from training', async () => {
  const p = { downPct: 20, upPct: 20, count: 6, maxOpenBuys: 3, stopLossPct: 10 };
  const split = one.SOL[Math.floor(one.SOL.length * 0.7)].t;
  const test1 = await simulateGrid(one.SOL, p, { start: split });
  const test2 = await simulateGrid(one.SOL.filter((c) => c.t >= split), p, {});
  assert.deepStrictEqual(test1.stats, test2.stats);
});

test('costs reduce returns (free >= rh-v2, free >= rh-default)', async () => {
  const p = { downPct: 15, upPct: 15, count: 8, maxOpenBuys: 4, stopLossPct: 0 };
  const free = await simulateGrid(one.SOL, p, { cost: 'free' });
  const dflt = await simulateGrid(one.SOL, p, { cost: 'rh-default' });
  const v2 = await simulateGrid(one.SOL, p, { cost: 'rh-v2' });
  assert.ok(free.stats.realizedPnl >= dflt.stats.realizedPnl);
  assert.ok(free.stats.realizedPnl >= v2.stats.realizedPnl);
});

test('tracker computes drawdown from the peak', () => {
  const t = new Tracker(100);
  [110, 121, 99, 130].forEach((v, i) => t.update(i * 3600000, v));
  const s = t.stats();
  assert.strictEqual(s.maxDrawdownPct, 18.18);
  assert.strictEqual(s.returnPct, 30);
});

test('search spaces enumerate fully and sample without duplicates', () => {
  assert.strictEqual([...gridCombos({ a: [1, 2], b: [3, 4, 5] })].length, 6);
  const r = randomCombos({ a: [1, 2, 3], b: [1, 2, 3] }, 9);
  assert.strictEqual(new Set(r.map((x) => JSON.stringify(x))).size, r.length);
});

test('report renders self-contained HTML with charts', async () => {
  const p = { downPct: 20, upPct: 20, count: 6, maxOpenBuys: 3, stopLossPct: 10 };
  const run = await simulateGrid(one.SOL, p, {});
  const html = renderReport({
    summary: { bot: 'grid', cost: 'rh-default', capital: 1000, window: { start: 0, split: 1, end: 2 }, combos: 1, generatedAt: new Date().toISOString(), pick: { params: p, train: run.stats, test: run.stats }, finalists: [{ rank: 1, params: p, train: run.stats, test: run.stats }], env: 'GRID_COUNT=6\n' },
    trainRun: run, testRun: run, series: one,
  });
  assert.match(html, /<svg/);
  assert.match(html, /Equity: bot vs buy and hold/);
  assert.doesNotMatch(html, /NaN|undefined/);
  assert.doesNotMatch(html, /<script src=|<link /, 'no external files');
});
