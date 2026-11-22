const test = require('node:test');
const assert = require('node:assert');
const { phase, sides, fresh, pnlPct } = require('../src/rule');
const { step } = require('../src/larp');

// Mon Nov 23 2026; New York is UTC-5.
const at = (hhmm) => new Date(`2026-11-23T${String(Number(hhmm.slice(0, 2)) + 5).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);
const q = (now, last, bid, ask, prev = 700) => ({ symbol: 'SPY', state: 'active', last_trade_price: String(last), bid_price: String(bid), ask_price: String(ask), adjusted_previous_close: String(prev), venue_last_trade_time: new Date(now.getTime() - 5000).toISOString() });

test('phases follow New York time', () => {
  assert.strictEqual(phase(at('10:05')).phase, 'signal');
  assert.strictEqual(phase(at('15:35')).phase, 'entry');
  assert.strictEqual(phase(at('15:58')).phase, 'exit');
  assert.strictEqual(phase(at('12:00')).phase, 'idle');
  assert.strictEqual(phase(new Date('2026-11-21T15:05:00Z')).phase, 'weekend');
  assert.strictEqual(phase(new Date('2026-07-15T14:05:00Z')).phase, 'signal'); // 10:05 EDT
});

test('sides and paper fills', () => {
  assert.deepStrictEqual(sides(0.4), { paperRule: 1, longShort: 1 });
  assert.deepStrictEqual(sides(-0.4), { paperRule: 0, longShort: -1 });
  // Long pays the ask in and gets the bid out; short the reverse.
  assert.ok(Math.abs(pnlPct(1, { ask_price: '100' }, { bid_price: '101' }) - 1) < 1e-9);
  assert.ok(Math.abs(pnlPct(-1, { bid_price: '100' }, { ask_price: '99' }) - (100 / 99 - 1) * 100) < 1e-9);
  assert.strictEqual(pnlPct(0, {}, {}), 0);
});

test('stale quote means the market is closed', () => {
  const now = at('15:35');
  assert.strictEqual(fresh(q(now, 1, 1, 1), now), true);
  assert.strictEqual(fresh({ ...q(now, 1, 1, 1), venue_last_trade_time: '2026-11-23T18:00:00Z' }, now), false);
});

test('a full up day: signal, entry, exit, equity updates once', async () => {
  let state = {};
  const run = async (hhmm, last, bid, ask) => { const now = at(hhmm); return (await step(state, now, async () => q(now, last, bid, ask))).did; };
  assert.strictEqual(await run('10:01', 707, 706.99, 707.01), 'signal'); // +1% morning
  assert.strictEqual(await run('10:02', 707, 706.99, 707.01), 'nothing'); // signal read once
  assert.strictEqual(await run('12:00', 707, 706.99, 707.01), 'nothing');
  assert.strictEqual(await run('15:31', 710, 709.99, 710.01), 'entry');
  assert.strictEqual(await run('15:58', 712, 711.99, 712.01), 'exit');
  assert.strictEqual(await run('15:59', 712, 711.99, 712.01), 'nothing');
  const r = state.history[0].results;
  assert.strictEqual(r.paperRule.side, 1);
  assert.ok(Math.abs(r.paperRule.pnl - (711.99 / 710.01 - 1) * 100) < 1e-9);
  assert.strictEqual(r.longShort.side, 1);
  assert.ok(state.equity.paperRule > 1000);
});

test('down morning: published rule stays flat, long/short shorts', async () => {
  const state = {};
  for (const [hhmm, px] of [['10:01', 693], ['15:31', 690], ['15:58', 688]]) {
    const now = at(hhmm);
    await step(state, now, async () => q(now, px, px - 0.01, px + 0.01));
  }
  const r = state.history[0].results;
  assert.strictEqual(r.paperRule.side, 0);
  assert.strictEqual(r.paperRule.pnl, 0);
  assert.strictEqual(r.longShort.side, -1);
  assert.ok(r.longShort.pnl > 0);
});

test('early close: no fresh quote at 15:30 skips the day', async () => {
  const state = {};
  let now = at('10:01');
  await step(state, now, async () => q(now, 707, 706.99, 707.01));
  now = at('15:31');
  const stale = { ...q(now, 707, 706.99, 707.01), venue_last_trade_time: '2026-11-23T18:00:00Z' };
  assert.strictEqual((await step(state, now, async () => stale)).did, 'skip');
  now = at('15:58');
  assert.strictEqual((await step(state, now, async () => q(now, 707, 706.99, 707.01))).did, 'nothing');
  assert.strictEqual(state.history, undefined);
});
