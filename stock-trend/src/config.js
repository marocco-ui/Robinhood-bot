const { envNum, envBool } = require('../../shared/env');

function loadConfig() {
  const mode = (process.env.STOCK_MODE || 'paper').toLowerCase();
  const cfg = {
    mode,
    risk: (process.env.STOCK_RISK_SYMBOL || 'SPY').toUpperCase(),
    safe: (process.env.STOCK_SAFE_SYMBOL || 'SHY').toUpperCase(),
    smaMonths: envNum('STOCK_SMA_MONTHS', 10),
    capitalUsd: envNum('STOCK_CAPITAL_USD', 1000),     // most the bot will ever have invested
    maxOrderUsd: envNum('STOCK_MAX_ORDER_USD', envNum('STOCK_CAPITAL_USD', 1000)),
    minOrderUsd: envNum('STOCK_MIN_ORDER_USD', 1),
    cashReserveUsd: envNum('STOCK_CASH_RESERVE_USD', 1), // left uninvested so rounding never overdraws
    paperCashUsd: envNum('STOCK_PAPER_CASH_USD', 1000),
    pollMinutes: envNum('STOCK_POLL_MINUTES', 15),
    accountNumber: process.env.STOCK_ACCOUNT_NUMBER || '',
    ignoreHours: envBool('STOCK_IGNORE_HOURS', false),   // tests only
  };
  const errs = [];
  if (!['paper', 'live'].includes(mode)) errs.push('STOCK_MODE must be paper or live');
  if (mode === 'live' && process.env.STOCK_CONFIRM_LIVE !== 'yes') errs.push('Live mode trades real money. Set STOCK_CONFIRM_LIVE=yes to allow it.');
  if (cfg.risk === cfg.safe) errs.push('Risk and safe symbols must differ');
  if (!(cfg.smaMonths >= 3 && cfg.smaMonths <= 24)) errs.push('STOCK_SMA_MONTHS must be 3 to 24');
  if (!(cfg.capitalUsd > 0)) errs.push('STOCK_CAPITAL_USD must be above 0');
  if (!(cfg.maxOrderUsd > 0)) errs.push('STOCK_MAX_ORDER_USD must be above 0');
  if (!(cfg.pollMinutes >= 1)) errs.push('STOCK_POLL_MINUTES must be at least 1');
  if (errs.length) throw new Error(`Config problems:\n  ${errs.join('\n  ')}`);
  return cfg;
}

module.exports = { loadConfig };
