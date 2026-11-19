// Run: npm test   (uses node's built-in test runner, no installs)
const test = require('node:test');
const assert = require('node:assert');
const { GridEngine, buildLevels } = require('../src/grid');
const { validate } = require('../src/config');
const { PaperBroker } = require('../../shared/brokers');

const PAIR = { symbol: 'SOL-USD', assetCode: 'SOL', quoteIncrement: '0.01', assetIncrement: '0.0001', minOrderSize: 0.001, maxOrderSize: Infinity, status: 'tradable' };
const quietLog = { event() {}, error() {}, trade() {} };

class Feed {
  constructor(price) { this.set(price); }
  set(price, low, high) { this.q = { symbol: 'SOL-USD', bid: price, ask: price, mid: price, low, high }; }
  async getQuotes() { return new Map([['SOL-USD', { ...this.q, low: undefined, high: undefined }]]); }
  async getMatchQuotes() { return new Map([['SOL-USD', this.q]]); }
}

function cfg(over = {}) {
  const c = { mode: 'paper', symbol: 'SOL-USD', lower: 100, upper: 200, gridCount: 10, spacing: 'arithmetic', orderUsd: 20, maxCapitalUsd: 1000, maxOpenBuys: 3, stopLossPct: 10, cancelOnExit: true, minSpacingPct: 0.5, statusEveryTicks: 1e9, ...over };
  validate(c);
  return c;
}

async function setup(price = 155, over = {}) {
  const feed = new Feed(price);
  const broker = new PaperBroker({ priceSource: feed, startingCash: 1000, pairs: { 'SOL-USD': PAIR } });
  const engine = new GridEngine({ cfg: cfg(over), broker, log: quietLog });
  await engine.init();
  return { feed, broker, engine };
}

test('levels are evenly spaced and rounded to the quote increment', () => {
  assert.deepStrictEqual(buildLevels({ lower: 100, upper: 200, gridCount: 4, spacing: 'arithmetic' }, '0.01'), [100, 125, 150, 175, 200]);
  const geo = buildLevels({ lower: 100, upper: 400, gridCount: 2, spacing: 'geometric' }, '0.01');
  assert.deepStrictEqual(geo, [100, 200, 400]);
});

test('config refuses grids too tight to beat the spread', () => {
  assert.throws(() => cfg({ gridCount: 60, lower: 150, upper: 160, minSpacingPct: 1 }), /below GRID_MIN_SPACING_PCT/);
});

test('places buys only on the nearest slots below price', async () => {
  const { engine, broker } = await setup(155);
  await engine.tick();
  const buys = [...broker.orders.values()].filter((o) => o.side === 'buy' && o.state === 'open').map((o) => o.limitPrice).sort();
  assert.deepStrictEqual(buys, [130, 140, 150]);
});

test('buy fill -> sell one level up -> sell fill banks the step', async () => {
  const { engine, feed, broker } = await setup(155);
  await engine.tick();
  feed.set(139, 139, 141); // candle dips through 140
  await engine.tick();
  const slot4 = engine.state.slots[4];
  assert.strictEqual(slot4.status, 'selling');
  const sell = broker.orders.get(slot4.orderId);
  assert.strictEqual(sell.limitPrice, 150);
  feed.set(151, 149, 151);
  await engine.tick();
  assert.strictEqual(engine.state.roundTrips, 1);
  const qty = Number((20 / 140).toFixed(4)) - 0.00005 > 0 ? Math.floor((20 / 140) * 1e4) / 1e4 : 0;
  assert.ok(Math.abs(engine.state.realizedPnl - qty * 10) < 1e-6, `pnl ${engine.state.realizedPnl}`);
});

test('capital cap limits open exposure', async () => {
  const { engine, broker } = await setup(155, { maxCapitalUsd: 40, maxOpenBuys: 5 });
  await engine.tick();
  const open = [...broker.orders.values()].filter((o) => o.state === 'open');
  assert.strictEqual(open.length, 2);
});

test('far buys are canceled when price runs up', async () => {
  const { engine, feed, broker } = await setup(125);
  await engine.tick(); // buys at 120, 110, 100
  feed.set(195, 190, 196);
  await engine.tick();
  await engine.tick();
  const open = [...broker.orders.values()].filter((o) => o.side === 'buy' && o.state === 'open').map((o) => o.limitPrice).sort();
  assert.deepStrictEqual(open, [160, 170, 180]);
  assert.ok([...broker.orders.values()].some((o) => o.limitPrice === 100 && o.state === 'canceled'));
});

test('a request that crashed mid-flight is recovered without a duplicate order', async () => {
  const { engine, broker } = await setup(155);
  const slot = engine.state.slots[5];
  const req = { clientOrderId: '7c2f6c4e-1111-4222-8333-444455556666', side: 'buy', type: 'limit', symbol: 'SOL-USD', assetQuantity: '0.1333', limitPrice: '150.00' };
  await broker.placeOrder(req); // exchange got it...
  slot.pending = req; // ...but the bot crashed before saving the id
  slot.status = 'buying';
  await engine.tick();
  const matching = [...broker.orders.values()].filter((o) => o.clientOrderId === req.clientOrderId);
  assert.strictEqual(matching.length, 1);
  assert.strictEqual(slot.orderId, matching[0].id);
});

test('partial fill then cancel keeps the filled coins and sells them', async () => {
  const { engine, broker } = await setup(155);
  await engine.tick();
  const slot = engine.state.slots[4];
  const order = broker.orders.get(slot.orderId);
  // Simulate the exchange partially filling then canceling.
  broker.cash -= 0.05 * 140;
  broker.holdings.SOL = 0.05;
  Object.assign(order, { filledQty: 0.05, avgPrice: 140, state: 'canceled' });
  await engine.tick();
  assert.strictEqual(slot.status, 'selling');
  assert.strictEqual(broker.orders.get(slot.orderId).assetQuantity, 0.05);
});

test('stop-loss below the range cancels everything, sells, and halts', async () => {
  const { engine, feed, broker } = await setup(105);
  await engine.tick();
  feed.set(99, 99, 101); // fills 100 buy
  await engine.tick();
  feed.set(85, 85, 86);
  await engine.tick();
  assert.ok(engine.state.halted && /stop-loss/.test(engine.state.halted.reason));
  assert.strictEqual(broker.holdings.SOL, 0);
  assert.strictEqual([...broker.orders.values()].filter((o) => o.state === 'open').length, 0);
});

test('changing grid settings with an active grid is refused', async () => {
  const { engine, broker, feed } = await setup(155);
  await engine.tick();
  const e2 = new GridEngine({ cfg: cfg({ gridCount: 8 }), broker, log: quietLog, state: engine.state });
  await assert.rejects(() => e2.init(), /Grid settings changed/);
  feed.set(155);
});

test('state round-trips through JSON (restart)', async () => {
  const { engine, broker, feed } = await setup(155);
  await engine.tick();
  const saved = JSON.parse(JSON.stringify({ grid: engine.state, paper: broker.toJSON() }));
  const broker2 = new PaperBroker({ priceSource: feed, startingCash: 0, pairs: { 'SOL-USD': PAIR } });
  broker2.restore(saved.paper);
  const e2 = new GridEngine({ cfg: cfg(), broker: broker2, log: quietLog, state: saved.grid });
  await e2.init();
  await e2.tick();
  const open = [...broker2.orders.values()].filter((o) => o.state === 'open');
  assert.strictEqual(open.length, 3, 'no duplicate orders after restart');
});

test('an order the exchange no longer knows about frees its slot after 3 misses', async () => {
  const { engine, broker } = await setup(155);
  await engine.tick();
  const slot = engine.state.slots[5];
  const lostId = slot.orderId;
  broker.orders.delete(lostId); // exchange "forgets" it
  await engine.tick();
  await engine.tick();
  assert.strictEqual(slot.orderId, lostId, 'still waiting after 2 misses');
  await engine.tick();
  assert.notStrictEqual(slot.orderId, lostId, 'slot freed and re-ordered on 3rd');
  assert.strictEqual(slot.status, 'buying');
});

test('trend filter: pauses and cancels buys below the moving average, resumes above it', async () => {
  const { engine, feed, broker } = await setup(155, { trendMaHours: 24 });
  const t0 = Date.UTC(2026, 0, 1);
  let now = t0;
  engine.now = () => now;
  engine.seedPrices(Array.from({ length: 24 }, (_, i) => [t0 - (24 - i) * 3600000, 170])); // MA ~170
  await engine.tick(); // 155 < 170 -> blocked
  assert.ok(engine.trend.blocked);
  assert.strictEqual([...broker.orders.values()].filter((o) => o.side === 'buy' && o.state === 'open').length, 0);
  // Price recovers well above the average over the next day.
  for (let h = 1; h <= 30; h++) { now = t0 + h * 3600000; feed.set(185); await engine.tick(); }
  assert.ok(!engine.trend.blocked);
  assert.ok([...broker.orders.values()].some((o) => o.side === 'buy' && o.state === 'open'));
});

test('trend filter stays off (warming up) until it has enough history', async () => {
  const { engine, broker } = await setup(155, { trendMaHours: 24 });
  await engine.tick();
  assert.ok(engine.trend.warming);
  assert.ok([...broker.orders.values()].some((o) => o.side === 'buy' && o.state === 'open'));
});
