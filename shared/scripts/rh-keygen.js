#!/usr/bin/env node
// Generates the Ed25519 key pair for the Robinhood Crypto Trading API.
//   1. Run: node shared/scripts/rh-keygen.js
//   2. Paste the PUBLIC key into Robinhood (web classic > crypto account settings > API).
//   3. Robinhood gives you an API key. Add it to bots/.env.robinhood as RH_API_KEY=...
// The private key is written to bots/.env.robinhood (mode 600) and never printed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '..', '.env.robinhood');
if (fs.existsSync(envFile) && /RH_PRIVATE_KEY=\S+/.test(fs.readFileSync(envFile, 'utf8')) && !process.argv.includes('--force')) {
  console.error(`${envFile} already has a private key. Re-run with --force to replace it (you'd need to re-register with Robinhood).`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

const contents = [
  '# Robinhood Crypto Trading API credentials. Keep this file private. Never commit it.',
  'RH_API_KEY=',
  `RH_PRIVATE_KEY=${seed.toString('base64')}`,
  '',
].join('\n');
fs.writeFileSync(envFile, contents, { mode: 0o600 });

console.log('Public key (paste this into Robinhood):\n');
console.log(pub.toString('base64'));
console.log(`\nPrivate key saved to ${envFile}`);
console.log('After Robinhood shows your API key, put it on the RH_API_KEY= line in that file.');
