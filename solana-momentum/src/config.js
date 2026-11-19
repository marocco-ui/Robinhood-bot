// Solana momentum bot settings. Override any of these in solana-momentum/.env
const { envNum } = require('../../shared/env');

function list(name, fallback) {
  const v = process.env[name];
  return (v === undefined ? fallback : v).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function loadConfig() {
  const cfg = {
    mode: (process.env.TRADING_MODE || 'paper').toLowerCase(),

    // Universe. SOL is excluded by default because the grid bot trades it.
    exclude: list('MOMENTUM_EXCLUDE', 'SOL'),

    risk: {
      capitalUsd: envNum('MOMENTUM_CAPITAL_USD', 300),        // money this bot may use
      maxPositionUsd: envNum('MOMENTUM_MAX_POSITION_USD', 50),
      positionPct: envNum('MOMENTUM_POSITION_PCT', 15),        // % of bot equity per trade (capped above)
      maxPositions: envNum('MOMENTUM_MAX_POSITIONS', 3),
      stopLossPct: envNum('MOMENTUM_STOP_LOSS_PCT', -12),
      takeProfitPct: envNum('MOMENTUM_TAKE_PROFIT_PCT', 30),
      trailActivatePct: envNum('MOMENTUM_TRAIL_ACTIVATE_PCT', 12), // start trailing once up this much
      trailPct: envNum('MOMENTUM_TRAIL_PCT', 8),                   // exit after this drop from the high
      maxHoldHours: envNum('MOMENTUM_MAX_HOLD_HOURS', 48),
      cooldownHours: envNum('MOMENTUM_COOLDOWN_HOURS', 6),        // no re-entry right after an exit
      dailyLossPct: envNum('MOMENTUM_DAILY_LOSS_PCT', -8),        // stop opening trades for the day
      portfolioStopPct: envNum('MOMENTUM_PORTFOLIO_STOP_PCT', -30), // liquidate + halt
    },

    signal: {
      minLiquidityUsd: envNum('MOMENTUM_MIN_LIQUIDITY_USD', 1000000),
      minVolumeAccel: envNum('MOMENTUM_MIN_VOLUME_ACCEL', 1.5),   // last-hour volume vs 6h hourly average
      minPriceChange1hPct: envNum('MOMENTUM_MIN_CHANGE_1H_PCT', 1),
      maxPriceChange1hPct: envNum('MOMENTUM_MAX_CHANGE_1H_PCT', 15), // don't chase vertical candles
      minBuyRatio: envNum('MOMENTUM_MIN_BUY_RATIO', 0.55),
      breakoutLookbackMin: envNum('MOMENTUM_BREAKOUT_LOOKBACK_MIN', 60),
      breakoutBufferPct: envNum('MOMENTUM_BREAKOUT_BUFFER_PCT', 0.3),
      maxSpreadPct: envNum('MOMENTUM_MAX_SPREAD_PCT', 3),
      maxPriceGapPct: envNum('MOMENTUM_MAX_PRICE_GAP_PCT', 5),    // DexScreener vs Robinhood sanity check
      minScore: envNum('MOMENTUM_MIN_SCORE', 45),
    },

    scanMs: envNum('MOMENTUM_SCAN_MS', 60000),
    positionMs: envNum('MOMENTUM_POSITION_MS', 15000),
    heartbeatMs: envNum('MOMENTUM_HEARTBEAT_MS', 3600000),
    apiPerMinute: envNum('RH_REQUESTS_PER_MINUTE', 40),
    paperFeeBps: envNum('PAPER_FEE_BPS', 0),
  };
  validate(cfg);
  return cfg;
}

function validate(cfg) {
  if (!['paper', 'live'].includes(cfg.mode)) throw new Error('TRADING_MODE must be paper or live');
  const r = cfg.risk;
  if (!(r.stopLossPct < 0)) throw new Error('MOMENTUM_STOP_LOSS_PCT must be negative');
  if (!(r.takeProfitPct > 0)) throw new Error('MOMENTUM_TAKE_PROFIT_PCT must be positive');
  if (!(r.capitalUsd >= r.maxPositionUsd)) throw new Error('MOMENTUM_CAPITAL_USD must be >= MOMENTUM_MAX_POSITION_USD');
  if (!(r.portfolioStopPct < 0)) throw new Error('MOMENTUM_PORTFOLIO_STOP_PCT must be negative');
}

module.exports = { loadConfig, validate };
