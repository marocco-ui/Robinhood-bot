// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { MomentumEngine } = require('../src/momentum');
const { evaluate, PriceHistory } = require('../src/modules/analyzer');
const { metricsFromPair } = require('../src/modules/dexscreener');
const { PaperBroker } = require('../../shared/brokers');

const quietLog = { event() {}, error() {}, trade() {} };
const MIN = 60000;

function cfg(over = {}) {
  return {
    mode: 'paper',
    exclude: ['SOL'],
    risk: { capitalUsd: 300, maxPositionUsd: 50, positionPct: 15, maxPositions: 3, stopLossPct: -12, takeProfitPct: 30, trailActivatePct: 12, trailPct: 8, maxHoldHours: 48, cooldownHours: 6, dailyLossPct: -8, portfolioStopPct: -30, ...(over.risk || {}) },
    signal: { minLiquidityUsd: 1e6, minVolumeAccel: 1.5, minPriceChange1hPct: 1, maxPriceChange1hPct: 15, minBuyRatio: 0.55, breakoutLookbackMin: 60, breakoutBufferPct: 0.3, maxSpreadPct: 3, maxPriceGapPct: 5, minScore: 45, ...(over.signal || {}) },
  };
}

// Prices for a few symbols, controllable from the test. Robinhood-like 2% spread.
class Market {
  constructor() { this.prices = { 'BONK-USD': 0.0000024, 'WIF-USD': 0.134 }; this.t = Date.UTC(2026, 10, 18, 12); }
  now() { return this.t; }
  async getQuotes(symbols) {
    const m = new Map();
    for (const s of symbols) if (this.prices[s]) {
      const p = this.prices[s];
      m.set(s, { symbol: s, bid: p * 0.99, ask: p * 1.01, mid: p, ts: this.t });
    }
    return m;
  }
  async getPairs(symbols) {
    return symbols.filter((s) => this.prices[s]).map((s) => ({ symbol: s, assetCode: s.split('-')[0], quoteIncrement: '0.00000001', assetIncrement: '0.01', minOrderSize: 1, maxOrderSize: Infinity, status: 'tradable' }));
  }
  async getPair(s) { return (await this.getPairs([s]))[0]; }
}

const HOT = { liquidityUsd: 5e6, volumeAccel: 3, priceChange1h: 5, buyRatio1h: 0.65 };
const COLD = { liquidityUsd: 5e6, volumeAccel: 0.8, priceChange1h: -1, buyRatio1h: 0.45 };

function fakeDex(market, flavor = {}) {
  return {
    async getMetrics(map) {
      const out = {};
      for (const sym of Object.keys(map)) {
        const p = market.prices[`${sym}-USD`];
        const f = flavor[sym] || COLD;
        out[sym] = { ok: true, symbol: sym, dexSymbol: f.dexSymbol || sym, symbolMatches: (f.dexSymbol || sym) === sym, priceUsd: f.priceUsd || p, ...f };
      }
      return out;
    },
  };
}

function setup(over, flavor) {
  const market = new Market();
  const broker = new PaperBroker({ priceSource: market, startingCash: 300 });
  const flav = flavor || {};
  const engine = new MomentumEngine({ cfg: cfg(over), broker, dex: fakeDex(market, flav), log: quietLog, now: () => market.now(), sleep: async () => {} });
  return { market, broker, engine, flav };
}

async function warmup(engine, market, minutes = 70, symbol = 'BONK-USD') {
  for (let i = 0; i < minutes; i++) {
    market.t += MIN;
    market.prices[symbol] *= 1 + (i % 2 ? 0.001 : -0.001); // flat chop
    await engine.scan();
  }
}

test('metricsFromPair reads DexScreener h1/h6 fields (old code read nonexistent h4)', () => {
  const m = metricsFromPair('BONK', { baseToken: { symbol: 'Bonk', address: 'x' }, priceUsd: '0.0000024', liquidity: { usd: 2e6 }, volume: { h1: 30000, h6: 60000, h24: 200000 }, priceChange: { h1: 4 }, txns: { h1: { buys: 60, sells: 40 } } });
  assert.strictEqual(m.volumeAccel, 3);
  assert.strictEqual(m.buyRatio1h, 0.6);
  assert.strictEqual(m.symbolMatches, true);
});

test('no entry without an hour of price history, even with a hot signal', async () => {
  const { engine, market, flav } = setup({}, { BONK: HOT });
  for (let i = 0; i < 20; i++) { market.t += MIN; market.prices['BONK-USD'] *= 1.003; await engine.scan(); }
  assert.strictEqual(Object.keys(engine.state.positions).length, 0);
  assert.ok(flav);
});

test('enters on breakout after warmup, sized and accounted correctly', async () => {
  const { engine, market, broker, flav } = setup();
  await warmup(engine, market);
  assert.strictEqual(Object.keys(engine.state.positions).length, 0, 'cold signal: no entry');
  flav.BONK = HOT;
  market.t += MIN;
  market.prices['BONK-USD'] *= 1.02; // breaks the last hour's high
  await engine.scan();
  const pos = engine.state.positions['BONK-USD'];
  assert.ok(pos, 'entered');
  assert.ok(pos.cost <= 45.0001 && pos.cost > 40, `cost ${pos.cost}`); // 15% of $300
  assert.ok(Math.abs(engine.cash() - (300 - pos.cost)) < 1e-9);
  assert.ok(Math.abs(broker.cash - (300 - pos.cost)) < 1e-6, 'paper broker agrees');
});

test('rejects a token whose DexScreener price disagrees with Robinhood (wrong mint)', async () => {
  const { engine, market, flav } = setup();
  await warmup(engine, market);
  flav.BONK = { ...HOT, priceUsd: 0.01 };
  market.t += MIN; market.prices['BONK-USD'] *= 1.02;
  const { results } = await engine.scan();
  const bonk = results.find((r) => r.symbol === 'BONK-USD');
  assert.ok(bonk.fail.includes('priceAgrees'));
  assert.strictEqual(Object.keys(engine.state.positions).length, 0);
});

test('stop loss exits, books the loss, and cooldown blocks re-entry', async () => {
  const { engine, market, flav } = setup();
  await warmup(engine, market);
  flav.BONK = HOT; market.t += MIN; market.prices['BONK-USD'] *= 1.02; await engine.scan();
  market.prices['BONK-USD'] *= 0.85; market.t += MIN;
  await engine.managePositions();
  assert.strictEqual(engine.state.positions['BONK-USD'], undefined);
  assert.ok(engine.state.realizedPnl < -5);
  // Fresh breakout right away: cooldown should block it.
  await warmup(engine, market, 65);
  market.t += MIN; market.prices['BONK-USD'] *= 1.03; await engine.scan();
  assert.strictEqual(engine.state.positions['BONK-USD'], undefined);
});

test('trailing stop locks in gains', async () => {
  const { engine, market, flav } = setup();
  await warmup(engine, market);
  flav.BONK = HOT; market.t += MIN; market.prices['BONK-USD'] *= 1.02; await engine.scan();
  const entry = engine.state.positions['BONK-USD'].entryPrice;
  market.prices['BONK-USD'] = entry * 1.25; market.t += MIN; await engine.managePositions(); // +~24% at bid
  assert.ok(engine.state.positions['BONK-USD']);
  market.prices['BONK-USD'] = entry * 1.12; market.t += MIN; await engine.managePositions(); // -10% from high
  assert.strictEqual(engine.state.positions['BONK-USD'], undefined);
  assert.ok(engine.state.realizedPnl > 0, `pnl ${engine.state.realizedPnl}`);
});

test('only sells what the bot bought, never your other coins', async () => {
  const { engine, market, broker, flav } = setup();
  broker.holdings.BONK = 50_000_000; // you already owned BONK
  await warmup(engine, market);
  flav.BONK = HOT; market.t += MIN; market.prices['BONK-USD'] *= 1.02; await engine.scan();
  const botQty = engine.state.positions['BONK-USD'].qty;
  market.prices['BONK-USD'] *= 0.8; market.t += MIN; await engine.managePositions();
  assert.ok(Math.abs(broker.holdings.BONK - 50_000_000) < 1, `left ${broker.holdings.BONK}, bot had ${botQty}`);
});

test('portfolio stop liquidates and halts', async () => {
  const { engine, market, flav } = setup({ risk: { portfolioStopPct: -5, stopLossPct: -90 } });
  await warmup(engine, market);
  flav.BONK = HOT; market.t += MIN; market.prices['BONK-USD'] *= 1.02; await engine.scan();
  market.prices['BONK-USD'] *= 0.4; market.t += MIN;
  await engine.scan();
  assert.ok(engine.state.halted && /portfolio stop/.test(engine.state.halted.reason));
  assert.strictEqual(Object.keys(engine.state.positions).length, 0);
});

test('crash between sending and confirming an order is recovered once', async () => {
  const { engine, market, broker } = setup();
  await engine.loadUniverse();
  const req = { clientOrderId: '0b1c2d3e-aaaa-4bbb-8ccc-ddddeeeeffff', side: 'buy', type: 'market', symbol: 'WIF-USD', assetQuantity: '100.00' };
  await broker.placeOrder(req); // exchange filled it
  engine.state.pending[req.clientOrderId] = { ...req, reason: 'test' }; // bot never saw the response
  market.t += MIN;
  await engine.scan();
  assert.ok(engine.state.positions['WIF-USD']);
  assert.strictEqual(engine.state.positions['WIF-USD'].qty, 100);
  assert.strictEqual([...broker.orders.values()].filter((o) => o.clientOrderId === req.clientOrderId).length, 1);
});

test('state survives a restart (JSON round trip)', async () => {
  const { engine, market, broker, flav } = setup();
  await warmup(engine, market);
  flav.BONK = HOT; market.t += MIN; market.prices['BONK-USD'] *= 1.02; await engine.scan();
  const saved = JSON.parse(JSON.stringify({ engine: engine.snapshot(), paper: broker.toJSON() }));
  const b2 = new PaperBroker({ priceSource: market, startingCash: 0 });
  b2.restore(saved.paper);
  const e2 = new MomentumEngine({ cfg: cfg(), broker: b2, dex: fakeDex(market, flav), log: quietLog, state: saved.engine, now: () => market.now(), sleep: async () => {} });
  assert.ok(e2.state.positions['BONK-USD']);
  assert.ok(Object.keys(e2.history.series).length > 0, 'price history restored, no new warmup');
  assert.strictEqual(e2.cash().toFixed(6), engine.cash().toFixed(6));
});

test('evaluate reports every check', () => {
  const h = new PriceHistory();
  const now = 1e12;
  for (let i = 60; i >= 3; i--) h.add('X-USD', 1, now - i * MIN);
  const r = evaluate({ symbol: 'X-USD', metrics: { ok: true, symbolMatches: true, dexSymbol: 'X', priceUsd: 1.01, ...HOT }, quote: { bid: 1.0, ask: 1.02, mid: 1.01 }, history: h, now, cfg: cfg() });
  assert.strictEqual(r.pass, true, JSON.stringify(r.fail));
  assert.deepStrictEqual(Object.keys(r.checks).sort(), ['breakout', 'buyRatio', 'change1h', 'history', 'liquidity', 'priceAgrees', 'score', 'spread', 'symbolMatch', 'volumeAccel']);
});
