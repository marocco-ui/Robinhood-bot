#!/usr/bin/env node
// Solana momentum bot runner (DexScreener signals, Robinhood execution).
//   node src/trader.js              run (pm2 runs this)
//   node src/trader.js --status     print state and exit
//   node src/trader.js --scan-once  one scan with full signal details, no trading
//   node src/trader.js --liquidate  sell this bot's positions and halt
//   node src/trader.js --reset-halt clear a halt
// A file named STOP in this folder pauses new entries (open positions keep their exits).
const fs = require('fs');
const path = require('path');
const BOT_DIR = path.join(__dirname, '..');
require('../../shared/env').loadEnv(BOT_DIR);

const { loadConfig } = require('./config');
const { MomentumEngine } = require('./momentum');
const { DexScreenerClient } = require('./modules/dexscreener');
const { createBroker } = require('../../shared/factory');
const { Logger, readJson, writeJsonAtomic } = require('../../shared/store');
const { Telegram } = require('../../shared/telegram');

const STATE_FILE = path.join(BOT_DIR, 'data', 'state.json');
const STATUS_FILE = path.join(BOT_DIR, 'data', 'status.json');
const STOP_FILE = path.join(BOT_DIR, 'STOP');

async function main() {
  const args = new Set(process.argv.slice(2));
  const cfg = loadConfig();
  const log = new Logger({ botName: 'momentum', logDir: path.join(BOT_DIR, 'logs') });
  const alerts = new Telegram({ prefix: cfg.mode === 'live' ? '[MOMENTUM LIVE]' : '[MOMENTUM paper]' });

  const saved = readJson(STATE_FILE, null);
  if (saved && saved.mode && saved.mode !== cfg.mode) {
    throw new Error(`State file is from ${saved.mode} mode but TRADING_MODE=${cfg.mode}. Move data/state.json aside before switching.`);
  }
  const broker = createBroker({ mode: cfg.mode, perMinute: cfg.apiPerMinute, startingCash: cfg.risk.capitalUsd, feeBps: cfg.paperFeeBps, log });
  if (broker.mode === 'paper' && saved && saved.paper) broker.restore(saved.paper);

  const engine = new MomentumEngine({ cfg, broker, dex: new DexScreenerClient(), log, alerts, state: saved ? saved.engine : null });
  const persist = () => {
    if (broker.prune) broker.prune();
    writeJsonAtomic(STATE_FILE, { mode: cfg.mode, savedAt: new Date().toISOString(), engine: engine.snapshot(), paper: broker.mode === 'paper' ? broker.toJSON() : undefined });
    writeJsonAtomic(STATUS_FILE, { updatedAt: new Date().toISOString(), ...engine.summary() });
  };
  engine.onPersist = persist;

  if (args.has('--status')) {
    console.log(JSON.stringify(engine.summary(), null, 2));
    return;
  }
  if (args.has('--reset-halt')) {
    engine.state.halted = null;
    persist();
    console.log('Halt cleared.');
    return;
  }
  if (args.has('--liquidate')) {
    await engine.loadUniverse();
    await engine.liquidateAll('manual liquidate');
    persist();
    return;
  }
  if (args.has('--scan-once')) {
    engine.dryRun = true; // never trades
    const { results } = await engine.scan();
    for (const r of (results || []).sort((a, b) => b.score - a.score)) {
      const fails = r.fail.length ? `fails: ${r.fail.join(', ')}` : 'PASSES';
      console.log(`${r.symbol.padEnd(11)} score ${String(r.score).padStart(3)}  ${fails}`);
      for (const [k, v] of Object.entries(r.checks)) console.log(`    ${v.pass ? '✓' : '✗'} ${k}: ${v.value}`);
    }
    persist();
    return;
  }

  if (cfg.mode === 'live') log.event('live_mode', { note: 'Real orders will be placed', capitalUsd: cfg.risk.capitalUsd }, 'warn');
  await alerts.send(`🚀 Momentum bot started (${cfg.mode}). Capital $${cfg.risk.capitalUsd}, max ${cfg.risk.maxPositions} positions of $${cfg.risk.maxPositionUsd}.`);
  log.event('started', { mode: cfg.mode, capital: cfg.risk.capitalUsd, note: 'Breakout check needs ~60 min of price history before the first entry' });

  // One job at a time so scans and exits never race each other.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));
  let running = true;
  let lastHeartbeat = 0;

  const safe = (name, fn) => async () => {
    try {
      await fn();
      persist();
    } catch (err) {
      log.error(`${name}_failed`, err);
      try { persist(); } catch {}
    }
  };

  const scanJob = safe('scan', async () => {
    if (fs.existsSync(STOP_FILE)) {
      if (!engine.state.paused) log.event('paused', { reason: 'STOP file' }, 'warn');
      engine.state.paused = true;
      return;
    }
    engine.state.paused = false;
    await engine.scan();
    if (Date.now() - lastHeartbeat > cfg.heartbeatMs) {
      lastHeartbeat = Date.now();
      const s = engine.summary();
      await alerts.send(`📈 Equity $${s.equity} (${s.returnPct}%), realized $${s.realizedPnl}, open ${s.openPositions.length}, trades ${s.trades}`, { silent: true });
    }
  });
  const positionJob = safe('positions', () => engine.managePositions());

  const loop = async (job, every) => {
    while (running) {
      await serial(job);
      await new Promise((r) => setTimeout(r, every));
    }
  };

  const stop = async (signal) => {
    running = false;
    log.event('shutdown', { signal });
    await chain.catch(() => {});
    persist();
    await alerts.send('🛑 Momentum bot stopped. Open positions are NOT sold; they resume being managed on restart.');
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  if (process.send) process.send('ready');

  loop(scanJob, cfg.scanMs);
  loop(positionJob, cfg.positionMs);
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
