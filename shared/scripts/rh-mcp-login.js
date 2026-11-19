#!/usr/bin/env node
// Log a bot on this computer into Robinhood's Trading MCP (the agentic account), then run a
// READ-ONLY check: list the tools and the accounts. Places no trades.
//
//   node shared/scripts/rh-mcp-login.js            log in (opens browser), then check
//   node shared/scripts/rh-mcp-login.js --check    reuse the saved login, check only
//   node shared/scripts/rh-mcp-login.js --localhost   use http://localhost:8765 as the redirect
//
// The login is saved to bots/.env.robinhood-mcp.json (only you can read it; never pushed to GitHub).
const { RobinhoodMcp, login, loadTokens, TOKEN_FILE } = require('../rh-mcp');

const args = process.argv.slice(2);

(async () => {
  if (!args.includes('--check') || !loadTokens()) {
    await login({ host: args.includes('--localhost') ? 'localhost' : '127.0.0.1' });
    console.log(`Logged in. Saved to ${TOKEN_FILE}`);
  }
  const mcp = new RobinhoodMcp();
  const tools = await mcp.listTools();
  console.log(`\nConnected to ${mcp.server ? `${mcp.server.name} ${mcp.server.version || ''}` : 'Robinhood MCP'}. ${tools.length} tools:`);
  console.log(tools.map((t) => t.name).sort().join(', '));
  if (tools.some((t) => t.name === 'get_accounts')) {
    const accts = await mcp.call('get_accounts');
    const text = JSON.stringify(accts);
    console.log(`\nget_accounts worked (${text.length} bytes of account data). Not printing it here.`);
  }
  console.log('\nThe bot can reach Robinhood stocks directly. No trades were placed.');
})().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  if (/oauth\/error|403|redirect/i.test(err.message)) {
    console.error('Robinhood may be rejecting the local login address. Try again with --localhost.');
  }
  process.exit(1);
});
