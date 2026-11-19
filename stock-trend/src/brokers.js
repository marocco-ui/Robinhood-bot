// Two brokers with the same methods:
//   McpBroker:   real Robinhood Agentic account through the Trading MCP (no AI involved)
//   PaperBroker: fake cash and fills at live Robinhood quotes, for testing
const crypto = require('crypto');

const unwrap = (r) => (r && typeof r === 'object' && 'data' in r ? r.data : r);
const num = (x) => (x === null || x === undefined || x === '' ? 0 : Number(x));

// Robinhood's reply shapes aren't documented field by field, so look for keys anywhere.
function findKey(obj, keys, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return undefined;
  seen.add(obj);
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  for (const v of Object.values(obj)) {
    const found = findKey(v, keys, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

class McpBroker {
  constructor({ mcp, accountNumber = '' }) {
    this.mcp = mcp;
    this.accountNumber = accountNumber;
  }

  async init() {
    const accts = unwrap(await this.mcp.call('get_accounts')).accounts || [];
    const ok = accts.filter((a) => a.agentic_allowed);
    const pick = this.accountNumber ? ok.find((a) => a.account_number === this.accountNumber) : ok[0];
    if (!pick) throw new Error(this.accountNumber ? `Account ending ${this.accountNumber.slice(-4)} is not the agent account` : 'No agent-tradable account. Open the Agentic account in the Robinhood app first.');
    this.accountNumber = pick.account_number;
    this.accountType = pick.type;
    return { account: `••••${pick.account_number.slice(-4)}`, type: pick.type, nickname: pick.nickname || '' };
  }

  async buyingPower() {
    const d = unwrap(await this.mcp.call('get_portfolio', { account_number: this.accountNumber }));
    return num(d.buying_power && d.buying_power.buying_power);
  }

  async positions() {
    const out = [];
    let cursor;
    do {
      const d = unwrap(await this.mcp.call('get_equity_positions', { account_number: this.accountNumber, ...(cursor ? { cursor } : {}) }));
      for (const p of d.positions || []) {
        out.push({ symbol: p.symbol, quantity: num(p.quantity), sellable: num(p.shares_available_for_sells ?? p.quantity) });
      }
      cursor = d.next || null;
    } while (cursor);
    return out;
  }

  async quote(symbol) {
    const d = unwrap(await this.mcp.call('get_equity_quotes', { symbols: [symbol] }));
    const q = (d.results || []).map((r) => r.quote).find((x) => x && x.symbol === symbol);
    if (!q || q.state !== 'active') throw new Error(`No active quote for ${symbol}`);
    return { last: num(q.last_trade_price), bid: num(q.bid_price), ask: num(q.ask_price) };
  }

  async price(symbol) { return (await this.quote(symbol)).last; }

  async monthCloses(symbol, months) {
    const start = new Date();
    start.setUTCMonth(start.getUTCMonth() - months - 1, 1);
    const d = unwrap(await this.mcp.call('get_equity_historicals', { symbols: [symbol], start_time: start.toISOString().slice(0, 10), interval: 'month' }));
    const r = (d.results || []).find((x) => x.symbol === symbol);
    return ((r && r.bars) || []).filter((b) => !b.interpolated).map((b) => ({ month: b.begins_at.slice(0, 7), close: num(b.close_price) }));
  }

  orderArgs({ symbol, side, quantity, dollarAmount }) {
    const a = { account_number: this.accountNumber, symbol, side, type: 'market', time_in_force: 'gfd', market_hours: 'regular_hours' };
    if (dollarAmount) a.dollar_amount = dollarAmount.toFixed(2);
    else a.quantity = String(+Number(quantity).toFixed(6));
    return a;
  }

  async review(req) {
    const d = unwrap(await this.mcp.call('review_equity_order', this.orderArgs(req)));
    const checks = findKey(d, ['order_checks']) || [];
    const list = Array.isArray(checks) ? checks : Object.values(checks);
    return { checks: list.map((c) => (typeof c === 'string' ? c : c.message || c.title || c.code || JSON.stringify(c))).filter(Boolean), raw: d };
  }

  async place(req) {
    const d = unwrap(await this.mcp.call('place_equity_order', { ...this.orderArgs(req), ref_id: req.refId }));
    const orderId = findKey(d, ['order_id', 'id']);
    if (!orderId) throw new Error(`Order sent but no order id came back: ${JSON.stringify(d).slice(0, 300)}`);
    return { orderId, approvalRequired: Boolean(findKey(d, ['customer_approval_required'])) };
  }

  async order(orderId) {
    const d = unwrap(await this.mcp.call('get_equity_orders', { account_number: this.accountNumber, order_id: orderId }));
    const o = (d.orders || [])[0];
    // Not visible yet (or still waiting on approval): treat as open.
    if (!o) return { state: 'unconfirmed', filledQty: 0, avgPrice: 0 };
    return { state: o.state, filledQty: num(o.cumulative_quantity ?? o.filled_quantity ?? o.quantity), avgPrice: num(o.average_price ?? o.price) };
  }
}

// Paper trading at live quotes. Fills market orders at the ask (buy) or bid (sell) right away.
// Sale proceeds settle the next calendar day, like a real cash account.
class PaperBroker {
  constructor({ quotes, state, save = () => {}, now = () => new Date() }) {
    this.quotes = quotes; // anything with quote(symbol) and monthCloses(symbol, n)
    this.s = state;
    this.save = save;
    this.now = now;
  }

  settle() {
    const today = this.now().toISOString().slice(0, 10);
    const keep = [];
    for (const u of this.s.unsettled || []) {
      if (u.settles <= today) this.s.cash += u.amount;
      else keep.push(u);
    }
    this.s.unsettled = keep;
  }

  async buyingPower() { this.settle(); return this.s.cash; }
  async positions() { return Object.entries(this.s.positions || {}).filter(([, q]) => q > 1e-9).map(([symbol, q]) => ({ symbol, quantity: q, sellable: q })); }
  async price(symbol) { return (await this.quotes.quote(symbol)).last; }
  monthCloses(symbol, n) { return this.quotes.monthCloses(symbol, n); }

  async review({ side, symbol, quantity, dollarAmount }) {
    this.settle();
    const checks = [];
    if (side === 'buy' && dollarAmount > this.s.cash + 1e-9) checks.push('Not enough buying power');
    if (side === 'sell' && quantity > ((this.s.positions || {})[symbol] || 0) + 1e-9) checks.push('Not enough shares');
    return { checks };
  }

  async place({ side, symbol, quantity, dollarAmount }) {
    const q = await this.quotes.quote(symbol);
    const id = `paper-${crypto.randomUUID()}`;
    this.s.positions = this.s.positions || {};
    let qty;
    let px;
    if (side === 'buy') {
      px = q.ask || q.last;
      qty = +(dollarAmount / px).toFixed(6);
      this.s.cash -= qty * px;
      this.s.positions[symbol] = (this.s.positions[symbol] || 0) + qty;
    } else {
      px = q.bid || q.last;
      qty = quantity;
      this.s.positions[symbol] -= qty;
      const settles = new Date(this.now().getTime() + 864e5).toISOString().slice(0, 10);
      this.s.unsettled = [...(this.s.unsettled || []), { amount: qty * px, settles }];
    }
    this.s.orders = { ...(this.s.orders || {}), [id]: { state: 'filled', filledQty: qty, avgPrice: +px.toFixed(4) } };
    this.save(this.s);
    return { orderId: id };
  }

  async order(id) { return (this.s.orders || {})[id] || { state: 'failed', filledQty: 0, avgPrice: 0 }; }
}

module.exports = { McpBroker, PaperBroker, findKey };
