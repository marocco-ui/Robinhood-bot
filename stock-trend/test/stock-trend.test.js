const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { trendSignal, isRegularHours } = require('../src/strategy');
const { TrendEngine } = require('../src/engine');
const { McpBroker, PaperBroker } = require('../src/brokers');

const months = (closes, startYear = 2025) => closes.map((close, i) => ({ month: `${startYear + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, close }));
const quietLog = () => ({ events: [], trades: [], event(type, d) { this.events.push({ type, ...d }); }, error(type, e) { this.events.push({ type, error: e.message }); }, trade(t) { this.trades.push(t); } });
const cfg = (o = {}) => ({ mode: 'paper', risk: 'SPY', safe: 'SHY', smaMonths: 10, capitalUsd: 1000, maxOrderUsd: 1000, minOrderUsd: 1, cashReserveUsd: 1, ignoreHours: true, ...o });

test('trendSignal: above the average holds SPY, below holds SHY, short history is null', () => {
  const up = trendSignal(months([10, 10, 10, 10, 10, 10, 10, 10, 10, 12]));
  assert.strictEqual(up.target, 'SPY');
  assert.strictEqual(up.month, '2025-10');
  assert.strictEqual(trendSignal(months([12, 12, 12, 12, 12, 12, 12, 12, 12, 10])).target, 'SHY');
  assert.strictEqual(trendSignal(months([1, 2, 3])), null);
  // Uses only the last N months.
  assert.strictEqual(trendSignal(months([1000, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11])).target, 'SPY');
});

test('isRegularHours: New York session on weekdays only', () => {
  assert.strictEqual(isRegularHours(new Date('2026-11-19T15:00:00Z')), true); // Thu 10:00 ET
  assert.strictEqual(isRegularHours(new Date('2026-11-19T14:00:00Z')), false); // 09:00 ET
  assert.strictEqual(isRegularHours(new Date('2026-11-19T21:30:00Z')), false); // 16:30 ET
  assert.strictEqual(isRegularHours(new Date('2026-11-21T16:00:00Z')), false); // Saturday
  assert.strictEqual(isRegularHours(new Date('2026-07-15T14:00:00Z')), true); // 10:00 EDT
});

// A paper broker over fixed quotes and fixed month closes, with a controllable clock.
function rig({ closes, cash = 1000, positions = {}, clock = '2026-11-19T15:00:00Z', c = {} }) {
  let now = new Date(clock);
  const prices = { SPY: { last: 700, bid: 699.9, ask: 700.1 }, SHY: { last: 81, bid: 80.99, ask: 81.01 } };
  const quotes = { quote: async (s) => prices[s], monthCloses: async () => closes };
  const paper = { cash, positions, unsettled: [], orders: {} };
  const broker = new PaperBroker({ quotes, state: paper, now: () => now });
  const log = quietLog();
  let saved = null;
  const engine = new TrendEngine({ cfg: cfg(c), broker, log, saveState: (s) => { saved = JSON.parse(JSON.stringify(s)); }, now: () => now });
  return { engine, paper, log, broker, prices, advance: (ms) => { now = new Date(now.getTime() + ms); }, saved: () => saved };
}
const UP = months([600, 610, 620, 630, 640, 650, 660, 670, 680, 700, 710]);
const DOWN = months([700, 700, 700, 700, 700, 700, 700, 700, 700, 600, 600]);

test('empty account: buys the target with cash minus the reserve, then holds', async () => {
  const r = rig({ closes: UP });
  const a = await r.engine.tick();
  assert.strictEqual(a.action, 'placed');
  assert.strictEqual(a.symbol, 'SPY');
  assert.strictEqual((await r.engine.tick()).action, 'order_done');
  assert.ok(Math.abs(r.paper.positions.SPY * 700.1 - 999) < 0.01);
  assert.strictEqual(r.log.trades.length, 1);
  assert.strictEqual((await r.engine.tick()).action, 'hold');
});

test('switch: sells SPY, waits for the cash to settle, then buys SHY', async () => {
  const r = rig({ closes: DOWN, cash: 0, positions: { SPY: 1.4 } });
  const a = await r.engine.tick();
  assert.deepStrictEqual([a.action, a.side, a.symbol], ['placed', 'sell', 'SPY']);
  await r.engine.tick(); // fill
  // Same day: proceeds unsettled, so no buy.
  assert.strictEqual((await r.engine.tick()).action, 'hold');
  r.advance(864e5);
  const b = await r.engine.tick();
  assert.deepStrictEqual([b.action, b.side, b.symbol], ['placed', 'buy', 'SHY']);
  await r.engine.tick();
  assert.ok(r.paper.positions.SHY > 11);
  assert.ok(!(r.paper.positions.SPY > 1e-9));
});

test('capital cap: never invests more than STOCK_CAPITAL_USD in total', async () => {
  const r = rig({ closes: UP, cash: 5000, c: { capitalUsd: 1000, maxOrderUsd: 1000 } });
  await r.engine.tick();
  await r.engine.tick();
  assert.ok(r.paper.positions.SPY * 700.1 <= 1000.01);
  assert.strictEqual((await r.engine.tick()).action, 'hold');
});

test('order checks from the review block the order and leave no pending state', async () => {
  const r = rig({ closes: UP });
  r.broker.review = async () => ({ checks: ['Instrument halted'] });
  const a = await r.engine.tick();
  assert.strictEqual(a.action, 'blocked');
  assert.strictEqual(r.engine.state.pending, null);
  assert.ok(r.log.events.some((e) => e.type === 'order_blocked'));
});

test('crash after saving the order but before placing: re-sends the same ref id', async () => {
  const r = rig({ closes: UP });
  const sent = [];
  const realPlace = r.broker.place.bind(r.broker);
  let fail = true;
  r.broker.place = async (req) => { sent.push(req.refId); if (fail) { fail = false; throw new Error('network'); } return realPlace(req); };
  await assert.rejects(r.engine.tick(), /network/);
  assert.ok(r.saved().pending && !r.saved().pending.orderId, 'pending saved before placing');
  // Restart with the saved state.
  const e2 = new TrendEngine({ cfg: cfg(), broker: r.broker, log: r.log, state: r.saved(), now: () => new Date('2026-11-19T15:30:00Z') });
  const a = await e2.tick();
  assert.strictEqual(a.action, 'placed');
  assert.strictEqual(sent[0], sent[1], 'same ref id on retry');
});

test('open order: waits instead of placing another', async () => {
  const r = rig({ closes: UP });
  r.broker.order = async () => ({ state: 'queued', filledQty: 0, avgPrice: 0 });
  await r.engine.tick();
  assert.strictEqual((await r.engine.tick()).action, 'waiting');
  assert.strictEqual((await r.engine.tick()).action, 'waiting');
});

test('STOP file and market hours', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const stopFile = path.join(dir, 'STOP');
  fs.writeFileSync(stopFile, '');
  const r = rig({ closes: UP });
  r.engine.stopFile = stopFile;
  assert.strictEqual((await r.engine.tick()).action, 'stopped');
  const closed = rig({ closes: UP, clock: '2026-11-21T16:00:00Z', c: { ignoreHours: false } });
  assert.strictEqual((await closed.engine.tick()).action, 'market_closed');
});

test('signal is computed once a month and ignores the unfinished month', async () => {
  let calls = 0;
  const r = rig({ closes: [...UP, { month: '2026-11', close: 1 }] });
  const orig = r.broker.monthCloses.bind(r.broker);
  r.broker.monthCloses = async (...a) => { calls++; return orig(...a); };
  await r.engine.tick();
  await r.engine.tick();
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.engine.state.signal.target, 'SPY', 'the partial November close of 1 was ignored');
});

// Real reply shapes recorded from Robinhood's Trading MCP on Nov 19 2026.
test('McpBroker parses real Robinhood replies and sends correct order arguments', async () => {
  const calls = [];
  const replies = {
    get_accounts: { data: { accounts: [{ account_number: '111', agentic_allowed: false, type: 'margin' }, { account_number: '999990001', agentic_allowed: true, type: 'cash', nickname: 'MCP' }] } },
    get_portfolio: { data: { total_value: '0', buying_power: { buying_power: '250.5000', unleveraged_buying_power: '250.5000' } } },
    get_equity_positions: { data: { positions: [{ symbol: 'SPY', quantity: '1.250000', shares_available_for_sells: '1.250000' }] } },
    get_equity_quotes: { data: { results: [{ quote: { symbol: 'SPY', last_trade_price: '726.120000', bid_price: '726.090000', ask_price: '726.140000', state: 'active' } }] } },
    get_equity_historicals: { data: { results: [{ symbol: 'SPY', bars: [{ begins_at: '2026-09-01T00:00:00Z', close_price: '700.0' }, { begins_at: '2026-10-01T00:00:00Z', close_price: '710.0', interpolated: true }] }] } },
    review_equity_order: { data: { quote: {}, order_checks: [] } },
    place_equity_order: { data: { order: { id: 'abc-123', state: 'queued' } } },
    get_equity_orders: { data: { orders: [{ id: 'abc-123', state: 'filled', cumulative_quantity: '0.344', average_price: '726.14' }] } },
  };
  const mcp = { call: async (name, a) => { calls.push([name, a]); return replies[name]; } };
  const b = new McpBroker({ mcp });
  assert.deepStrictEqual(await b.init(), { account: '••••0001', type: 'cash', nickname: 'MCP' });
  assert.strictEqual(await b.buyingPower(), 250.5);
  assert.deepStrictEqual(await b.positions(), [{ symbol: 'SPY', quantity: 1.25, sellable: 1.25 }]);
  assert.strictEqual(await b.price('SPY'), 726.12);
  assert.deepStrictEqual(await b.monthCloses('SPY', 12), [{ month: '2026-09', close: 700 }]);
  assert.deepStrictEqual((await b.review({ symbol: 'SPY', side: 'buy', dollarAmount: 249.5 })).checks, []);
  const placed = await b.place({ symbol: 'SPY', side: 'buy', dollarAmount: 249.5, refId: 'r1' });
  assert.strictEqual(placed.orderId, 'abc-123');
  const [, args] = calls.find(([n]) => n === 'place_equity_order');
  assert.deepStrictEqual(args, { account_number: '999990001', symbol: 'SPY', side: 'buy', type: 'market', time_in_force: 'gfd', market_hours: 'regular_hours', dollar_amount: '249.50', ref_id: 'r1' });
  assert.deepStrictEqual(await b.order('abc-123'), { state: 'filled', filledQty: 0.344, avgPrice: 726.14 });
  // Sells go by share quantity, rounded to 6 decimals.
  assert.strictEqual(b.orderArgs({ symbol: 'SPY', side: 'sell', quantity: 1.2500001 }).quantity, '1.25');
  // A review with checks surfaces their messages.
  replies.review_equity_order = { data: { order_checks: [{ message: 'Insufficient buying power' }] } };
  assert.deepStrictEqual((await b.review({ symbol: 'SPY', side: 'buy', dollarAmount: 9e9 })).checks, ['Insufficient buying power']);
});
