// Runs the REAL bot engines (sol-grid/src/grid.js and solana-momentum/src/momentum.js)
// over historical candles, with PaperBroker filling orders against the replayed prices.
const { GridEngine } = require('../../sol-grid/src/grid');
const { validate: validateGrid } = require('../../sol-grid/src/config');
const { MomentumEngine } = require('../../solana-momentum/src/momentum');
const { validate: validateMomentum } = require('../../solana-momentum/src/config');
const { PaperBroker } = require('../../shared/brokers');
const { ReplayFeed, CandleSignals, COSTS } = require('./data');

const DAY = 86400000;

// Captures fills and exits, stamped with the replay clock (not wall time).
function recorder(clock) {
  const trades = [];
  const exits = [];
  return {
    trades,
    exits,
    log: {
      event(type, data) { if (type === 'exited') exits.push({ t: clock(), ...data }); },
      error() {},
      trade(tr) { trades.push({ t: clock(), symbol: tr.symbol, side: tr.side, type: tr.type, qty: tr.qty, price: tr.price, fee: tr.fee || 0, reason: tr.reason }); },
    },
  };
}

// Tracks drawdown and daily returns on EVERY step, independent of how sparsely the
// equity curve is sampled for charts.
class Tracker {
  constructor(startValue) {
    this.start = startValue;
    this.peak = startValue;
    this.maxDd = 0;
    this.daily = [];
    this.lastDay = null;
    this.dayStartVal = startValue;
    this.first = null;
    this.lastT = null;
    this.last = startValue;
  }
  update(t, v) {
    if (this.first === null) this.first = t;
    this.peak = Math.max(this.peak, v);
    this.maxDd = Math.max(this.maxDd, (this.peak - v) / this.peak);
    const d = Math.floor(t / DAY);
    if (this.lastDay !== null && d !== this.lastDay) { this.daily.push(this.last / this.dayStartVal - 1); this.dayStartVal = this.last; }
    this.lastDay = d;
    this.lastT = t;
    this.last = v;
  }
  stats(extra = {}) {
    const daily = this.daily;
    const mean = daily.reduce((a, b) => a + b, 0) / (daily.length || 1);
    const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (daily.length || 1));
    return {
      returnPct: +(((this.last - this.start) / this.start) * 100).toFixed(2),
      maxDrawdownPct: +(this.maxDd * 100).toFixed(2),
      sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(365)).toFixed(2) : 0,
      endValue: +this.last.toFixed(2),
      days: this.first === null ? 0 : +((this.lastT - this.first) / DAY).toFixed(1),
      ...extra,
    };
  }
}

function costOf(name) {
  const c = COSTS[name];
  if (!c) throw new Error(`Unknown cost model ${name}. Use: ${Object.keys(COSTS).join(', ')}`);
  return c;
}

// ---------------- grid ----------------
// params: { downPct, upPct, count, maxOpenBuys, stopLossPct, orderUsd, maxCapitalUsd }
// The range is set relative to the price at the start of the window, like you'd do live.
async function simulateGrid(candles, params, { cost = 'rh-default', start = 0, end = Infinity, capital = 1000, sampleEvery = 1 } = {}) {
  const c = costOf(cost);
  const feed = new ReplayFeed({ SOL: candles }, { spreadBps: c.spreadBps, start, end });
  if (!feed.step()) throw new Error('no candles in window');
  const startPrice = feed.candle('SOL').c;
  const cfg = {
    mode: 'paper',
    symbol: 'SOL-USD',
    lower: +(startPrice * (1 - params.downPct / 100)).toFixed(2),
    upper: +(startPrice * (1 + params.upPct / 100)).toFixed(2),
    gridCount: params.count,
    spacing: 'geometric',
    orderUsd: params.orderUsd ?? capital / params.count,
    maxCapitalUsd: params.maxCapitalUsd ?? capital,
    maxOpenBuys: params.maxOpenBuys ?? 4,
    stopLossPct: params.stopLossPct ?? 10,
    minSpacingPct: params.minSpacingPct ?? 0,
    cancelOnExit: false,
    statusEveryTicks: 1e12,
  };
  validateGrid(cfg);
  const rec = recorder(() => feed.now());
  const broker = new PaperBroker({ priceSource: feed, startingCash: capital, makerFeeBps: c.makerFeeBps, takerFeeBps: c.takerFeeBps });
  const engine = new GridEngine({ cfg, broker, log: rec.log, now: () => feed.now() });
  await engine.init();

  const curve = [];
  const priceCurve = [];
  const tracker = new Tracker(capital);
  let n = 0;
  do {
    await engine.tick();
    const price = feed.candle('SOL').c;
    const equity = broker.cash + (broker.holdings.SOL || 0) * price;
    tracker.update(feed.now(), equity);
    if (n++ % sampleEvery === 0) {
      curve.push([feed.now(), equity]);
      priceCurve.push([feed.now(), price]);
    }
    if (engine.state.halted) break;
  } while (feed.step());

  // After a stop-loss halt the bot sits in cash; carry equity to the end of the window.
  while (feed.step()) {
    const price = feed.candle('SOL').c;
    const equity = broker.cash + (broker.holdings.SOL || 0) * price;
    tracker.update(feed.now(), equity);
    if (n++ % sampleEvery === 0) { curve.push([feed.now(), equity]); priceCurve.push([feed.now(), price]); }
  }
  curve.push([feed.now(), tracker.last]);
  priceCurve.push([feed.now(), feed.candle('SOL').c]);
  const fees = [...broker.orders.values()].reduce((s, o) => s + (o.fee || 0), 0);
  return {
    bot: 'grid',
    params,
    cfg: { lower: cfg.lower, upper: cfg.upper, count: cfg.gridCount, stepPct: +cfg.stepPct.toFixed(2), orderUsd: +cfg.orderUsd.toFixed(2) },
    levels: engine.levels,
    stats: tracker.stats({
      roundTrips: engine.state.roundTrips,
      trades: rec.trades.length,
      realizedPnl: +engine.state.realizedPnl.toFixed(2),
      feesPaid: +fees.toFixed(2),
      halted: engine.state.halted ? engine.state.halted.reason : null,
      holdReturnPct: +(((feed.candle('SOL').c - startPrice) / startPrice) * 100).toFixed(2),
    }),
    curve,
    priceCurve,
    fills: rec.trades,
  };
}

// ---------------- momentum ----------------
function momentumCfg(p, capital) {
  const cfg = {
    mode: 'paper',
    exclude: p.exclude || ['SOL'],
    risk: {
      capitalUsd: capital,
      maxPositionUsd: p.maxPositionUsd ?? capital / 6,
      positionPct: p.positionPct ?? 15,
      maxPositions: p.maxPositions ?? 3,
      stopLossPct: p.stopLossPct ?? -12,
      takeProfitPct: p.takeProfitPct ?? 30,
      trailActivatePct: p.trailActivatePct ?? 12,
      trailPct: p.trailPct ?? 8,
      maxHoldHours: p.maxHoldHours ?? 48,
      cooldownHours: p.cooldownHours ?? 6,
      dailyLossPct: p.dailyLossPct ?? -8,
      portfolioStopPct: p.portfolioStopPct ?? -30,
    },
    signal: {
      minLiquidityUsd: 0,
      minVolumeAccel: p.minVolumeAccel ?? 1.5,
      minPriceChange1hPct: p.minChange1h ?? 1,
      maxPriceChange1hPct: p.maxChange1h ?? 15,
      minBuyRatio: p.minBuyRatio ?? 0.55,
      breakoutLookbackMin: p.breakoutLookbackMin ?? 60,
      breakoutBufferPct: p.breakoutBufferPct ?? 0.3,
      maxSpreadPct: 100, // spread is fixed by the cost model in the bench
      maxPriceGapPct: 100,
      minScore: p.minScore ?? 45,
    },
  };
  validateMomentum(cfg);
  return cfg;
}

async function simulateMomentum(seriesBySymbol, params, { cost = 'rh-default', start = 0, end = Infinity, capital = 1000, intervalMs = 300000, sampleEvery = 12 } = {}) {
  const c = costOf(cost);
  const cfg = momentumCfg(params, capital);
  const series = {};
  for (const [s, arr] of Object.entries(seriesBySymbol)) if (!cfg.exclude.includes(s)) series[s] = arr;
  const feed = new ReplayFeed(series, { spreadBps: c.spreadBps, start, end });
  const signals = new CandleSignals(feed, intervalMs);
  const rec = recorder(() => feed.now());
  const broker = new PaperBroker({ priceSource: feed, startingCash: capital, makerFeeBps: c.makerFeeBps, takerFeeBps: c.takerFeeBps });
  const engine = new MomentumEngine({ cfg, broker, dex: signals, log: rec.log, now: () => feed.now(), sleep: async () => {} });

  const curve = [];
  const tracker = new Tracker(capital);
  const firstPrices = {};
  let n = 0;
  while (feed.step()) {
    for (const s of feed.symbols) if (firstPrices[s] === undefined && feed.candle(s)) firstPrices[s] = feed.candle(s).c;
    await engine.managePositions();
    await engine.scan();
    const eq = engine.equity();
    tracker.update(feed.now(), eq);
    if (n++ % sampleEvery === 0) curve.push([feed.now(), eq]);
    if (engine.state.halted) break;
  }
  while (feed.step()) { // halted: flat to the end
    const eq = engine.equity();
    tracker.update(feed.now(), eq);
    if (n++ % sampleEvery === 0) curve.push([feed.now(), eq]);
  }
  curve.push([feed.now(), tracker.last]);

  // Benchmark: equal-weight buy and hold of every coin in the window.
  const holds = Object.keys(firstPrices).map((s) => feed.candle(s).c / firstPrices[s] - 1);
  const holdReturnPct = holds.length ? (holds.reduce((a, b) => a + b, 0) / holds.length) * 100 : 0;
  const pnls = rec.exits.map((e) => e.pnlPct);
  const wins = pnls.filter((x) => x > 0);
  const bySymbol = {};
  for (const e of rec.exits) bySymbol[e.symbol] = +((bySymbol[e.symbol] || 0) + e.pnl).toFixed(2);
  return {
    bot: 'momentum',
    params,
    symbols: Object.keys(series),
    stats: tracker.stats({
      trades: rec.exits.length,
      winRatePct: pnls.length ? +((wins.length / pnls.length) * 100).toFixed(1) : 0,
      avgTradePct: pnls.length ? +(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2) : 0,
      bestTradePct: pnls.length ? Math.max(...pnls) : 0,
      worstTradePct: pnls.length ? Math.min(...pnls) : 0,
      realizedPnl: +engine.state.realizedPnl.toFixed(2),
      halted: engine.state.halted ? engine.state.halted.reason : null,
      holdReturnPct: +holdReturnPct.toFixed(2),
    }),
    bySymbol,
    curve,
    exits: rec.exits,
    fills: rec.trades,
  };
}

module.exports = { simulateGrid, simulateMomentum, momentumCfg, Tracker };
