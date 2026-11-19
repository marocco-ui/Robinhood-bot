// Builds the right broker from env settings.
//   TRADING_MODE=paper (default) -> PaperBroker using live Robinhood quotes
//                                   (or Coinbase public quotes if no Robinhood keys yet)
//   TRADING_MODE=live            -> RobinhoodBroker, real orders
const { RobinhoodClient } = require('./robinhood');
const { RobinhoodBroker, PaperBroker } = require('./brokers');

// Fallback price feed for paper trading before you've made Robinhood API keys.
// Prices won't exactly match Robinhood's (Robinhood quotes include its spread).
class CoinbasePublicPrices {
  async getQuotes(symbols) {
    const out = new Map();
    for (const symbol of symbols) {
      try {
        const res = await fetch(`https://api.exchange.coinbase.com/products/${symbol}/ticker`, {
          headers: { 'User-Agent': 'bots' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const t = await res.json();
        const bid = Number(t.bid);
        const ask = Number(t.ask);
        if (bid > 0 && ask > 0) out.set(symbol, { symbol, bid, ask, mid: (bid + ask) / 2, ts: Date.now() });
      } catch {
        // Missing symbols are simply skipped.
      }
    }
    return out;
  }
}

function hasRobinhoodKeys() {
  return Boolean(process.env.RH_API_KEY && process.env.RH_PRIVATE_KEY);
}

function createBroker({ mode, perMinute = 40, startingCash = 1000, feeBps = 0, log }) {
  if (mode === 'live') {
    if (!hasRobinhoodKeys()) throw new Error('TRADING_MODE=live needs RH_API_KEY and RH_PRIVATE_KEY');
    const client = new RobinhoodClient({ apiKey: process.env.RH_API_KEY, privateKeyBase64: process.env.RH_PRIVATE_KEY, perMinute, baseUrl: process.env.RH_BASE_URL || undefined });
    return new RobinhoodBroker(client);
  }
  if (mode !== 'paper') throw new Error(`TRADING_MODE must be "paper" or "live", got "${mode}"`);

  let priceSource;
  if (hasRobinhoodKeys()) {
    const client = new RobinhoodClient({ apiKey: process.env.RH_API_KEY, privateKeyBase64: process.env.RH_PRIVATE_KEY, perMinute, baseUrl: process.env.RH_BASE_URL || undefined });
    priceSource = new RobinhoodBroker(client);
  } else {
    if (log) log.event('price_source', { source: 'coinbase-public', note: 'No Robinhood keys; paper prices come from Coinbase' }, 'warn');
    priceSource = new CoinbasePublicPrices();
  }
  return new PaperBroker({ priceSource, startingCash, feeBps });
}

module.exports = { createBroker, hasRobinhoodKeys, CoinbasePublicPrices };
