// Minimal client for Robinhood's Trading MCP server (agent.robinhood.com/mcp/trading).
// No AI involved: the bot calls the same tools an agent would, with exact arguments.
//
// Login: OAuth 2.0 authorization code + PKCE, with dynamic client registration (RFC 7591).
// Transport: MCP Streamable HTTP (JSON-RPC over POST; replies may be JSON or SSE).
// Tokens live in bots/.env.robinhood-mcp.json (mode 600, gitignored by `.env.*`).
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');

const MCP_URL = process.env.RH_MCP_URL || 'https://agent.robinhood.com/mcp/trading';
const TOKEN_FILE = process.env.RH_MCP_TOKEN_FILE || path.join(__dirname, '..', '.env.robinhood-mcp.json');
const PROTOCOL_VERSION = '2025-06-18';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`${opts && opts.method || 'GET'} ${url} -> ${res.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// RFC 9728: find the protected-resource metadata, then the authorization server metadata (RFC 8414).
async function discover(mcpUrl = MCP_URL) {
  const u = new URL(mcpUrl);
  let resourceMetaUrl = null;
  try {
    const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    const wa = res.headers.get('www-authenticate') || '';
    const m = wa.match(/resource_metadata="([^"]+)"/);
    if (m) resourceMetaUrl = m[1];
  } catch { /* fall through to well-known paths */ }
  const candidates = [resourceMetaUrl, `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  let resource = null;
  for (const c of candidates) {
    try { resource = await getJson(c); break; } catch { /* try next */ }
  }
  const issuer = (resource && resource.authorization_servers && resource.authorization_servers[0]) || u.origin;
  const iu = new URL(issuer);
  const trim = iu.pathname.replace(/\/$/, '');
  const asCandidates = [
    `${iu.origin}/.well-known/oauth-authorization-server${trim}`,
    `${iu.origin}/.well-known/openid-configuration${trim}`,
    `${iu.origin}${trim}/.well-known/openid-configuration`,
  ];
  let as = null;
  for (const c of asCandidates) {
    try { as = await getJson(c); break; } catch { /* try next */ }
  }
  if (!as) throw new Error(`Could not find OAuth metadata for ${issuer}`);
  return { resource, as, scopes: (resource && resource.scopes_supported) || as.scopes_supported || [] };
}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}

function saveTokens(data) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {});
}

// Interactive login. Opens the browser, waits for the redirect on a local port.
async function login({ host = '127.0.0.1', port = 8765, log = console.log, open = openBrowser } = {}) {
  const meta = await discover();
  const { as } = meta;
  const redirectUri = `http://${host}:${port}/callback`;
  if (!as.registration_endpoint) throw new Error('Server has no dynamic client registration endpoint.');
  log(`Registering this bot with ${new URL(as.registration_endpoint).host} ...`);
  const client = await getJson(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'luh crypto bot',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const auth = new URL(as.authorization_endpoint);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', client.client_id);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);
  auth.searchParams.set('resource', MCP_URL);
  if (meta.scopes.length) auth.searchParams.set('scope', meta.scopes.join(' '));

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('Timed out after 5 minutes waiting for the browser login.')); }, 5 * 60000);
    const server = http.createServer((req, res) => {
      const q = new URL(req.url, redirectUri);
      if (q.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = q.searchParams.get('error');
      const ok = !err && q.searchParams.get('state') === state && q.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html' }).end(ok ? '<p>Connected. You can close this tab and go back to Terminal.</p>' : `<p>Login failed: ${err || 'state mismatch'}. Check Terminal.</p>`);
      clearTimeout(timer);
      server.close();
      if (ok) resolve(q.searchParams.get('code'));
      else reject(new Error(`Authorization failed: ${err || 'state mismatch'} ${q.searchParams.get('error_description') || ''}`));
    });
    server.listen(port, host, () => {
      log('Opening Robinhood login in your browser. If it does not open, paste this link:');
      log(auth.toString());
      open(auth.toString());
    });
  });

  const tokens = await tokenRequest(as.token_endpoint, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: MCP_URL,
  });
  const saved = { mcpUrl: MCP_URL, tokenEndpoint: as.token_endpoint, clientId: client.client_id, ...stamp(tokens) };
  saveTokens(saved);
  return saved;
}

function stamp(t) {
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null, scope: t.scope };
}

async function tokenRequest(endpoint, params) {
  return getJson(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params).toString() });
}

async function freshToken() {
  const t = loadTokens();
  if (!t) throw new Error('Not logged in. Run: node shared/scripts/rh-mcp-login.js');
  if (t.expiresAt && Date.now() > t.expiresAt - 60000) {
    if (!t.refreshToken) throw new Error('Login expired. Run: node shared/scripts/rh-mcp-login.js');
    const r = await tokenRequest(t.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId, resource: t.mcpUrl });
    const next = { ...t, ...stamp(r), refreshToken: r.refresh_token || t.refreshToken };
    saveTokens(next);
    return next;
  }
  return t;
}

// Parse a Streamable HTTP reply: plain JSON, or SSE with `data:` lines.
async function readRpc(res, id) {
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  if (!text.trim()) return null;
  const msgs = type.includes('text/event-stream')
    ? text.split(/\n\n/).map((ev) => ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d))
    : [JSON.parse(text)].flat();
  return msgs.find((m) => m.id === id) || null;
}

class RobinhoodMcp {
  constructor() { this.sessionId = null; this.nextId = 1; this.ready = false; }

  async rpc(method, params, { notify = false } = {}) {
    const t = await freshToken();
    const id = notify ? undefined : this.nextId++;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t.accessToken}`, 'mcp-protocol-version': PROTOCOL_VERSION };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(t.mcpUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notify) { await res.text(); return null; }
    const msg = await readRpc(res, id);
    if (!msg) throw new Error(`No reply to ${method}`);
    if (msg.error) throw new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  async connect() {
    if (this.ready) return;
    const r = await this.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'luh-crypto-bot', version: '1.0.0' } });
    await this.rpc('notifications/initialized', undefined, { notify: true });
    this.server = r.serverInfo;
    this.ready = true;
  }

  async listTools() {
    await this.connect();
    const out = [];
    let cursor;
    do {
      const r = await this.rpc('tools/list', cursor ? { cursor } : {});
      out.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  }

  // Calls a tool and returns parsed JSON when the tool replies with JSON text.
  async call(name, args = {}) {
    await this.connect();
    const r = await this.rpc('tools/call', { name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${(r.content || []).map((c) => c.text).join(' ').slice(0, 500)}`);
    if (r.structuredContent) return r.structuredContent;
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    try { return JSON.parse(text); } catch { return text; }
  }
}

module.exports = { RobinhoodMcp, login, discover, loadTokens, TOKEN_FILE, MCP_URL };
