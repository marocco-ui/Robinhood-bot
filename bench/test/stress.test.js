const test = require('node:test');
const assert = require('node:assert');
const { makeFolds, regimeOf, compound, neighbors, bootstrap, grade, DAY } = require('../lib/stress-core');

test('makeFolds: rolling 90/30 windows, test never overlaps its own training', () => {
  const start = Date.UTC(2026, 0, 1);
  const folds = makeFolds(start, start + 240 * DAY, 90, 30);
  assert.strictEqual(folds.length, 5);
  for (const f of folds) {
    assert.strictEqual(f.testStart, f.trainEnd);
    assert.strictEqual(f.trainEnd - f.trainStart, 90 * DAY);
    assert.ok(f.testEnd <= start + 240 * DAY);
  }
  assert.strictEqual(folds[1].testStart, folds[0].testEnd); // test windows tile without gaps
});

test('makeFolds: keeps a last window that is a few hours short', () => {
  const start = Date.UTC(2026, 0, 1);
  const end = start + 180 * DAY - 5 * 3600000;
  const folds = makeFolds(start, end, 90, 30);
  assert.strictEqual(folds.length, 3);
  assert.strictEqual(folds[2].testEnd, end);
});

test('regimeOf and compound', () => {
  assert.strictEqual(regimeOf(15), 'uptrend');
  assert.strictEqual(regimeOf(-12), 'downtrend');
  assert.strictEqual(regimeOf(4), 'sideways');
  assert.ok(Math.abs(compound([10, -10]) - -1) < 1e-9);
});

test('neighbors: one notch each way, edges only go inward', () => {
  const space = { a: [1, 2, 3], b: [10, 20] };
  const n = neighbors({ a: 2, b: 10 }, space);
  assert.deepStrictEqual(n.map((x) => `${x.changed}:${x.to}`), ['a:1', 'a:3', 'b:20']);
  assert.deepStrictEqual(n[0].params, { a: 1, b: 10 });
});

test('bootstrap: steady gains never lose, coin flips lose sometimes, deterministic by seed', () => {
  const up = bootstrap(Array(60).fill(0.002), { sims: 500 });
  assert.strictEqual(up.probLossPct, 0);
  assert.strictEqual(up.p95MaxDrawdownPct, 0);
  const flips = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.02 : -0.02));
  const a = bootstrap(flips, { sims: 500, seed: 7 });
  const b = bootstrap(flips, { sims: 500, seed: 7 });
  assert.deepStrictEqual(a, b);
  assert.ok(a.probLossPct > 20 && a.probLossPct < 100);
  assert.strictEqual(bootstrap([0.01, 0.01], { block: 5 }), null);
});

function fakeInputs(foldReturns, { base = 5, nb = [3, 2, 1, -1], spread = 2, mc = { probLossPct: 10, p95MaxDrawdownPct: 8 } } = {}) {
  return {
    folds: foldReturns.map((r) => ({ test: { returnPct: r } })),
    regimes: [{ regime: 'sideways', avgReturnPct: 1 }],
    plateau: { base: { returnPct: base }, neighbors: nb.map((r) => ({ returnPct: r })) },
    costs: [{ key: 'base', returnPct: base }, { key: 'spread+60', returnPct: spread }],
    monteCarlo: mc,
  };
}

test('grade: a robust result passes every check', () => {
  const g = grade(fakeInputs([2, 3, -1, 4]));
  assert.ok(g.pass, JSON.stringify(g.checks.filter((c) => !c.pass)));
  assert.strictEqual(g.checks.length, 5);
});

test('grade: each weak point fails its own check', () => {
  const failing = (inputs) => grade(inputs).checks.filter((c) => !c.pass).map((c) => c.name);
  assert.deepStrictEqual(failing(fakeInputs([-2, -3, 1])), ['Walk-forward (out of sample)']);
  assert.deepStrictEqual(failing(fakeInputs([2, 3, 1], { nb: [-1, -2, 3] })), ['Stable settings (plateau)']);
  assert.deepStrictEqual(failing(fakeInputs([2, 3, 1], { spread: -0.5 })), ['Worse costs']);
  assert.deepStrictEqual(failing(fakeInputs([2, 3, 1], { mc: { probLossPct: 50, p95MaxDrawdownPct: 8 } })), ['Bad luck (Monte Carlo)']);
  assert.ok(grade(fakeInputs([2, 3, 1], { mc: null })).checks.some((c) => !c.pass), 'missing Monte Carlo is not a pass');
});
