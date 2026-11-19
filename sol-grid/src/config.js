// SOL grid bot settings. Override any of these in sol-grid/.env
const { envNum, envBool } = require('../../shared/env');

function loadConfig() {
  const cfg = {
    mode: (process.env.TRADING_MODE || 'paper').toLowerCase(),
    symbol: process.env.GRID_SYMBOL || 'SOL-USD',

    // Price range and grid shape.
    lower: envNum('GRID_LOWER', 60),
    upper: envNum('GRID_UPPER', 95),
    gridCount: envNum('GRID_COUNT', 8),             // number of buy/sell slots
    spacing: process.env.GRID_SPACING || 'geometric', // geometric = equal % steps

    // Money.
    orderUsd: envNum('GRID_ORDER_USD', 25),          // USD per slot
    maxCapitalUsd: envNum('GRID_MAX_CAPITAL_USD', 150), // cap on open buys + inventory cost
    maxOpenBuys: envNum('GRID_MAX_OPEN_BUYS', 4),    // nearest N slots below price get buy orders
    paperStartingCash: envNum('PAPER_STARTING_CASH', 500),
    paperFeeBps: envNum('PAPER_FEE_BPS', 0),         // Robinhood quotes already include its spread

    // Trend filter: pause buys while price is below its N-hour moving average. 0 = off.
    trendMaHours: envNum('GRID_TREND_MA_HOURS', 0),
    trendBufferPct: envNum('GRID_TREND_BUFFER_PCT', 0),

    // Safety.
    stopLossPct: envNum('GRID_STOP_LOSS_PCT', 10),   // sell everything if price drops this far below GRID_LOWER (0 = off)
    cancelOnExit: envBool('GRID_CANCEL_ON_EXIT', true),
    // Robinhood's SOL spread was ~1.9% when this was written; each buy+sell pays about one spread.
    minSpacingPct: envNum('GRID_MIN_SPACING_PCT', 3.0), // refuse grids tighter than this

    // Loop.
    tickMs: envNum('GRID_TICK_MS', 20000),
    apiPerMinute: envNum('RH_REQUESTS_PER_MINUTE', 40),
    statusEveryTicks: envNum('GRID_STATUS_EVERY_TICKS', 15),
  };
  validate(cfg);
  return cfg;
}

function validate(cfg) {
  if (!['paper', 'live'].includes(cfg.mode)) throw new Error('TRADING_MODE must be paper or live');
  if (!(cfg.lower > 0 && cfg.upper > cfg.lower)) throw new Error('Need 0 < GRID_LOWER < GRID_UPPER');
  if (!(cfg.gridCount >= 2 && cfg.gridCount <= 60)) throw new Error('GRID_COUNT must be 2..60');
  if (!['geometric', 'arithmetic'].includes(cfg.spacing)) throw new Error('GRID_SPACING must be geometric or arithmetic');
  if (cfg.trendMaHours && !(cfg.trendMaHours >= 6 && cfg.trendMaHours <= 2000)) throw new Error('GRID_TREND_MA_HOURS must be 0 or 6..2000');
  if (!(cfg.orderUsd > 0)) throw new Error('GRID_ORDER_USD must be > 0');
  if (cfg.maxCapitalUsd < cfg.orderUsd) throw new Error('GRID_MAX_CAPITAL_USD must be at least GRID_ORDER_USD');
  const stepPct = cfg.spacing === 'geometric'
    ? (Math.pow(cfg.upper / cfg.lower, 1 / cfg.gridCount) - 1) * 100
    : ((cfg.upper - cfg.lower) / cfg.gridCount / cfg.lower) * 100;
  cfg.stepPct = stepPct;
  if (stepPct < cfg.minSpacingPct) {
    throw new Error(
      `Grid step is ${stepPct.toFixed(2)}%, below GRID_MIN_SPACING_PCT=${cfg.minSpacingPct}%. ` +
      'Each round trip must clear Robinhood\'s spread. Use fewer slots or a wider range.'
    );
  }
}

module.exports = { loadConfig, validate };
