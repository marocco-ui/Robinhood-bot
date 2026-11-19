// Robinhood Crypto Trading API client (official API, https://trading.robinhood.com).
// Auth: every request is signed with Ed25519 over
//   api_key + timestamp + path(with query string) + METHOD + body
// and sent with x-api-key, x-timestamp, x-signature headers. Timestamps are valid ~30s.
const crypto = require('crypto');
const RateLimiter = require('./rate-limiter');

const BASE_URL = 'https://trading.robinhood.com';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromBase64(b64) {
  const raw = Buffer.from(String(b64).trim(), 'base64');
  // Accept a 32-byte seed or a 64-byte NaCl secret key (seed + public key).
  let seed;
  if (raw.length === 32) seed = raw;
  else if (raw.length === 64) seed = raw.subarray(0, 32);
  else throw new Error(`RH_PRIVATE_KEY must decode to 32 or 64 bytes, got ${raw.length}`);
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function buildQuery(params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const values = Array.isArray(v) ? v : [v];
    for (const item of values) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

class RobinhoodApiError extends Error {
  constructor(status, body, method, path) {
    super(`Robinhood ${method} ${path} -> ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

class RobinhoodClient {
  constructor({ apiKey, privateKeyBase64, baseUrl = BASE_URL, perMinute = 40, timeoutMs = 10000 } = {}) {
    if (!apiKey || !privateKeyBase64) {
      throw new Error('Robinhood credentials missing: set RH_API_KEY and RH_PRIVATE_KEY (see shared/scripts/rh-keygen.js)');
    }
    this.apiKey = apiKey;
    this.privateKey = privateKeyFromBase64(privateKeyBase64);
    this.baseUrl = baseUrl;
    this.limiter = new RateLimiter({ perMinute, burst: 8 });
    this.timeoutMs = timeoutMs;
  }

  sign(timestamp, pathWithQuery, method, body) {
    const message = `${this.apiKey}${timestamp}${pathWithQuery}${method}${body}`;
    return crypto.sign(null, Buffer.from(message, 'utf8'), this.privateKey).toString('base64');
  }

  async request(method, path, { params, body } = {}, attempt = 0) {
    await this.limiter.take();
    const pathWithQuery = path + buildQuery(params);
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      'x-api-key': this.apiKey,
      'x-timestamp': String(timestamp),
      'x-signature': this.sign(timestamp, pathWithQuery, method, bodyStr),
      'Content-Type': 'application/json; charset=utf-8',
    };

    let res;
    try {
      res = await fetch(this.baseUrl + pathWithQuery, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network error/timeout. Retrying is safe for GETs, and for order POSTs because
      // client_order_id makes them idempotent.
      if (attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        return this.request(method, path, { params, body }, attempt + 1);
      }
      throw err;
    }

    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = text; }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) {
        await sleep(2000 * 2 ** attempt);
        return this.request(method, path, { params, body }, attempt + 1);
      }
    }
    if (!res.ok) throw new RobinhoodApiError(res.status, data, method, path);
    return data;
  }

  // Follows `next` links for paginated list endpoints.
  async listAll(path, params) {
    const out = [];
    let page = await this.request('GET', path, { params });
    for (;;) {
      out.push(...(page.results || []));
      if (!page.next) break;
      const next = new URL(page.next);
      const nextParams = {};
      for (const [k, v] of next.searchParams) {
        nextParams[k] = nextParams[k] === undefined ? v : [].concat(nextParams[k], v);
      }
      page = await this.request('GET', next.pathname, { params: nextParams });
    }
    return out;
  }

  // ---- Account ----
  getAccount() {
    return this.request('GET', '/api/v1/crypto/trading/accounts/');
  }

  getHoldings(assetCodes = []) {
    return this.listAll('/api/v1/crypto/trading/holdings/', { asset_code: assetCodes });
  }

  // ---- Market data ----
  getTradingPairs(symbols = []) {
    return this.listAll('/api/v1/crypto/trading/trading_pairs/', { symbol: symbols });
  }

  async getBestBidAsk(symbols) {
    const data = await this.request('GET', '/api/v1/crypto/marketdata/best_bid_ask/', {
      params: { symbol: symbols },
    });
    return data.results || [];
  }

  // ---- Orders ----
  placeOrder(order) {
    return this.request('POST', '/api/v1/crypto/trading/orders/', { body: order });
  }

  getOrder(id) {
    return this.request('GET', `/api/v1/crypto/trading/orders/${encodeURIComponent(id)}/`);
  }

  listOrders(params = {}) {
    return this.listAll('/api/v1/crypto/trading/orders/', params);
  }

  cancelOrder(id) {
    return this.request('POST', `/api/v1/crypto/trading/orders/${encodeURIComponent(id)}/cancel/`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { RobinhoodClient, RobinhoodApiError, privateKeyFromBase64, buildQuery };
