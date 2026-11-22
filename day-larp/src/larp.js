#!/usr/bin/env node
// Paper-only SPY day trader. It CANNOT place real orders: it only reads quotes.
// Every trading day: reads the first half-hour at 10:00 ET, "enters" at 15:30, "exits" at 15:57,
// and logs what two variants would have made at the real bid and ask.
//
//   node day-larp/src/larp.js            run (pm2: pm2 start day-larp/ecosystem.config.js)
//   node day-larp/src/larp.js --report   print the running record
const fs = require('fs');
const path = require('path');
const { RobinhoodMcp } = require('../../shared/rh-mcp');
const { readJson, writeJsonAtomic } = require('../../shared/store');
const { phase, sides, fresh, pnlPct } = require('./rule');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'data', 'state.json');
const CSV = path.join(ROOT, 'logs', 'days.csv');
const SYMBOL = 'SPY';
const CAPITAL = 1000;
const VARIANTS = ['paperRule', 'longShort'];

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function quote(mcp) {
  const r = await mcp.call('get_equity_quotes', { symbols: [SYMBOL] });
  const q = ((r.data || r).results || []).map((x) => x.quote).find((x) => x && x.symbol === SYMBOL);
  if (!q) throw new Error('no SPY quote');
  return q;
}

function appendDay(row) {
  fs.mkdirSync(path.dirname(CSV), { recursive: true });
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, 'date,r1_pct,variant,side,entry,exit,pnl_pct,equity\n');
  fs.appendFileSync(CSV, `${row.date},${row.r1},${row.variant},${row.side},${row.entry},${row.exit},${row.pnl.toFixed(4)},${row.equity.toFixed(2)}\n`);
}

// One step. Exported for tests: takes the clock and a quote function.
async function step(state, now, getQuote) {
  const p = phase(now);
  if (p.phase === 'weekend' || p.phase === 'idle') return { state, did: 'nothing' };
  const day = state.day && state.day.date === p.day ? state.day : { date: p.day };
  state.day = day;
  state.equity = state.equity || Object.fromEntries(VARIANTS.map((v) => [v, CAPITAL]));

  if (p.phase === 'signal' && day.r1 === undefined) {
    const q = await getQuote();
    if (!fresh(q, now)) { day.skip = 'market not trading at 10:00'; return { state, did: 'skip' }; }
    day.r1 = +((Number(q.last_trade_price) / Number(q.adjusted_previous_close) - 1) * 100).toFixed(4);
    day.sides = sides(day.r1);
    return { state, did: 'signal' };
  }
  if (p.phase === 'entry' && day.r1 !== undefined && !day.skip && !day.entryQ) {
    const q = await getQuote();
    if (!fresh(q, now)) { day.skip = 'market not trading at 15:30 (early close?)'; return { state, did: 'skip' }; }
    day.entryQ = { bid_price: q.bid_price, ask_price: q.ask_price, last: q.last_trade_price };
    return { state, did: 'entry' };
  }
  if (p.phase === 'exit' && day.entryQ && !day.done) {
    const q = await getQuote();
    if (!fresh(q, now)) return { state, did: 'wait' };
    const exitQ = { bid_price: q.bid_price, ask_price: q.ask_price, last: q.last_trade_price };
    day.results = {};
    for (const v of VARIANTS) {
      const side = day.sides[v];
      const pnl = pnlPct(side, day.entryQ, exitQ);
      state.equity[v] *= 1 + pnl / 100;
      day.results[v] = { side, pnl, equity: state.equity[v], entry: side > 0 ? day.entryQ.ask_price : side < 0 ? day.entryQ.bid_price : '', exit: side > 0 ? exitQ.bid_price : side < 0 ? exitQ.ask_price : '' };
    }
    day.done = true;
    state.history = [...(state.history || []), { date: day.date, r1: day.r1, results: day.results }];
    return { state, did: 'exit' };
  }
  return { state, did: 'nothing' };
}

function report(state) {
  const h = state.history || [];
  if (!h.length) { console.log('No completed days yet.'); return; }
  console.log(`${h.length} trading days, ${h[0].date} to ${h[h.length - 1].date}. Paper money, $${CAPITAL} start each.\n`);
  for (const v of VARIANTS) {
    const traded = h.map((d) => d.results[v]).filter((r) => r.side);
    const wins = traded.filter((r) => r.pnl > 0).length;
    const eq = state.equity[v];
    console.log(`${v === 'paperRule' ? 'Long when morning is up (published rule)' : 'Long when up, short when down'}: $${eq.toFixed(2)} (${((eq / CAPITAL - 1) * 100).toFixed(2)}%), ${traded.length} trades, ${traded.length ? Math.round((wins / traded.length) * 100) : 0}% winners`);
  }
}

async function main() {
  const state = readJson(STATE, {});
  if (process.argv.includes('--report')) { report(state); return; }
  const mcp = new RobinhoodMcp();
  log('day-larp started (paper only, SPY intraday momentum)');
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  while (!stopping) {
    try {
      const r = await step(state, new Date(), () => quote(mcp));
      if (r.did !== 'nothing') {
        writeJsonAtomic(STATE, state);
        const d = state.day;
        if (r.did === 'signal') log(`first half-hour ${d.r1 > 0 ? '+' : ''}${d.r1}%: paper rule ${d.sides.paperRule ? 'LONG' : 'flat'}, long/short ${d.sides.longShort > 0 ? 'LONG' : d.sides.longShort < 0 ? 'SHORT' : 'flat'}`);
        if (r.did === 'entry') log(`entered at bid ${d.entryQ.bid_price} / ask ${d.entryQ.ask_price}`);
        if (r.did === 'skip') log(`skipping today: ${d.skip}`);
        if (r.did === 'exit') {
          for (const v of VARIANTS) appendDay({ date: d.date, r1: d.r1, variant: v, ...d.results[v] });
          log(VARIANTS.map((v) => `${v} ${d.results[v].pnl.toFixed(3)}% -> $${d.results[v].equity.toFixed(2)}`).join(' | '));
        }
      }
    } catch (err) {
      log(`error: ${err.message}`);
      if (/Not logged in|Login expired/.test(err.message)) process.exit(1);
    }
    for (let s = 0; s < 30 && !stopping; s++) await new Promise((res) => setTimeout(res, 1000));
  }
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { step, report };
