// Persistence + logging. Everything a bot decides is written to disk so you can audit it:
//   data/state.json      current state (atomic writes, survives restarts)
//   logs/events.jsonl    one JSON line per event (scans, signals, orders, fills, errors)
//   logs/trades.csv      one line per filled order
//   data/status.json     latest snapshot, read by send-digest.sh
const fs = require('fs');
const path = require('path');

// A broken stdout/stderr (closed pipe, detached terminal) must never crash a trading bot,
// especially mid-shutdown while it's canceling orders. The file logs below still get written.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {});
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Corrupt state is dangerous for a trading bot: keep a copy and stop loudly.
    const backup = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, backup); } catch {}
    throw new Error(`State file ${file} is unreadable (${err.message}). Copied to ${backup}. Fix or remove it before restarting.`);
  }
}

class Logger {
  constructor({ botName, logDir, quiet = false }) {
    this.botName = botName;
    this.logDir = logDir;
    this.quiet = quiet;
    ensureDir(logDir);
    this.eventsFile = path.join(logDir, 'events.jsonl');
    this.tradesFile = path.join(logDir, 'trades.csv');
    if (!fs.existsSync(this.tradesFile)) {
      fs.writeFileSync(this.tradesFile, 'time,mode,bot,symbol,side,type,qty,price,notional_usd,fee_usd,reason,order_id\n');
    }
  }

  event(type, data = {}, level = 'info') {
    const entry = { t: new Date().toISOString(), bot: this.botName, level, type, ...data };
    fs.appendFileSync(this.eventsFile, JSON.stringify(entry) + '\n');
    if (!this.quiet) {
      const short = Object.entries(data)
        .filter(([, v]) => v === null || typeof v !== 'object')
        .map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(6) : v}`)
        .join(' ');
      const line = `[${entry.t}] [${type.toUpperCase()}] ${short}`;
      if (level === 'error') console.error(line);
      else console.log(line);
    }
    return entry;
  }

  error(type, err, data = {}) {
    return this.event(type, { ...data, error: err && err.message ? err.message : String(err) }, 'error');
  }

  trade({ mode, symbol, side, type, qty, price, fee = 0, reason = '', orderId = '' }) {
    const row = [
      new Date().toISOString(), mode, this.botName, symbol, side, type,
      qty, price, (qty * price).toFixed(2), Number(fee).toFixed(4), reason, orderId,
    ].join(',');
    fs.appendFileSync(this.tradesFile, row + '\n');
  }
}

module.exports = { writeJsonAtomic, readJson, ensureDir, Logger };
