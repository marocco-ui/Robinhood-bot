// Grid engine. Works with any broker from shared/brokers.js (live, paper, or backtest replay).
//
// The range [lower, upper] is split into `gridCount` slots. Slot i spans price p[i] -> p[i+1].
//   idle    : no coins, no order
//   buying  : limit BUY resting at p[i]
//   holding : bought, sell not placed yet (transient)
//   selling : limit SELL resting at p[i+1]
// A filled buy flips the slot to selling one step up; a filled sell banks the step and the
// slot goes back to idle, ready to buy again. Only the nearest `maxOpenBuys` idle slots below
// the price get buy orders, and total exposure is capped at `maxCapitalUsd`.
const crypto = require('crypto');
const { floorTo, roundTo } = require('../../shared/decimal');
const { TERMINAL } = require('../../shared/brokers');

function buildLevels({ lower, upper, gridCount, spacing }, quoteIncrement) {
  const levels = [];
  for (let i = 0; i <= gridCount; i++) {
    const p = spacing === 'geometric'
      ? lower * Math.pow(upper / lower, i / gridCount)
      : lower + ((upper - lower) * i) / gridCount;
    levels.push(Number(roundTo(p, quoteIncrement)));
  }
  return levels;
}

function gridSignature(cfg) {
  return `${cfg.symbol}|${cfg.lower}|${cfg.upper}|${cfg.gridCount}|${cfg.spacing}|${cfg.orderUsd}`;
}

class GridEngine {
  constructor({ cfg, broker, log, alerts, state, now = () => Date.now() }) {
    this.cfg = cfg;
    this.broker = broker;
    this.log = log;
    this.alerts = alerts || { send: async () => {} };
    this.now = now;
    this.state = state || null;
    this.pair = null;
    this.levels = [];
    this.ticks = 0;
  }

  get asset() {
    return this.cfg.symbol.split('-')[0];
  }

  async init() {
    this.pair = await this.broker.getPair(this.cfg.symbol);
    if (this.pair.status && this.pair.status !== 'tradable') {
      throw new Error(`${this.cfg.symbol} status is ${this.pair.status} on Robinhood`);
    }
    this.levels = buildLevels(this.cfg, this.pair.quoteIncrement);
    const sig = gridSignature(this.cfg);

    if (!this.state) {
      this.state = this.freshState(sig);
    } else if (this.state.signature !== sig) {
      const active = this.state.slots.some((s) => s.status !== 'idle');
      if (active) {
        throw new Error(
          'Grid settings changed but the old grid still has open orders or coins. ' +
          'Run `npm run flatten` (cancel orders + sell grid coins) or restore the old settings.'
        );
      }
      this.log.event('grid_rebuilt', { old: this.state.signature, new: sig });
      const keep = { realizedPnl: this.state.realizedPnl, roundTrips: this.state.roundTrips, fees: this.state.fees };
      this.state = { ...this.freshState(sig), ...keep };
    }

    this.log.event('grid_init', {
      mode: this.broker.mode,
      symbol: this.cfg.symbol,
      lower: this.levels[0],
      upper: this.levels[this.levels.length - 1],
      slots: this.cfg.gridCount,
      stepPct: +this.cfg.stepPct.toFixed(3),
      orderUsd: this.cfg.orderUsd,
      levels: this.levels,
    });
  }

  freshState(signature) {
    return {
      signature,
      createdAt: new Date(this.now()).toISOString(),
      slots: Array.from({ length: this.cfg.gridCount }, (_, i) => ({ i, status: 'idle', qty: 0, cost: 0 })),
      realizedPnl: 0,
      roundTrips: 0,
      fees: 0,
      dust: 0,
      halted: null,
    };
  }

  // ---------- main loop step ----------
  async tick() {
    this.ticks++;
    if (this.state.halted) return { halted: this.state.halted };

    await this.broker.sync();
    const quote = await this.broker.getQuote(this.cfg.symbol);

    await this.recoverPending();
    await this.updateOrders();

    if (this.cfg.stopLossPct > 0 && quote.bid < this.levels[0] * (1 - this.cfg.stopLossPct / 100)) {
      await this.flatten(`stop-loss: bid ${quote.bid.toPrecision(6)} < ${(this.levels[0] * (1 - this.cfg.stopLossPct / 100)).toPrecision(6)}`);
      return { halted: this.state.halted };
    }

    await this.placeSells(quote);
    await this.manageBuys(quote);

    const summary = this.summary(quote);
    if (this.ticks % this.cfg.statusEveryTicks === 1) this.log.event('status', summary);
    return summary;
  }

  // An order request that was sent but whose response we never saw (crash, timeout).
  // Re-sending the same client_order_id returns the original order instead of a duplicate.
  async recoverPending() {
    for (const slot of this.state.slots) {
      if (!slot.pending) continue;
      try {
        const order = await this.broker.placeOrder(slot.pending);
        slot.orderId = order.id;
        delete slot.pending;
        this.log.event('order_recovered', { slot: slot.i, orderId: order.id, state: order.state });
      } catch (err) {
        this.log.error('order_recover_failed', err, { slot: slot.i });
      }
    }
  }

  async updateOrders() {
    const active = this.state.slots.filter((s) => s.orderId && (s.status === 'buying' || s.status === 'selling'));
    if (!active.length) return;
    const open = new Set((await this.broker.listOpenOrders(this.cfg.symbol)).map((o) => o.id));
    for (const slot of active) {
      if (open.has(slot.orderId)) continue;
      let order;
      try {
        order = await this.broker.getOrder(slot.orderId);
        slot.misses = 0;
      } catch (err) {
        if (err.status === 404) {
          // Not open and not found. After 3 straight misses, assume it never filled and free
          // the slot (a buy goes idle, a sell goes back to holding so it gets re-placed).
          slot.misses = (slot.misses || 0) + 1;
          if (slot.misses >= 3) {
            this.log.event('order_missing', { slot: slot.i, orderId: slot.orderId, note: 'treated as canceled, unfilled' }, 'warn');
            slot.misses = 0;
            this.applyTerminal(slot, { id: slot.orderId, state: 'canceled', filledQty: 0, side: slot.status === 'buying' ? 'buy' : 'sell' });
          }
          continue;
        }
        this.log.error('order_lookup_failed', err, { slot: slot.i, orderId: slot.orderId });
        continue;
      }
      if (!TERMINAL.has(order.state)) continue; // e.g. briefly between states
      this.applyTerminal(slot, order);
    }
  }

  applyTerminal(slot, order) {
    const filled = order.filledQty || 0;
    const price = order.avgPrice || order.limitPrice || 0;
    const fee = order.fee || 0;
    this.state.fees += fee;
    if (filled > 0) {
      this.log.trade({ mode: this.broker.mode, symbol: this.cfg.symbol, side: order.side, type: order.type, qty: filled, price, fee, reason: `slot ${slot.i}`, orderId: order.id });
    }

    if (slot.status === 'buying') {
      if (filled > 0) {
        slot.qty = filled;
        slot.cost = filled * price + fee;
        slot.status = 'holding';
        this.log.event('buy_filled', { slot: slot.i, qty: filled, price, state: order.state });
      } else {
        slot.status = 'idle';
        if (order.state === 'failed') this.log.event('buy_failed', { slot: slot.i, orderId: order.id }, 'warn');
      }
    } else if (slot.status === 'selling') {
      if (filled > 0) {
        const costPart = slot.cost * (filled / slot.qty);
        const pnl = filled * price - fee - costPart;
        this.state.realizedPnl += pnl;
        slot.cost -= costPart;
        slot.qty -= filled;
        this.log.event('sell_filled', { slot: slot.i, qty: filled, price, pnl: +pnl.toFixed(4), state: order.state });
        if (slot.qty <= this.minQty()) {
          this.state.dust += Math.max(0, slot.qty);
          slot.qty = 0;
          slot.cost = 0;
          slot.status = 'idle';
          this.state.roundTrips++;
          this.alerts.send(`✅ Grid round trip on slot ${slot.i}: +$${pnl.toFixed(2)} (total $${this.state.realizedPnl.toFixed(2)})`, { silent: true });
        } else {
          slot.status = 'holding';
        }
      } else {
        slot.status = 'holding';
        if (order.state === 'failed') this.log.event('sell_failed', { slot: slot.i, orderId: order.id }, 'warn');
      }
    }
    delete slot.orderId;
  }

  minQty() {
    return Math.max(Number(this.pair.minOrderSize) || 0, Number(this.pair.assetIncrement) || 0);
  }

  async placeSells() {
    for (const slot of this.state.slots) {
      if (slot.status !== 'holding') continue;
      const qty = floorTo(slot.qty, this.pair.assetIncrement);
      if (Number(qty) < this.minQty()) {
        this.state.dust += slot.qty;
        Object.assign(slot, { status: 'idle', qty: 0, cost: 0 });
        continue;
      }
      await this.submit(slot, 'sell', qty, this.levels[slot.i + 1], 'selling');
    }
  }

  committedUsd() {
    let total = 0;
    for (const s of this.state.slots) {
      if (s.status === 'buying') total += this.cfg.orderUsd;
      else if (s.status === 'holding' || s.status === 'selling') total += s.cost;
    }
    return total;
  }

  async manageBuys(quote) {
    const price = quote.bid;
    const below = this.state.slots
      .filter((s) => this.levels[s.i] < price && (s.status === 'idle' || s.status === 'buying'))
      .sort((a, b) => this.levels[b.i] - this.levels[a.i]);
    const wanted = new Set(below.slice(0, this.cfg.maxOpenBuys).map((s) => s.i));
    const keep = new Set(below.slice(0, this.cfg.maxOpenBuys + 2).map((s) => s.i)); // hysteresis

    // Cancel buys that drifted too far below the price (or above it) to free capital.
    for (const s of this.state.slots) {
      if (s.status === 'buying' && s.orderId && !keep.has(s.i)) {
        await this.broker.cancelOrder(s.orderId);
        this.log.event('buy_cancel_far', { slot: s.i, level: this.levels[s.i], price });
        // Fill status is resolved next tick via updateOrders.
      }
    }

    for (const s of below) {
      if (!wanted.has(s.i) || s.status !== 'idle') continue;
      if (this.committedUsd() + this.cfg.orderUsd > this.cfg.maxCapitalUsd + 1e-9) {
        this.log.event('capital_cap', { committed: +this.committedUsd().toFixed(2), cap: this.cfg.maxCapitalUsd });
        break;
      }
      const level = this.levels[s.i];
      const qty = floorTo(this.cfg.orderUsd / level, this.pair.assetIncrement);
      if (Number(qty) < this.minQty()) {
        this.log.event('order_too_small', { slot: s.i, qty, min: this.minQty() }, 'warn');
        continue;
      }
      await this.submit(s, 'buy', qty, level, 'buying');
    }
  }

  async submit(slot, side, qty, limitPrice, nextStatus) {
    const req = {
      clientOrderId: crypto.randomUUID(),
      side,
      type: 'limit',
      symbol: this.cfg.symbol,
      assetQuantity: qty,
      limitPrice: roundTo(limitPrice, this.pair.quoteIncrement),
    };
    // Record intent before sending so a crash mid-request can be recovered.
    slot.pending = req;
    slot.status = nextStatus;
    if (this.onPersist) this.onPersist();
    try {
      const order = await this.broker.placeOrder(req);
      delete slot.pending;
      slot.orderId = order.id;
      this.log.event('order_placed', { slot: slot.i, side, qty, price: Number(req.limitPrice), orderId: order.id, state: order.state });
      if (order.state === 'failed') this.applyTerminal(slot, order);
    } catch (err) {
      // 4xx = rejected, safe to forget. Otherwise leave `pending` for recovery next tick.
      if (err.status >= 400 && err.status < 500) {
        delete slot.pending;
        slot.status = side === 'buy' ? 'idle' : 'holding';
      }
      this.log.error('order_place_failed', err, { slot: slot.i, side, qty, price: Number(req.limitPrice) });
    }
  }

  // Cancel every grid order, market-sell the coins the grid bought, and halt.
  async flatten(reason) {
    this.log.event('flatten_start', { reason }, 'warn');
    await this.cancelAll();
    await this.broker.sync();
    await this.updateOrders();
    const gridQty = this.state.slots.reduce((sum, s) => sum + s.qty, 0);
    const available = await this.broker.getHolding(this.asset);
    const qty = floorTo(Math.min(gridQty, available), this.pair.assetIncrement);
    if (Number(qty) >= this.minQty()) {
      const order = await this.broker.placeOrder({ clientOrderId: crypto.randomUUID(), side: 'sell', type: 'market', symbol: this.cfg.symbol, assetQuantity: qty });
      this.log.event('flatten_sell', { qty, orderId: order.id, state: order.state });
      const done = await this.waitForTerminal(order.id);
      const cost = this.state.slots.reduce((sum, s) => sum + s.cost, 0);
      if (done && done.filledQty > 0) {
        const proceeds = done.filledQty * done.avgPrice - (done.fee || 0);
        this.state.realizedPnl += proceeds - cost * (done.filledQty / gridQty);
        this.log.trade({ mode: this.broker.mode, symbol: this.cfg.symbol, side: 'sell', type: 'market', qty: done.filledQty, price: done.avgPrice, fee: done.fee || 0, reason, orderId: done.id });
      }
    }
    for (const s of this.state.slots) Object.assign(s, { status: 'idle', qty: 0, cost: 0, orderId: undefined, pending: undefined });
    this.state.halted = { reason, at: new Date(this.now()).toISOString() };
    this.log.event('halted', { reason }, 'warn');
    await this.alerts.send(`🛑 Grid bot halted: ${reason}. Realized P&L $${this.state.realizedPnl.toFixed(2)}`);
  }

  async cancelAll() {
    for (const s of this.state.slots) {
      if (s.orderId && (s.status === 'buying' || s.status === 'selling')) {
        await this.broker.cancelOrder(s.orderId);
        this.log.event('order_canceled', { slot: s.i, orderId: s.orderId });
      }
    }
  }

  // Graceful stop: cancel resting orders so nothing trades while the bot is offline.
  async shutdown() {
    if (!this.cfg.cancelOnExit) return;
    await this.cancelAll();
    await this.broker.sync();
    await this.updateOrders();
  }

  async waitForTerminal(id, timeoutMs = 30000) {
    const start = Date.now();
    for (;;) {
      await this.broker.sync();
      const o = await this.broker.getOrder(id);
      if (TERMINAL.has(o.state)) return o;
      if (Date.now() - start > timeoutMs) return o;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  summary(quote) {
    const held = this.state.slots.reduce((sum, s) => sum + s.qty, 0);
    const cost = this.state.slots.reduce((sum, s) => sum + s.cost, 0);
    const counts = {};
    for (const s of this.state.slots) counts[s.status] = (counts[s.status] || 0) + 1;
    return {
      mode: this.broker.mode,
      price: +quote.bid.toFixed(4),
      inRange: quote.bid >= this.levels[0] && quote.bid <= this.levels[this.levels.length - 1],
      gridQty: +held.toFixed(8),
      gridCost: +cost.toFixed(2),
      unrealizedPnl: +(held * quote.bid - cost).toFixed(2),
      realizedPnl: +this.state.realizedPnl.toFixed(2),
      roundTrips: this.state.roundTrips,
      committedUsd: +this.committedUsd().toFixed(2),
      slots: counts,
    };
  }
}

module.exports = { GridEngine, buildLevels, gridSignature };
