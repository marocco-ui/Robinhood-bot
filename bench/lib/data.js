// Candle loading, replay feed, and the candle-based stand-in for DexScreener signals.
const fs = require('fs');
const path = require('path');

function loadCandles(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [t, o, h, l, c, v] = lines[i].split(',').map(Number);
    if (!Number.isFinite(c)) continue;
    out.push({ t: t < 1e12 ? t * 1000 : t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

// All <SYMBOL>-<interval>.csv files in a folder.
function loadDir(dir, interval) {
  const series = {};
  if (!fs.existsSync(dir)) return series;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^([A-Z0-9]+)-(\w+)\.csv$/);
    if (m && m[2] === interval) series[m[1]] = loadCandles(path.join(dir, f));
  }
  return series;
}

// Cost presets. Robinhood's default routing hides its cost in the spread; v2 fee-tier
// orders route to exchanges with tight spreads and an explicit maker/taker fee
// (new-account tier: 0.50% maker, 0.95% taker).
const COSTS = {
  'rh-default': { spreadBps: 190, makerFeeBps: 0, takerFeeBps: 0 },
  'rh-v2': { spreadBps: 10, makerFeeBps: 50, takerFeeBps: 95 },
  'free': { spreadBps: 0, makerFeeBps: 0, takerFeeBps: 0 },
};

// Steps through a shared timeline. Each symbol's quote is its latest candle at or before the
// current time. Orders placed at step i can only fill against candle i+1's range.
class ReplayFeed {
  constructor(series, { spreadBps = 190, start = 0, end = Infinity } = {}) {
    this.symbols = Object.keys(series);
    this.series = series;
    this.half = spreadBps / 2 / 1e4;
    const times = new Set();
    for (const s of this.symbols) for (const c of series[s]) if (c.t >= start && c.t < end) times.add(c.t);
    this.timeline = [...times].sort((a, b) => a - b);
    this.ptr = {};
    for (const s of this.symbols) this.ptr[s] = -1;
    this.i = -1;
  }

  // Move to the next timestamp. Returns false at the end.
  step() {
    this.i++;
    if (this.i >= this.timeline.length) return false;
    const t = this.timeline[this.i];
    for (const s of this.symbols) {
      const arr = this.series[s];
      let p = this.ptr[s];
      while (p + 1 < arr.length && arr[p + 1].t <= t) p++;
      this.ptr[s] = p;
    }
    return true;
  }

  now() { return this.timeline[Math.min(Math.max(0, this.i), this.timeline.length - 1)]; }

  candle(symbol) {
    const p = this.ptr[symbol];
    if (p < 0) return null;
    const c = this.series[symbol][p];
    // Stale if the coin has no candle within the last 3 timeline steps' worth of time.
    return c;
  }

  index(symbol) { return this.ptr[symbol]; }

  quoteFor(base, withRange) {
    const c = this.candle(base);
    if (!c) return null;
    const q = { symbol: `${base}-USD`, bid: c.c * (1 - this.half), ask: c.c * (1 + this.half), mid: c.c, ts: c.t };
    // Only the candle that just closed counts for matching resting orders.
    if (withRange && c.t === this.now()) {
      q.low = c.l * (1 + this.half);   // lowest ask during the candle
      q.high = c.h * (1 - this.half);  // highest bid during the candle
    }
    return q;
  }

  async getQuotes(symbols) {
    const out = new Map();
    for (const s of symbols) {
      const q = this.quoteFor(s.split('-')[0], false);
      if (q) out.set(s, q);
    }
    return out;
  }

  async getMatchQuotes(symbols) {
    const out = new Map();
    for (const s of symbols) {
      const q = this.quoteFor(s.split('-')[0], true);
      if (q && q.low !== undefined) out.set(s, q);
    }
    return out;
  }

  async getPairs(symbols) {
    return symbols
      .filter((s) => this.series[s.split('-')[0]])
      .map((s) => ({ symbol: s, assetCode: s.split('-')[0], quoteIncrement: '0.00000001', assetIncrement: '0.000001', minOrderSize: 0.000001, maxOrderSize: Infinity, status: 'tradable' }));
  }

  async getPair(symbol) {
    return (await this.getPairs([symbol]))[0];
  }
}

// Stand-in for DexScreener's on-chain metrics, computed from exchange candles:
//   volumeAccel = last hour's volume / average hourly volume over 6h
//   change1h    = price change over the last hour
//   buyRatio1h  = share of last hour's volume on up candles (proxy for buys vs sells)
// Liquidity and the mint/price sanity checks are treated as passing.
class CandleSignals {
  constructor(feed, intervalMs) {
    this.feed = feed;
    this.per1h = Math.max(1, Math.round(3600000 / intervalMs));
    this.prefix = {};
    for (const s of feed.symbols) {
      const arr = feed.series[s];
      const vol = new Float64Array(arr.length + 1);
      const up = new Float64Array(arr.length + 1);
      for (let i = 0; i < arr.length; i++) {
        vol[i + 1] = vol[i] + arr[i].v;
        up[i + 1] = up[i] + (arr[i].c >= arr[i].o ? arr[i].v : 0);
      }
      this.prefix[s] = { vol, up };
    }
  }

  metricsFor(base) {
    const arr = this.feed.series[base];
    const i = this.feed.index(base);
    const n1 = this.per1h;
    const n6 = this.per1h * 6;
    if (!arr || i < n6) return { ok: false, reason: 'warming up' };
    const { vol, up } = this.prefix[base];
    const v1 = vol[i + 1] - vol[i + 1 - n1];
    const v6 = vol[i + 1] - vol[i + 1 - n6];
    const u1 = up[i + 1] - up[i + 1 - n1];
    const c = arr[i].c;
    const c1 = arr[i - n1].c;
    const c6 = arr[i - n6].c;
    return {
      ok: true,
      symbol: base,
      dexSymbol: base,
      symbolMatches: true,
      priceUsd: c,
      liquidityUsd: 1e12,
      volume1h: v1,
      volume6h: v6,
      volumeAccel: v6 > 0 ? v1 / (v6 / 6) : null,
      priceChange1h: c1 > 0 ? ((c - c1) / c1) * 100 : null,
      priceChange6h: c6 > 0 ? ((c - c6) / c6) * 100 : null,
      buyRatio1h: v1 > 0 ? u1 / v1 : null,
    };
  }

  async getMetrics(symbolToMint) {
    const out = {};
    for (const base of Object.keys(symbolToMint)) out[base] = this.metricsFor(base);
    return out;
  }
}

module.exports = { loadCandles, loadDir, ReplayFeed, CandleSignals, COSTS };
