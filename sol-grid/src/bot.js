#!/usr/bin/env node
// SOL grid bot runner.
//   node src/bot.js               run the loop (pm2 runs this)
//   node src/bot.js --status      print current state and exit
//   node src/bot.js --flatten     cancel orders, sell grid coins, halt
//   node src/bot.js --cancel-all  cancel grid orders only
//   node src/bot.js --reset-halt  clear a halt after you've checked things
// Create a file named STOP in this folder to make the running bot cancel its orders and halt.
const fs = require('fs');
const path = require('path');
const BOT_DIR = path.join(__dirname, '..');
require('../../shared/env').loadEnv(BOT_DIR);

const { loadConfig } = require('./config');
const { GridEngine } = require('./grid');
const { createBroker } = require('../../shared/factory');
const { Logger, readJson, writeJsonAtomic } = require('../../shared/store');
const { Telegram } = require('../../shared/telegram');

const STATE_FILE = path.join(BOT_DIR, 'data', 'state.json');
const STATUS_FILE = path.join(BOT_DIR, 'data', 'status.json');
const STOP_FILE = path.join(BOT_DIR, 'STOP');

async function main() {
  const args = new Set(process.argv.slice(2));
  const cfg = loadConfig();
  const log = new Logger({ botName: 'sol-grid', logDir: path.join(BOT_DIR, 'logs') });
  const alerts = new Telegram({ prefix: cfg.mode === 'live' ? '[GRID LIVE]' : '[GRID paper]' });

  const saved = readJson(STATE_FILE, null);
  if (saved && saved.mode && saved.mode !== cfg.mode) {
    throw new Error(`State file is from ${saved.mode} mode but TRADING_MODE=${cfg.mode}. Move data/state.json aside before switching modes.`);
  }

  const broker = createBroker({ mode: cfg.mode, perMinute: cfg.apiPerMinute, startingCash: cfg.paperStartingCash, feeBps: cfg.paperFeeBps, log });
  if (broker.mode === 'paper' && saved && saved.paper) broker.restore(saved.paper);

  const engine = new GridEngine({ cfg, broker, log, alerts, state: saved ? saved.grid : null });
  const persist = () => {
    if (broker.prune) broker.prune();
    writeJsonAtomic(STATE_FILE, {
      mode: cfg.mode,
      savedAt: new Date().toISOString(),
      grid: engine.state,
      paper: broker.mode === 'paper' ? broker.toJSON() : undefined,
    });
  };
  engine.onPersist = persist;
  await engine.init();
  persist();

  if (args.has('--status')) {
    const quote = await broker.getQuote(cfg.symbol);
    console.log(JSON.stringify({ ...engine.summary(quote), halted: engine.state.halted, slots: engine.state.slots }, null, 2));
    return;
  }
  if (args.has('--reset-halt')) {
    engine.state.halted = null;
    persist();
    console.log('Halt cleared.');
    return;
  }
  if (args.has('--cancel-all')) {
    await engine.cancelAll();
    await broker.sync();
    await engine.updateOrders();
    persist();
    console.log('Grid orders canceled.');
    return;
  }
  if (args.has('--flatten')) {
    await engine.flatten('manual flatten');
    persist();
    return;
  }

  if (cfg.mode === 'live') {
    log.event('live_mode', { note: 'Real orders will be placed', maxCapitalUsd: cfg.maxCapitalUsd }, 'warn');
  }
  await alerts.send(`🚀 Grid bot started (${cfg.mode}) ${cfg.symbol} ${engine.levels[0]}–${engine.levels[engine.levels.length - 1]}, ${cfg.gridCount} slots, step ${cfg.stepPct.toFixed(2)}%`);

  let running = true;
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    running = false;
    log.event('shutdown', { signal });
    try {
      await engine.shutdown();
      persist();
      await alerts.send('🛑 Grid bot stopped' + (cfg.cancelOnExit ? ' (orders canceled)' : ''));
    } catch (err) {
      log.error('shutdown_failed', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  if (process.send) process.send('ready'); // pm2 wait_ready

  let consecutiveErrors = 0;
  while (running) {
    try {
      if (fs.existsSync(STOP_FILE) && !engine.state.halted) {
        await engine.cancelAll();
        await broker.sync();
        await engine.updateOrders();
        engine.state.halted = { reason: 'STOP file', at: new Date().toISOString() };
        log.event('halted', { reason: 'STOP file' }, 'warn');
        await alerts.send('🛑 STOP file found: grid orders canceled, bot halted.');
      }
      const summary = await engine.tick();
      persist();
      writeJsonAtomic(STATUS_FILE, { updatedAt: new Date().toISOString(), symbol: cfg.symbol, ...summary, halted: engine.state.halted });
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      log.error('tick_failed', err, { consecutiveErrors });
      try { persist(); } catch {}
      if (consecutiveErrors === 5) await alerts.send(`💥 Grid bot: 5 errors in a row. Last: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, Math.min(cfg.tickMs * 2 ** Math.min(consecutiveErrors, 4), 300000)));
  }
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
