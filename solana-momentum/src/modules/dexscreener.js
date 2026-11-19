// DexScreener on-chain data, fetched in batches (up to 30 mints per request) to stay
// well under the rate limit. The old version fetched one token at a time and also read
// `volume.h4` / `priceChange.h4`, which DexScreener doesn't provide (it has m5, h1, h6, h24),
// so every token scored as -100% volume and nothing could ever pass.
const BASE = 'https://api.dexscreener.com';

class DexScreenerClient {
  constructor({ timeoutMs = 10000 } = {}) {
    this.timeoutMs = timeoutMs;
  }

  async getPairsForMints(mints) {
    const all = [];
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const data = await this.get(`/tokens/v1/solana/${chunk.join(',')}`);
      if (Array.isArray(data)) all.push(...data);
    }
    return all;
  }

  async get(path, attempt = 0) {
    const res = await fetch(BASE + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      return this.get(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`DexScreener ${res.status} on ${path.slice(0, 60)}`);
    return res.json();
  }

  // For each mint, the deepest pool where the token is the BASE token.
  async getMetrics(symbolToMint) {
    const mints = Object.values(symbolToMint);
    const pairs = await this.getPairsForMints(mints);
    const out = {};
    for (const [symbol, mint] of Object.entries(symbolToMint)) {
      const mine = pairs.filter((p) => p.baseToken && p.baseToken.address === mint);
      if (!mine.length) {
        out[symbol] = { ok: false, reason: 'no pools' };
        continue;
      }
      const main = mine.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a));
      out[symbol] = metricsFromPair(symbol, main);
    }
    return out;
  }
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function metricsFromPair(symbol, p) {
  const v1 = n(p.volume?.h1);
  const v6 = n(p.volume?.h6);
  const buys = n(p.txns?.h1?.buys);
  const sells = n(p.txns?.h1?.sells);
  const dexSymbol = (p.baseToken.symbol || '').toUpperCase();
  return {
    ok: true,
    symbol,
    dexSymbol,
    symbolMatches: dexSymbol === symbol || dexSymbol === `$${symbol}`,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    priceUsd: n(p.priceUsd),
    liquidityUsd: n(p.liquidity?.usd) || 0,
    volume1h: v1,
    volume6h: v6,
    volume24h: n(p.volume?.h24),
    // Last hour's volume vs the average hour over the last 6h (1.0 = normal, 2.0 = double).
    volumeAccel: v1 !== null && v6 > 0 ? v1 / (v6 / 6) : null,
    priceChange5m: n(p.priceChange?.m5),
    priceChange1h: n(p.priceChange?.h1),
    priceChange6h: n(p.priceChange?.h6),
    buyRatio1h: buys !== null && sells !== null && buys + sells > 0 ? buys / (buys + sells) : null,
    txns1h: buys !== null && sells !== null ? buys + sells : null,
  };
}

module.exports = { DexScreenerClient, metricsFromPair };
