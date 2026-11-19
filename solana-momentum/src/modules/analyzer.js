// Entry rules. Every check is reported, so the logs show exactly why a token did or didn't
// qualify. The old breakout check was called with no price history and could never pass.

class PriceHistory {
  constructor({ maxAgeMs = 6 * 3600000 } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.series = {};
  }

  add(symbol, price, t) {
    const s = (this.series[symbol] = this.series[symbol] || []);
    s.push([t, price]);
    const cutoff = t - this.maxAgeMs;
    while (s.length && s[0][0] < cutoff) s.shift();
  }

  // Highest price between (now - lookback) and (now - excludeRecentMs), plus how much of the
  // lookback window we actually have data for.
  resistance(symbol, now, lookbackMs, excludeRecentMs = 120000) {
    const s = this.series[symbol] || [];
    const from = now - lookbackMs;
    const to = now - excludeRecentMs;
    let max = null;
    let earliest = null;
    for (const [t, p] of s) {
      if (t < from || t > to) continue;
      if (earliest === null) earliest = t;
      if (max === null || p > max) max = p;
    }
    const coverage = earliest === null ? 0 : (to - earliest) / (to - from);
    return { max, coverage };
  }

  toJSON() { return this.series; }
  restore(series) { this.series = series || {}; }
}

function evaluate({ symbol, metrics: m, quote, history, now, cfg }) {
  const s = cfg.signal;
  const checks = {};
  const fail = [];
  const check = (name, pass, value) => {
    checks[name] = { pass, value };
    if (!pass) fail.push(name);
  };

  const spreadPct = ((quote.ask - quote.bid) / quote.mid) * 100;
  check('spread', spreadPct <= s.maxSpreadPct, +spreadPct.toFixed(2));

  if (!m || !m.ok) {
    check('dexData', false, m ? m.reason : 'missing');
    return { symbol, pass: false, score: 0, fail, checks };
  }
  check('symbolMatch', m.symbolMatches, m.dexSymbol);
  const gap = m.priceUsd ? (Math.abs(m.priceUsd - quote.mid) / quote.mid) * 100 : null;
  check('priceAgrees', gap !== null && gap <= s.maxPriceGapPct, gap === null ? null : +gap.toFixed(2));
  check('liquidity', m.liquidityUsd >= s.minLiquidityUsd, Math.round(m.liquidityUsd));
  check('volumeAccel', m.volumeAccel !== null && m.volumeAccel >= s.minVolumeAccel, m.volumeAccel === null ? null : +m.volumeAccel.toFixed(2));
  check('change1h', m.priceChange1h !== null && m.priceChange1h >= s.minPriceChange1hPct && m.priceChange1h <= s.maxPriceChange1hPct, m.priceChange1h);
  check('buyRatio', m.buyRatio1h !== null && m.buyRatio1h >= s.minBuyRatio, m.buyRatio1h === null ? null : +m.buyRatio1h.toFixed(3));

  const { max, coverage } = history.resistance(symbol, now, s.breakoutLookbackMin * 60000);
  check('history', coverage >= 0.8, +coverage.toFixed(2));
  const breakoutLevel = max === null ? null : max * (1 + s.breakoutBufferPct / 100);
  check('breakout', breakoutLevel !== null && quote.mid > breakoutLevel, breakoutLevel === null ? null : +breakoutLevel.toPrecision(6));

  // Score 0-100 for ranking candidates that pass every gate.
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const score = Math.round(100 * (
    0.35 * clamp(((m.volumeAccel || 0) - 1) / 2) +
    0.25 * clamp(((m.buyRatio1h || 0) - 0.5) / 0.2) +
    0.20 * clamp((m.priceChange1h || 0) / 8) +
    0.10 * clamp(Math.log10(Math.max(m.liquidityUsd, 1) / 1e6) / 2) +
    0.10 * clamp(1 - spreadPct / s.maxSpreadPct)
  ));
  check('score', score >= s.minScore, score);

  return { symbol, pass: fail.length === 0, score, fail, checks };
}

module.exports = { evaluate, PriceHistory };
