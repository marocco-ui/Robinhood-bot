// Spins up a fake Robinhood server that verifies Ed25519 signatures exactly like the real one,
// then drives RobinhoodBroker through it.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { RobinhoodClient } = require('../robinhood');
const { RobinhoodBroker } = require('../brokers');

function startFakeRobinhood(publicKey, apiKey) {
  const orders = new Map();
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = `${req.headers['x-api-key']}${req.headers['x-timestamp']}${req.url}${req.method}${body}`;
      const ok = req.headers['x-api-key'] === apiKey &&
        Math.abs(Date.now() / 1000 - Number(req.headers['x-timestamp'])) < 30 &&
        crypto.verify(null, Buffer.from(msg), publicKey, Buffer.from(req.headers['x-signature'] || '', 'base64'));
      seen.push({ method: req.method, url: req.url, body, ok });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!ok) return send(401, { errors: [{ detail: 'bad signature' }] });
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/v1/crypto/trading/accounts/') return send(200, { account_number: 'ACC1', status: 'active', buying_power: '250.50', buying_power_currency: 'USD' });
      if (url.pathname === '/api/v1/crypto/trading/trading_pairs/') {
        return send(200, { next: null, results: [{ symbol: 'SOL-USD', asset_code: 'SOL', quote_increment: '0.01', asset_increment: '0.00000001', min_order_size: '0.0001', max_order_size: '5000', status: 'tradable' }] });
      }
      if (url.pathname === '/api/v1/crypto/marketdata/best_bid_ask/') {
        return send(200, { results: url.searchParams.getAll('symbol').map((s) => ({ symbol: s, price: '150', bid_inclusive_of_sell_spread: '149.5', ask_inclusive_of_buy_spread: '150.5', timestamp: new Date().toISOString() })) });
      }
      if (url.pathname === '/api/v1/crypto/trading/holdings/') return send(200, { next: null, results: [{ asset_code: 'SOL', total_quantity: '2', quantity_available_for_trading: '1.5' }] });
      if (url.pathname === '/api/v1/crypto/trading/orders/' && req.method === 'POST') {
        const b = JSON.parse(body);
        for (const o of orders.values()) if (o.client_order_id === b.client_order_id) return send(201, o);
        const o = { id: crypto.randomUUID(), account_number: 'ACC1', state: 'open', filled_asset_quantity: '0', average_price: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), executions: [], ...b };
        orders.set(o.id, o);
        return send(201, o);
      }
      if (url.pathname === '/api/v1/crypto/trading/orders/' && req.method === 'GET') {
        const state = url.searchParams.get('state');
        return send(200, { next: null, results: [...orders.values()].filter((o) => !state || o.state === state) });
      }
      const m = url.pathname.match(/^\/api\/v1\/crypto\/trading\/orders\/([^/]+)\/(cancel\/)?$/);
      if (m) {
        const o = orders.get(m[1]);
        if (!o) return send(404, {});
        if (m[2]) { o.state = 'canceled'; return send(200, {}); }
        return send(200, o);
      }
      send(404, { errors: [{ detail: 'not found' }] });
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, orders, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('signed requests, order lifecycle and idempotent retries against a fake Robinhood', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
  const fake = await startFakeRobinhood(publicKey, 'rh-test-key');
  try {
    const client = new RobinhoodClient({ apiKey: 'rh-test-key', privateKeyBase64: seed, baseUrl: fake.url, perMinute: 6000 });
    const broker = new RobinhoodBroker(client);

    assert.strictEqual(await broker.getBuyingPower(), 250.5);
    const pair = await broker.getPair('SOL-USD');
    assert.strictEqual(pair.assetIncrement, '0.00000001');
    const q = await broker.getQuote('SOL-USD');
    assert.deepStrictEqual([q.bid, q.ask], [149.5, 150.5]);
    assert.strictEqual(await broker.getHolding('SOL'), 1.5);

    const req = { clientOrderId: crypto.randomUUID(), side: 'buy', type: 'limit', symbol: 'SOL-USD', assetQuantity: '0.1', limitPrice: '140.00' };
    const o1 = await broker.placeOrder(req);
    const o2 = await broker.placeOrder(req); // retry with same client_order_id
    assert.strictEqual(o1.id, o2.id);
    assert.strictEqual(fake.orders.size, 1);
    assert.strictEqual(o1.limitPrice, 140);
    const posted = JSON.parse(fake.seen.find((s) => s.method === 'POST').body);
    assert.deepStrictEqual(posted.limit_order_config, { asset_quantity: '0.1', limit_price: '140.00', time_in_force: 'gtc' });

    assert.strictEqual((await broker.listOpenOrders('SOL-USD')).length, 1);
    await broker.cancelOrder(o1.id);
    assert.strictEqual((await broker.getOrder(o1.id)).state, 'canceled');
    assert.ok(fake.seen.every((s) => s.ok), 'every request carried a valid signature');
  } finally {
    fake.server.close();
  }
});

test('rejects a wrong key with a clear error', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const fake = await startFakeRobinhood(publicKey, 'rh-test-key');
  try {
    const client = new RobinhoodClient({ apiKey: 'rh-test-key', privateKeyBase64: crypto.randomBytes(32).toString('base64'), baseUrl: fake.url, perMinute: 6000 });
    await assert.rejects(() => client.getAccount(), /401/);
  } finally {
    fake.server.close();
  }
});
