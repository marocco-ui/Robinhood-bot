// The trading logic, independent of where orders go (paper or Robinhood).
// One step at a time: wait for open orders, sell anything that isn't the target, then buy the
// target with settled cash. Cash accounts can't spend sale proceeds until they settle (T+1),
// so a switch takes two trading days: sell today, buy once the cash shows as buying power.
const fs = require('fs');
const { trendSignal, isRegularHours } = require('./strategy');

const TERMINAL = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'failed', 'voided', 'partially_filled_rest_cancelled']);

class TrendEngine {
  constructor({ cfg, broker, log, state, saveState, alert = async () => {}, now = () => new Date(), stopFile }) {
    this.cfg = cfg;
    this.broker = broker;
    this.log = log;
    this.state = state || { pending: null, signal: null, lastStatusDay: null, orderSeq: 0 };
    this.saveState = saveState || (() => {});
    this.alert = alert;
    this.now = now;
    this.stopFile = stopFile;
  }

  managed() { return [this.cfg.risk, this.cfg.safe]; }

  async refreshSignal() {
    const month = this.now().toISOString().slice(0, 7);
    if (this.state.signal && this.state.signal.checkedMonth === month) return this.state.signal;
    const closes = await this.broker.monthCloses(this.cfg.risk, this.cfg.smaMonths + 2);
    // Only completed months count; drop the current month if the feed includes it.
    const done = closes.filter((m) => m.month < month);
    const sig = trendSignal(done, this.cfg);
    if (!sig) throw new Error(`Not enough monthly history for ${this.cfg.risk} (${done.length} months)`);
    const prev = this.state.signal && this.state.signal.target;
    this.state.signal = { ...sig, checkedMonth: month };
    this.saveState(this.state);
    this.log.event('signal', { target: sig.target, month: sig.month, close: sig.lastClose, sma: sig.sma, gapPct: sig.gapPct });
    if (prev && prev !== sig.target) await this.alert(`Trend flipped: now ${sig.target} (${this.cfg.risk} ${sig.gapPct}% vs its ${this.cfg.smaMonths}-month average)`);
    return this.state.signal;
  }

  async tick() {
    if (this.stopFile && fs.existsSync(this.stopFile)) return { action: 'stopped' };
    if (!this.cfg.ignoreHours && !isRegularHours(this.now())) return { action: 'market_closed' };

    if (this.state.pending) {
      const p = this.state.pending;
      if (!p.orderId) {
        // Crashed between saving and placing. Re-send with the same refId: Robinhood dedupes it.
        return this.place(p);
      }
      const o = await this.broker.order(p.orderId);
      if (!TERMINAL.has(o.state)) return { action: 'waiting', order: p.orderId, state: o.state };
      this.log.event('order_done', { symbol: p.symbol, side: p.side, state: o.state, qty: o.filledQty, price: o.avgPrice });
      if (o.state === 'filled' && o.filledQty > 0) {
        this.account(p.side, o.filledQty * o.avgPrice);
        this.log.trade({ mode: this.cfg.mode, symbol: p.symbol, side: p.side, type: 'market', qty: o.filledQty, price: o.avgPrice, reason: p.reason, orderId: p.orderId });
        await this.alert(`${p.side === 'buy' ? 'Bought' : 'Sold'} ${o.filledQty} ${p.symbol} at $${o.avgPrice}`);
      } else {
        await this.alert(`Order ${p.side} ${p.symbol} ended ${o.state}`);
      }
      this.state.pending = null;
      this.saveState(this.state);
      return { action: 'order_done', state: o.state };
    }

    const sig = await this.refreshSignal();
    const positions = await this.broker.positions();
    const held = Object.fromEntries(positions.filter((p) => this.managed().includes(p.symbol)).map((p) => [p.symbol, p]));

    // 1. Sell whatever managed holding isn't the target.
    for (const sym of this.managed()) {
      if (sym === sig.target) continue;
      const pos = held[sym];
      if (pos && pos.sellable > 0) {
        return this.place({ side: 'sell', symbol: sym, quantity: pos.sellable, reason: `trend says ${sig.target}` });
      }
    }

    // 2. Buy the target with settled cash. Money from the bot's own sales is always reinvested;
    //    new money from the account is limited to STOCK_CAPITAL_USD in total.
    const [bp, price] = await Promise.all([this.broker.buyingPower(), this.broker.price(sig.target)]);
    const targetValue = ((held[sig.target] && held[sig.target].quantity) || 0) * price;
    if (this.state.contributed === undefined) {
      // First run, or a state file from before this was tracked: count what's already invested.
      this.state.contributed = Math.min(this.cfg.capitalUsd, targetValue);
      this.state.earmarked = this.state.earmarked || 0;
      this.saveState(this.state);
    }
    const newMoney = Math.max(0, Math.min(this.cfg.capitalUsd - this.state.contributed, this.cfg.maxOrderUsd));
    const spend = Math.floor(Math.min(bp - this.cfg.cashReserveUsd, (this.state.earmarked || 0) + newMoney) * 100) / 100;
    await this.dailyStatus({ sig, bp, targetValue, held });
    if (spend >= this.cfg.minOrderUsd) {
      return this.place({ side: 'buy', symbol: sig.target, dollarAmount: spend, reason: `trend says ${sig.target}` });
    }
    return { action: 'hold', target: sig.target };
  }

  // Track where buy money comes from: the bot's own sale proceeds first, then new money.
  account(side, amount) {
    if (side === 'sell') {
      this.state.earmarked = (this.state.earmarked || 0) + amount;
    } else {
      const fromSales = Math.min(amount, this.state.earmarked || 0);
      this.state.earmarked = (this.state.earmarked || 0) - fromSales;
      this.state.contributed = (this.state.contributed || 0) + (amount - fromSales);
    }
  }

  async place(p) {
    if (!p.refId) {
      this.state.orderSeq = (this.state.orderSeq || 0) + 1;
      p.refId = `stock-trend-${this.now().toISOString().slice(0, 10)}-${p.side}-${p.symbol}-${this.state.orderSeq}`;
      this.state.pending = { ...p, orderId: null, createdAt: this.now().toISOString() };
      this.saveState(this.state); // before placing, so a crash can't lose track of the order
    }
    const req = { symbol: p.symbol, side: p.side, quantity: p.quantity, dollarAmount: p.dollarAmount, refId: p.refId };
    const review = await this.broker.review(req);
    if (review.checks.length) {
      // Buying power, halts, pattern day trading and so on: don't force it, flag it.
      this.state.pending = null;
      this.saveState(this.state);
      this.log.event('order_blocked', { symbol: p.symbol, side: p.side, checks: review.checks.join('; ') }, 'error');
      await this.alert(`Did not ${p.side} ${p.symbol}: ${review.checks.join('; ')}`);
      return { action: 'blocked', checks: review.checks };
    }
    const placed = await this.broker.place(req);
    this.state.pending = { ...this.state.pending, orderId: placed.orderId };
    this.saveState(this.state);
    this.log.event('order_placed', { symbol: p.symbol, side: p.side, quantity: p.quantity, dollars: p.dollarAmount, orderId: placed.orderId, reason: p.reason });
    return { action: 'placed', orderId: placed.orderId, side: p.side, symbol: p.symbol };
  }

  async dailyStatus({ sig, bp, targetValue, held }) {
    const day = this.now().toISOString().slice(0, 10);
    if (this.state.lastStatusDay === day) return;
    this.state.lastStatusDay = day;
    this.saveState(this.state);
    this.log.event('status', { target: sig.target, gapPct: sig.gapPct, buyingPower: +bp.toFixed(2), targetValue: +targetValue.toFixed(2), holdings: Object.keys(held).join(' ') || 'none' });
  }
}

module.exports = { TrendEngine, TERMINAL };
