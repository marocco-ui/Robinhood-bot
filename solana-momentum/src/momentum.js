// Momentum engine: DexScreener signals in, Robinhood orders out.
// Accounting is scoped to this bot's own capital (MOMENTUM_CAPITAL_USD), so other coins or
// cash in your Robinhood account are never counted or sold.
const crypto = require('crypto');
const { floorTo } = require('../../shared/decimal');
const { TERMINAL } = require('../../shared/brokers');
const { evaluate, PriceHistory } = require('./modules/analyzer');
const UNIVERSE = require('./universe');

const HOUR = 3600000;

class MomentumEngine {
  constructor({ cfg, broker, dex, log, alerts, state, now = () => Date.now(), sleep }) {
    this.cfg = cfg;
    this.broker = broker;
    this.dex = dex;
    this.log = log;
    this.alerts = alerts || { send: async () => {} };
    this.now = now;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Keep enough history for the breakout lookback (at least 6h), or long lookbacks never pass.
    const lookbackMs = ((cfg.signal && cfg.signal.breakoutLookbackMin) || 60) * 60000;
    this.history = new PriceHistory({ maxAgeMs: Math.max(6 * HOUR, lookbackMs * 1.25) });
    this.state = state || {
      createdAt: new Date(now()).toISOString(),
      realizedPnl: 0,
      positions: {},
      pending: {},
      cooldowns: {},
      day: null,
      halted: null,
      tradeCount: 0,
    };
    if (this.state.history) this.history.restore(this.state.history);
    this.pairs = {};
    this.pairsLoadedAt = 0;
    this.lastQuotes = new Map();
  }

  snapshot() {
    return { ...this.state, history: this.history.toJSON() };
  }

  async loadUniverse() {
    if (this.now() - this.pairsLoadedAt < HOUR && Object.keys(this.pairs).length) return;
    const wanted = Object.keys(UNIVERSE).filter((s) => !this.cfg.exclude.includes(s)).map((s) => `${s}-USD`);
    const pairs = await this.broker.getPairs(wanted);
    this.pairs = {};
    for (const p of pairs) if (p.status === 'tradable') this.pairs[p.symbol] = p;
    this.pairsLoadedAt = this.now();
    this.log.event('universe', { tradable: Object.keys(this.pairs).join(' '), excluded: this.cfg.exclude.join(' ') });
  }

  // ---------- accounting ----------
  openCost() {
    return Object.values(this.state.positions).reduce((sum, p) => sum + p.cost, 0);
  }

  cash() {
    return this.cfg.risk.capitalUsd + this.state.realizedPnl - this.openCost();
  }

  equity(quotes = this.lastQuotes) {
    let value = this.cash();
    for (const [symbol, p] of Object.entries(this.state.positions)) {
      const q = quotes.get(symbol);
      value += q ? p.qty * q.bid : p.cost;
    }
    return value;
  }

  rollDay(equity) {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (!this.state.day || this.state.day.date !== today) {
      this.state.day = { date: today, startEquity: equity, entriesBlocked: false };
    }
  }

  // ---------- scan for entries ----------
  async scan() {
    if (this.state.halted) return { halted: this.state.halted };
    await this.recoverPending();
    await this.loadUniverse();
    const symbols = Object.keys(this.pairs);
    if (!symbols.length) return { note: 'no tradable symbols' };

    const quotes = await this.broker.getQuotes(symbols);
    const now = this.now();
    for (const [sym, q] of quotes) {
      this.lastQuotes.set(sym, q);
      this.history.add(sym, q.mid, now);
    }

    const equity = this.equity();
    this.rollDay(equity);
    const r = this.cfg.risk;
    if (equity <= r.capitalUsd * (1 + r.portfolioStopPct / 100)) {
      await this.liquidateAll(`portfolio stop: equity $${equity.toFixed(2)} vs capital $${r.capitalUsd}`);
      return { halted: this.state.halted };
    }
    const dayPct = ((equity - this.state.day.startEquity) / this.state.day.startEquity) * 100;
    if (dayPct <= r.dailyLossPct && !this.state.day.entriesBlocked) {
      this.state.day.entriesBlocked = true;
      this.log.event('daily_loss_limit', { dayPct: +dayPct.toFixed(2) }, 'warn');
      await this.alerts.send(`⚠️ Momentum bot down ${dayPct.toFixed(1)}% today. No new entries until tomorrow (UTC).`);
    }

    const mintMap = {};
    for (const sym of symbols) mintMap[sym.split('-')[0]] = UNIVERSE[sym.split('-')[0]];
    let metrics;
    try {
      metrics = await this.dex.getMetrics(mintMap);
    } catch (err) {
      this.log.error('dexscreener_failed', err);
      return { note: 'no dex data' };
    }

    const results = [];
    for (const sym of symbols) {
      const q = quotes.get(sym);
      if (!q) continue;
      const res = evaluate({ symbol: sym, metrics: metrics[sym.split('-')[0]], quote: q, history: this.history, now, cfg: this.cfg });
      results.push(res);
      const m = metrics[sym.split('-')[0]];
      if (m && m.ok && (!m.symbolMatches || (res.checks.priceAgrees && !res.checks.priceAgrees.pass && res.checks.priceAgrees.value > 20))) {
        this.log.event('mapping_warning', { symbol: sym, dexSymbol: m.dexSymbol, priceGapPct: res.checks.priceAgrees?.value }, 'warn');
      }
    }

    const failCounts = {};
    for (const r2 of results) for (const f of r2.fail) failCounts[f] = (failCounts[f] || 0) + 1;
    const ranked = results.slice().sort((a, b) => b.score - a.score);
    this.log.event('scan', {
      symbols: results.length,
      passed: results.filter((x) => x.pass).length,
      equity: +equity.toFixed(2),
      top: ranked.slice(0, 3).map((x) => `${x.symbol}:${x.score}${x.pass ? '✓' : `(${x.fail.join('/')})`}`).join(' '),
      failCounts,
      details: ranked.slice(0, 5).map((x) => ({ symbol: x.symbol, score: x.score, checks: x.checks })),
    });

    const open = Object.keys(this.state.positions).length;
    if (this.dryRun || this.state.day.entriesBlocked || open >= r.maxPositions) return { results };
    const candidates = ranked.filter((x) => x.pass && !this.state.positions[x.symbol] && !this.inCooldown(x.symbol));
    if (candidates.length) await this.enter(candidates[0], quotes.get(candidates[0].symbol));
    return { results };
  }

  inCooldown(symbol) {
    const until = this.state.cooldowns[symbol];
    return until && this.now() < until;
  }

  // ---------- orders ----------
  async marketOrder(side, symbol, qty, reason) {
    const req = { clientOrderId: crypto.randomUUID(), side, type: 'market', symbol, assetQuantity: qty };
    this.state.pending[req.clientOrderId] = { ...req, reason, at: this.now() };
    if (this.onPersist) this.onPersist();
    let order = await this.broker.placeOrder(req);
    this.log.event('order_placed', { symbol, side, qty: Number(qty), orderId: order.id, state: order.state, reason });
    for (let i = 0; i < 20 && !TERMINAL.has(order.state); i++) {
      await this.sleep(1500);
      await this.broker.sync();
      order = await this.broker.getOrder(order.id);
    }
    delete this.state.pending[req.clientOrderId];
    if (!TERMINAL.has(order.state)) this.log.event('order_not_final', { orderId: order.id, state: order.state }, 'warn');
    return order;
  }

  // Sent-but-unconfirmed orders from a crash: re-send with the same client_order_id
  // (idempotent), then apply whatever actually happened.
  async recoverPending() {
    for (const [id, p] of Object.entries(this.state.pending)) {
      try {
        const order = await this.broker.placeOrder(p);
        const final = TERMINAL.has(order.state) ? order : await this.broker.getOrder(order.id);
        this.log.event('order_recovered', { symbol: p.symbol, side: p.side, state: final.state, filled: final.filledQty });
        if (final.filledQty > 0) {
          if (p.side === 'buy' && !this.state.positions[p.symbol]) this.openPosition(p.symbol, final, p.reason || 'recovered');
          if (p.side === 'sell' && this.state.positions[p.symbol]) this.closePosition(p.symbol, final, p.reason || 'recovered');
        }
        delete this.state.pending[id];
      } catch (err) {
        this.log.error('recover_failed', err, { symbol: p.symbol });
      }
    }
  }

  async enter(signal, quote) {
    const r = this.cfg.risk;
    const pair = this.pairs[signal.symbol];
    const sizeUsd = Math.min(r.maxPositionUsd, this.equity() * (r.positionPct / 100), this.cash());
    const buyingPower = await this.broker.getBuyingPower();
    if (sizeUsd > buyingPower) {
      this.log.event('skip_entry', { symbol: signal.symbol, reason: 'not enough buying power', sizeUsd, buyingPower }, 'warn');
      return;
    }
    const qty = floorTo(sizeUsd / quote.ask, pair.assetIncrement);
    if (Number(qty) < Number(pair.minOrderSize) || sizeUsd < 5) {
      this.log.event('skip_entry', { symbol: signal.symbol, reason: 'size below minimum', qty, sizeUsd }, 'warn');
      return;
    }
    const order = await this.marketOrder('buy', signal.symbol, qty, `score ${signal.score}`);
    if (order.filledQty > 0) this.openPosition(signal.symbol, order, `score ${signal.score}`, signal);
    else this.log.event('entry_not_filled', { symbol: signal.symbol, state: order.state }, 'warn');
  }

  openPosition(symbol, order, reason, signal) {
    const r = this.cfg.risk;
    const price = order.avgPrice;
    const pos = {
      symbol,
      qty: order.filledQty,
      entryPrice: price,
      cost: order.filledQty * price + (order.fee || 0),
      entryTime: this.now(),
      high: price,
      stop: price * (1 + r.stopLossPct / 100),
      takeProfit: price * (1 + r.takeProfitPct / 100),
      score: signal ? signal.score : null,
    };
    this.state.positions[symbol] = pos;
    this.state.tradeCount++;
    this.log.trade({ mode: this.broker.mode, symbol, side: 'buy', type: 'market', qty: pos.qty, price, fee: order.fee || 0, reason, orderId: order.id });
    this.log.event('entered', { symbol, qty: pos.qty, price, cost: +pos.cost.toFixed(2), stop: pos.stop, takeProfit: pos.takeProfit, checks: signal ? signal.checks : undefined });
    this.alerts.send(`🟢 Bought ${symbol} $${pos.cost.toFixed(2)} @ ${price} (score ${pos.score}). Stop ${pos.stop.toPrecision(5)}, TP ${pos.takeProfit.toPrecision(5)}`);
  }

  closePosition(symbol, order, reason) {
    const pos = this.state.positions[symbol];
    const sold = Math.min(order.filledQty, pos.qty);
    const proceeds = sold * order.avgPrice - (order.fee || 0);
    const costPart = pos.cost * (sold / pos.qty);
    const pnl = proceeds - costPart;
    this.state.realizedPnl += pnl;
    pos.qty -= sold;
    pos.cost -= costPart;
    this.log.trade({ mode: this.broker.mode, symbol, side: 'sell', type: 'market', qty: sold, price: order.avgPrice, fee: order.fee || 0, reason, orderId: order.id });
    this.log.event('exited', { symbol, qty: sold, price: order.avgPrice, pnl: +pnl.toFixed(2), pnlPct: +((pnl / costPart) * 100).toFixed(2), reason, heldHours: +((this.now() - pos.entryTime) / HOUR).toFixed(2) });
    const pair = this.pairs[symbol];
    if (pos.qty <= (pair ? Number(pair.minOrderSize) : 0) || pos.qty <= 1e-12) {
      delete this.state.positions[symbol];
      this.state.cooldowns[symbol] = this.now() + this.cfg.risk.cooldownHours * HOUR;
    }
    this.alerts.send(`${pnl >= 0 ? '✅' : '🔴'} Sold ${symbol}: ${reason}. P&L $${pnl.toFixed(2)} (${((pnl / costPart) * 100).toFixed(1)}%). Bot total $${this.state.realizedPnl.toFixed(2)}`);
  }

  // ---------- manage open positions ----------
  async managePositions() {
    const held = Object.keys(this.state.positions);
    if (!held.length || this.state.halted) return;
    await this.broker.sync();
    const quotes = await this.broker.getQuotes(held);
    const r = this.cfg.risk;
    for (const symbol of held) {
      const q = quotes.get(symbol);
      if (!q) continue;
      this.lastQuotes.set(symbol, q);
      const pos = this.state.positions[symbol];
      const bid = q.bid;
      pos.high = Math.max(pos.high, bid);
      const pnlPct = ((bid - pos.entryPrice) / pos.entryPrice) * 100;
      const fromHighPct = ((bid - pos.high) / pos.high) * 100;
      const trailingOn = ((pos.high - pos.entryPrice) / pos.entryPrice) * 100 >= r.trailActivatePct;

      let reason = null;
      if (bid <= pos.stop) reason = `stop loss (${pnlPct.toFixed(1)}%)`;
      else if (bid >= pos.takeProfit) reason = `take profit (+${pnlPct.toFixed(1)}%)`;
      else if (trailingOn && fromHighPct <= -r.trailPct) reason = `trailing stop (${fromHighPct.toFixed(1)}% from high, ${pnlPct.toFixed(1)}% total)`;
      else if (this.now() - pos.entryTime >= r.maxHoldHours * HOUR) reason = `max hold ${r.maxHoldHours}h (${pnlPct.toFixed(1)}%)`;
      if (reason) await this.exit(symbol, reason);
    }
  }

  async exit(symbol, reason) {
    const pos = this.state.positions[symbol];
    const pair = this.pairs[symbol] || (await this.broker.getPair(symbol));
    this.pairs[symbol] = pair;
    const available = await this.broker.getHolding(symbol.split('-')[0]);
    if (available + 1e-12 < pos.qty) {
      this.log.event('holding_mismatch', { symbol, botQty: pos.qty, available }, 'warn');
    }
    const qty = floorTo(Math.min(pos.qty, available), pair.assetIncrement);
    if (Number(qty) <= 0) {
      this.log.event('exit_skipped', { symbol, reason: 'nothing available to sell' }, 'error');
      return;
    }
    const order = await this.marketOrder('sell', symbol, qty, reason);
    if (order.filledQty > 0) this.closePosition(symbol, order, reason);
    else this.log.event('exit_not_filled', { symbol, state: order.state }, 'error');
  }

  async liquidateAll(reason) {
    this.log.event('liquidate_all', { reason }, 'warn');
    for (const symbol of Object.keys(this.state.positions)) {
      try { await this.exit(symbol, reason); } catch (err) { this.log.error('liquidate_failed', err, { symbol }); }
    }
    this.state.halted = { reason, at: new Date(this.now()).toISOString() };
    await this.alerts.send(`🛑 Momentum bot halted: ${reason}`);
  }

  summary() {
    return {
      mode: this.broker.mode,
      equity: +this.equity().toFixed(2),
      cash: +this.cash().toFixed(2),
      capital: this.cfg.risk.capitalUsd,
      realizedPnl: +this.state.realizedPnl.toFixed(2),
      returnPct: +(((this.equity() - this.cfg.risk.capitalUsd) / this.cfg.risk.capitalUsd) * 100).toFixed(2),
      openPositions: Object.values(this.state.positions).map((p) => {
        const q = this.lastQuotes.get(p.symbol);
        return { symbol: p.symbol, qty: p.qty, entry: p.entryPrice, bid: q ? q.bid : null, pnlPct: q ? +(((q.bid - p.entryPrice) / p.entryPrice) * 100).toFixed(2) : null };
      }),
      trades: this.state.tradeCount,
      halted: this.state.halted,
      entriesBlockedToday: this.state.day ? this.state.day.entriesBlocked : false,
    };
  }
}

module.exports = { MomentumEngine };
