// Fake Robinhood OAuth + MCP server: checks discovery, dynamic registration, PKCE, token refresh,
// session handling and SSE parsing, end to end, with no network.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fakeServer() {
  const st = { codes: {}, tokens: new Set(), sessions: new Set(), calls: [], registered: null, issued: 0 };
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    let body = '';
    for await (const c of req) body += c;
    const json = (code, obj, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj));
    const issue = () => { st.issued++; const a = `at-${st.issued}`; st.tokens.add(a); return { access_token: a, refresh_token: `rt-${st.issued}`, expires_in: st.issued === 1 ? 1 : 3600, token_type: 'Bearer' }; };

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp/trading') return json(200, { resource: `${base}/mcp/trading`, authorization_servers: [`${base}/auth`], scopes_supported: ['trading'] });
    if (url.pathname === '/.well-known/oauth-authorization-server/auth') return json(200, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register` });
    if (url.pathname === '/auth/register') { st.registered = JSON.parse(body); return json(201, { client_id: 'cid-1', ...st.registered }); }
    if (url.pathname === '/auth/authorize') {
      const p = url.searchParams;
      assert.strictEqual(p.get('client_id'), 'cid-1');
      assert.strictEqual(p.get('code_challenge_method'), 'S256');
      assert.strictEqual(p.get('scope'), 'trading');
      const code = `code-${Math.random()}`;
      st.codes[code] = p.get('code_challenge');
      return res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }).end();
    }
    if (url.pathname === '/auth/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const expected = st.codes[p.get('code')];
        if (b64url(crypto.createHash('sha256').update(p.get('code_verifier')).digest()) !== expected) return json(400, { error: 'invalid_grant' });
        return json(200, issue());
      }
      if (p.get('grant_type') === 'refresh_token') return json(200, issue());
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/mcp/trading') {
      const auth = (req.headers.authorization || '').replace('Bearer ', '');
      if (!st.tokens.has(auth)) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/trading"` });
      const msg = JSON.parse(body);
      st.calls.push({ method: msg.method, token: auth, session: req.headers['mcp-session-id'] });
      if (msg.method === 'initialize') { st.sessions.add('s-1'); return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-rh', version: '1' }, capabilities: {} } }, { 'mcp-session-id': 's-1' }); }
      if (msg.method === 'notifications/initialized') return res.writeHead(202).end();
      if (!st.sessions.has(req.headers['mcp-session-id'])) return json(400, { error: 'no session' });
      if (msg.method === 'tools/list') {
        // Reply as SSE, paged in two parts.
        const result = msg.params && msg.params.cursor ? { tools: [{ name: 'place_equity_order' }] } : { tools: [{ name: 'get_accounts' }], nextCursor: 'p2' };
        return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      }
      if (msg.method === 'tools/call') {
        if (msg.params.name === 'boom') return json(200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'market closed' }] } });
        return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ accounts: [{ id: 'A1' }], args: msg.params.arguments }) }] } });
      }
    }
    res.writeHead(404).end();
  });
  return { server, st };
}

test('login, refresh, session and tool calls against a fake Robinhood MCP', async () => {
  const { server, st } = fakeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokenFile = path.join(os.tmpdir(), `rh-mcp-test-${process.pid}.json`);
  process.env.RH_MCP_URL = `${base}/mcp/trading`;
  process.env.RH_MCP_TOKEN_FILE = tokenFile;
  delete require.cache[require.resolve('../rh-mcp')];
  const { login, RobinhoodMcp } = require('../rh-mcp');
  try {
    // "Browser": follow the authorize redirect to the local callback.
    const saved = await login({ port: 0 + 18765, log: () => {}, open: (u) => fetch(u).catch(() => {}) });
    assert.strictEqual(saved.clientId, 'cid-1');
    assert.deepStrictEqual(st.registered.redirect_uris, ['http://127.0.0.1:18765/callback']);
    assert.strictEqual(st.registered.token_endpoint_auth_method, 'none');
    assert.strictEqual((fs.statSync(tokenFile).mode & 0o777).toString(8), '600');

    // First token expires in 1s, so the client must refresh before calling.
    await new Promise((r) => setTimeout(r, 1100));
    const mcp = new RobinhoodMcp();
    const tools = await mcp.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name), ['get_accounts', 'place_equity_order']);
    assert.strictEqual(st.calls[0].token, 'at-2', 'refreshed token used');
    assert.ok(st.calls.filter((c) => c.method === 'tools/list').every((c) => c.session === 's-1'));

    const r = await mcp.call('get_accounts', { x: 1 });
    assert.deepStrictEqual(r, { accounts: [{ id: 'A1' }], args: { x: 1 } });
    await assert.rejects(mcp.call('boom'), /market closed/);
  } finally {
    server.close();
    fs.rmSync(tokenFile, { force: true });
    delete process.env.RH_MCP_URL;
    delete process.env.RH_MCP_TOKEN_FILE;
  }
});
