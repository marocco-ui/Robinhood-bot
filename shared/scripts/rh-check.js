#!/usr/bin/env node
// Read-only connection test: account, buying power, SOL quote, trading pairs.
//   node shared/scripts/rh-check.js
const path = require('path');
const { loadEnvFile } = require('../env');
const { RobinhoodClient } = require('../robinhood');

loadEnvFile(path.join(__dirname, '..', '..', '.env.robinhood'));

(async () => {
  const client = new RobinhoodClient({ apiKey: process.env.RH_API_KEY, privateKeyBase64: process.env.RH_PRIVATE_KEY });
  const acct = await client.getAccount();
  console.log('Account:', acct.account_number, '| status:', acct.status, '| buying power:', acct.buying_power, acct.buying_power_currency);
  const [q] = await client.getBestBidAsk(['SOL-USD']);
  console.log('SOL-USD bid/ask:', q.bid_inclusive_of_sell_spread, '/', q.ask_inclusive_of_buy_spread);
  const pairs = await client.getTradingPairs();
  const tradable = pairs.filter((p) => p.status === 'tradable').map((p) => p.symbol);
  console.log(`Tradable pairs (${tradable.length}):`, tradable.join(' '));
})().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
