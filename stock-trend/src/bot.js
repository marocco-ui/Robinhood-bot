#!/usr/bin/env node
// SPY trend bot. Holds SPY while it's above its 10-month average, else short-term Treasuries (SHY).
// Trades the Robinhood Agentic account directly through Robinhood's Trading MCP. No AI involved.
//
//   node stock-trend/src/bot.js            run (checks every 15 min during market hours)
//   node stock-trend/src/bot.js --once     one check, then exit
//   node stock-trend/src/bot.js --status   show the signal and holdings, place nothing
//
// Stop it any time: Ctrl+C, or create the file stock-trend/STOP.
const path = require('path');
const { loadEnv } = require('../../shared/env');
const { readJson, writeJsonAtomic, Logger } = require('../../shared/store');
const { Telegram } = require('../../shared/telegram');
const { RobinhoodMcp } = require('../../shared/rh-mcp');
const { loadConfig } = require('./config');
const { McpBroker, PaperBroker } = require('./brokers');
const { TrendEngine } = require('./engine');
const { isRegularHours } = require('./strategy');

const ROOT = path.join(__dirname, '..');
loadEnv(ROOT);
const args = process.argv.slice(2);

async function main() {
  const cfg = loadConfig();
  const log = new Logger({ botName: 'stock-trend', logDir: path.join(ROOT, 'logs') });
  const tg = new Telegram({ prefix: `[stock-trend ${cfg.mode}] ` });
  const alert = async (text) => { try { await tg.send(text); } catch {} };

  const mcp = new RobinhoodMcp();
  const live = new McpBroker({ mcp, accountNumber: cfg.accountNumber });
  const acct = await live.init();
  if (live.accountType && live.accountType !== 'cash') log.event('note', { msg: `Agent account is ${live.accountType}, not cash` });

  let broker = live;
  if (cfg.mode === 'paper') {
    const paperFile = path.join(ROOT, 'data', 'paper.json');
    const paper = readJson(paperFile, { cash: cfg.paperCashUsd, positions: {}, unsettled: [], orders: {} });
    broker = new PaperBroker({ quotes: live, state: paper, save: (s) => writeJsonAtomic(paperFile, s) });
  }

  const stateFile = path.join(ROOT, 'data', `state-${cfg.mode}.json`);
  const engine = new TrendEngine({
    cfg, broker, log, alert,
    state: readJson(stateFile, null),
    saveState: (s) => writeJsonAtomic(stateFile, s),
    stopFile: path.join(ROOT, 'STOP'),
  });
  log.event('start', { mode: cfg.mode, account: acct.account, risk: cfg.risk, safe: cfg.safe, smaMonths: cfg.smaMonths, capitalUsd: cfg.capitalUsd });

  if (args.includes('--status')) {
    const sig = await engine.refreshSignal();
    const [bp, positions] = await Promise.all([broker.buyingPower(), broker.positions()]);
    console.log(`\nMode ${cfg.mode}, account ${acct.account}${acct.nickname ? ` (${acct.nickname})` : ''}`);
    console.log(`Signal: hold ${sig.target}. ${cfg.risk} closed ${sig.month} at ${sig.lastClose}, ${sig.gapPct > 0 ? '+' : ''}${sig.gapPct}% vs its ${cfg.smaMonths}-month average ${sig.sma}.`);
    console.log(`Buying power $${bp.toFixed(2)}. Holdings: ${positions.map((p) => `${p.symbol} ${p.quantity}`).join(', ') || 'none'}`);
    console.log(`Market ${isRegularHours() ? 'open' : 'closed'} now. Nothing was traded.`);
    return;
  }

  let stopping = false;
  const stop = () => { stopping = true; log.event('stop', {}); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  do {
    try {
      // Run steps back to back while there's something to do (e.g. a fill, then the next order).
      for (let k = 0; k < 4; k++) {
        const r = await engine.tick();
        if (r.action !== 'order_done') {
          if (!['market_closed', 'hold', 'waiting'].includes(r.action) || args.includes('--once')) log.event('tick', r);
          break;
        }
      }
    } catch (err) {
      log.error('tick_error', err);
      if (/Not logged in|Login expired/.test(err.message)) { await alert(`Stopped: ${err.message}`); process.exit(1); }
    }
    if (args.includes('--once')) break;
    for (let s = 0; s < cfg.pollMinutes * 60 && !stopping; s++) await new Promise((r) => setTimeout(r, 1000));
  } while (!stopping);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
