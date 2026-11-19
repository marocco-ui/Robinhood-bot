// Two brokers with the same interface:
//   RobinhoodBroker: real orders through the Robinhood Crypto API.
//   PaperBroker:     simulated orders filled against real (or replayed) prices.
// Bots only talk to this interface, so paper and live run the exact same code path.
const crypto = require('crypto');

const TERMINAL = new Set(['filled', 'canceled', 'failed']);

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeOrder(o) {
  const cfg = o.limit_order_config || o.market_order_config || o.stop_limit_order_config || o.stop_loss_order_config || {};
  return {
    id: o.id,
    clientOrderId: o.client_order_id,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    state: o.state,
    limitPrice: cfg.limit_price !== undefined ? num(cfg.limit_price) : null,
    assetQuantity: cfg.asset_quantity !== undefined ? num(cfg.asset_quantity) : null,
    filledQty: num(o.filled_asset_quantity),
    avgPrice: o.average_price !== null && o.average_price !== undefined ? num(o.average_price) : null,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

function normalizePair(p) {
  return {
    symbol: p.symbol,
    assetCode: p.asset_code,
    quoteIncrement: p.quote_increment,
    assetIncrement: p.asset_increment,
    minOrderSize: num(p.min_order_size),
    maxOrderSize: num(p.max_order_size, Infinity),
    status: p.status,
  };
}

function normalizeQuote(q) {
  const bid = num(q.bid_inclusive_of_sell_spread, num(q.price));
  const ask = num(q.ask_inclusive_of_buy_spread, num(q.price));
  return { symbol: q.symbol, bid, ask, mid: (bid + ask) / 2, ts: q.timestamp ? Date.parse(q.timestamp) : Date.now() };
}

function buildOrderBody({ clientOrderId, side, type, symbol, assetQuantity, limitPrice }) {
  const body = { client_order_id: clientOrderId, side, type, symbol };
  if (type === 'market') {
    body.market_order_config = { asset_quantity: String(assetQuantity) };
  } else if (type === 'limit') {
    body.limit_order_config = {
      asset_quantity: String(assetQuantity),
      limit_price: String(limitPrice),
      time_in_force: 'gtc',
    };
  } else {
    throw new Error(`Unsupported order type ${type}`);
  }
  return body;
}

class RobinhoodBroker {
  constructor(client) {
    this.client = client;
    this.mode = 'live';
    this.pairCache = new Map();
  }

  async getPairs(symbols) {
    const pairs = (await this.client.getTradingPairs(symbols)).map(normalizePair);
    for (const p of pairs) this.pairCache.set(p.symbol, p);
    return pairs;
  }

  async getPair(symbol) {
    if (!this.pairCache.has(symbol)) await this.getPairs([symbol]);
    const p = this.pairCache.get(symbol);
    if (!p) throw new Error(`Robinhood does not list ${symbol}`);
    return p;
  }

  async getQuotes(symbols) {
    const out = new Map();
    if (!symbols.length) return out;
    // best_bid_ask takes repeated symbol params; keep requests modest.
    for (let i = 0; i < symbols.length; i += 20) {
      const rows = await this.client.getBestBidAsk(symbols.slice(i, i + 20));
      for (const r of rows) out.set(r.symbol, normalizeQuote(r));
    }
    return out;
  }

  async getQuote(symbol) {
    const q = (await this.getQuotes([symbol])).get(symbol);
    if (!q) throw new Error(`No quote for ${symbol}`);
    return q;
  }

  async getBuyingPower() {
    const acct = await this.client.getAccount();
    return num(acct.buying_power);
  }

  async getHolding(assetCode) {
    const rows = await this.client.getHoldings([assetCode]);
    const row = rows.find((r) => r.asset_code === assetCode);
    return row ? num(row.quantity_available_for_trading, num(row.total_quantity)) : 0;
  }

  async placeOrder(req) {
    return normalizeOrder(await this.client.placeOrder(buildOrderBody(req)));
  }

  async getOrder(id) {
    return normalizeOrder(await this.client.getOrder(id));
  }

  async listOpenOrders(symbol) {
    const [open, partial] = await Promise.all([
      this.client.listOrders({ symbol, state: 'open' }),
      this.client.listOrders({ symbol, state: 'partially_filled' }),
    ]);
    return [...open, ...partial].map(normalizeOrder);
  }

  async cancelOrder(id) {
    try {
      await this.client.cancelOrder(id);
    } catch (err) {
      // Already filled/canceled orders can't be canceled; caller re-reads state.
      if (!(err.status >= 400 && err.status < 500)) throw err;
    }
  }

  async sync() {}
}

// Simulated exchange. Prices come from `priceSource` (a RobinhoodBroker for live
// paper trading, or a replay feed for backtests).
class PaperBroker {
  // Fees: makerFeeBps applies to limit orders that rest before filling, takerFeeBps to market
  // orders and limits that fill on arrival. `feeBps` sets both (Robinhood default routing has
  // no fee line; its cost is in the bid/ask spread).
  constructor({ priceSource, startingCash = 1000, feeBps = 0, makerFeeBps, takerFeeBps, pairs = {} } = {}) {
    this.priceSource = priceSource;
    this.mode = 'paper';
    this.cash = startingCash;
    this.holdings = {};
    this.orders = new Map();
    this.makerFeeBps = makerFeeBps ?? feeBps;
    this.takerFeeBps = takerFeeBps ?? feeBps;
    this.feeBps = Math.max(this.makerFeeBps, this.takerFeeBps); // used for cash reservation
    this.pairOverrides = pairs;
    this.lastQuotes = new Map();
  }

  toJSON() {
    return { cash: this.cash, holdings: this.holdings, orders: [...this.orders.values()] };
  }

  restore(snapshot) {
    if (!snapshot) return;
    this.cash = snapshot.cash;
    this.holdings = snapshot.holdings || {};
    this.orders = new Map((snapshot.orders || []).map((o) => [o.id, o]));
  }

  async getPairs(symbols) {
    if (this.priceSource && this.priceSource.getPairs) return this.priceSource.getPairs(symbols);
    return symbols.map((s) => this.pairOverrides[s] || defaultPair(s));
  }

  async getPair(symbol) {
    if (this.pairOverrides[symbol]) return this.pairOverrides[symbol];
    if (this.priceSource && this.priceSource.getPair) return this.priceSource.getPair(symbol);
    return defaultPair(symbol);
  }

  async getQuotes(symbols) {
    const q = await this.priceSource.getQuotes(symbols);
    for (const [k, v] of q) this.lastQuotes.set(k, v);
    return q;
  }

  async getQuote(symbol) {
    const q = (await this.getQuotes([symbol])).get(symbol);
    if (!q) throw new Error(`No quote for ${symbol}`);
    return q;
  }

  async getBuyingPower() {
    return this.cash;
  }

  async getHolding(assetCode) {
    return this.holdings[assetCode] || 0;
  }

  _reserved() {
    let cash = 0;
    const assets = {};
    for (const o of this.orders.values()) {
      if (TERMINAL.has(o.state)) continue;
      const remaining = o.assetQuantity - o.filledQty;
      if (o.side === 'buy') cash += remaining * o.limitPrice * (1 + this.feeBps / 1e4);
      else assets[o.symbol.split('-')[0]] = (assets[o.symbol.split('-')[0]] || 0) + remaining;
    }
    return { cash, assets };
  }

  _fill(order, price, liquidity = 'taker') {
    const asset = order.symbol.split('-')[0];
    const qty = order.assetQuantity - order.filledQty;
    const bps = liquidity === 'maker' ? this.makerFeeBps : this.takerFeeBps;
    const fee = qty * price * (bps / 1e4);
    if (order.side === 'buy') {
      this.cash -= qty * price + fee;
      this.holdings[asset] = (this.holdings[asset] || 0) + qty;
    } else {
      this.cash += qty * price - fee;
      this.holdings[asset] = (this.holdings[asset] || 0) - qty;
      if (Math.abs(this.holdings[asset]) < 1e-12) this.holdings[asset] = 0;
    }
    order.filledQty = order.assetQuantity;
    order.avgPrice = price;
    order.fee = fee;
    order.liquidity = liquidity;
    order.state = 'filled';
    order.updatedAt = new Date(this.now()).toISOString();
  }

  now() {
    return this.priceSource && this.priceSource.now ? this.priceSource.now() : Date.now();
  }

  async placeOrder({ clientOrderId, side, type, symbol, assetQuantity, limitPrice }) {
    // Idempotency like the real API: same client_order_id returns the original order.
    for (const o of this.orders.values()) if (o.clientOrderId === clientOrderId) return { ...o };

    const qty = Number(assetQuantity);
    const asset = symbol.split('-')[0];
    const quote = await this.getQuote(symbol);
    const order = {
      id: crypto.randomUUID(),
      clientOrderId,
      symbol,
      side,
      type,
      state: 'open',
      limitPrice: type === 'limit' ? Number(limitPrice) : null,
      assetQuantity: qty,
      filledQty: 0,
      avgPrice: null,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };

    const reserved = this._reserved();
    const refPrice = type === 'limit' ? Number(limitPrice) : quote.ask;
    if (side === 'buy' && qty * refPrice * (1 + this.feeBps / 1e4) > this.cash - reserved.cash + 1e-9) {
      order.state = 'failed';
      order.reason = 'insufficient buying power';
    }
    if (side === 'sell' && qty > (this.holdings[asset] || 0) - (reserved.assets[asset] || 0) + 1e-12) {
      order.state = 'failed';
      order.reason = 'insufficient holdings';
    }

    this.orders.set(order.id, order);
    if (order.state === 'open') {
      if (type === 'market') this._fill(order, side === 'buy' ? quote.ask : quote.bid, 'taker');
      else this._matchOne(order, quote, 'taker'); // marketable on arrival = taker
    }
    return { ...order };
  }

  // Quote-based matching: a resting buy fills when the ask drops to the limit, a sell when
  // the bid rises to it. Candle-based matching (backtests) uses the candle's low/high.
  _matchOne(order, quote, liquidity = 'maker') {
    if (order.state !== 'open' || order.type !== 'limit') return;
    if (quote.low !== undefined) {
      if (order.side === 'buy' && quote.low <= order.limitPrice) this._fill(order, order.limitPrice, liquidity);
      else if (order.side === 'sell' && quote.high >= order.limitPrice) this._fill(order, order.limitPrice, liquidity);
      return;
    }
    if (order.side === 'buy' && quote.ask <= order.limitPrice) this._fill(order, Math.min(quote.ask, order.limitPrice), liquidity);
    else if (order.side === 'sell' && quote.bid >= order.limitPrice) this._fill(order, Math.max(quote.bid, order.limitPrice), liquidity);
  }

  // Called once per bot loop: pulls fresh prices and fills any resting orders they cross.
  async sync() {
    const symbols = [...new Set([...this.orders.values()].filter((o) => o.state === 'open').map((o) => o.symbol))];
    if (!symbols.length) return;
    // Backtest feeds expose candle high/low for matching; live feeds just return bid/ask.
    const quotes = this.priceSource.getMatchQuotes
      ? await this.priceSource.getMatchQuotes(symbols)
      : await this.getQuotes(symbols);
    for (const o of this.orders.values()) {
      const q = quotes.get(o.symbol);
      if (q) this._matchOne(o, q);
    }
  }

  async getOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw Object.assign(new Error(`Unknown order ${id}`), { status: 404 });
    return { ...o };
  }

  async listOpenOrders(symbol) {
    return [...this.orders.values()].filter((o) => o.symbol === symbol && o.state === 'open').map((o) => ({ ...o }));
  }

  async cancelOrder(id) {
    const o = this.orders.get(id);
    if (o && o.state === 'open') {
      o.state = 'canceled';
      o.updatedAt = new Date(this.now()).toISOString();
    }
  }

  // Drop finished orders older than the given age so the state file doesn't grow forever.
  prune(maxAgeMs = 3 * 86400000) {
    const cutoff = this.now() - maxAgeMs;
    for (const [id, o] of this.orders) {
      if (TERMINAL.has(o.state) && Date.parse(o.updatedAt) < cutoff) this.orders.delete(id);
    }
  }
}

function defaultPair(symbol) {
  return {
    symbol,
    assetCode: symbol.split('-')[0],
    quoteIncrement: '0.01',
    assetIncrement: '0.000001',
    minOrderSize: 0.000001,
    maxOrderSize: Infinity,
    status: 'tradable',
  };
}

module.exports = { RobinhoodBroker, PaperBroker, normalizeOrder, normalizeQuote, normalizePair, buildOrderBody, TERMINAL };
