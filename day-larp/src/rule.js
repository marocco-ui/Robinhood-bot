// Intraday momentum (Gao, Han, Li, Zhou 2018, Journal of Financial Economics):
// SPY's return from yesterday's close to 10:00 ET predicts its return from 15:30 to 16:00 ET.
// Paper only. This module decides; it never places orders.

// New York wall-clock time for a Date, as minutes after midnight plus the date string.
function nyClock(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, mins: Number(p.hour) * 60 + Number(p.minute) };
}

const WINDOWS = {
  signal: [10 * 60, 10 * 60 + 10],    // 10:00 to 10:10 ET: read the first half-hour return
  entry: [15 * 60 + 30, 15 * 60 + 40], // 15:30 to 15:40 ET: enter
  exit: [15 * 60 + 57, 15 * 60 + 59],  // 15:57 to 15:59 ET: exit before the close
};

function phase(date) {
  const c = nyClock(date);
  if (c.weekday === 'Sat' || c.weekday === 'Sun') return { ...c, phase: 'weekend' };
  for (const [name, [a, b]] of Object.entries(WINDOWS)) if (c.mins >= a && c.mins <= b) return { ...c, phase: name };
  return { ...c, phase: 'idle' };
}

// Which way each tracked variant trades, given the first half-hour return.
function sides(r1, { minAbs = 0 } = {}) {
  const dir = r1 > minAbs ? 1 : r1 < -minAbs ? -1 : 0;
  return {
    paperRule: dir > 0 ? 1 : 0,      // long only when the morning was up (as published)
    longShort: dir,                   // long when up, short when down
  };
}

// A quote is usable only if it traded recently: catches holidays and early closes.
function fresh(quote, now, maxAgeSec = 120) {
  const t = Date.parse(quote.venue_last_trade_time || '');
  return Number.isFinite(t) && (now.getTime() - t) / 1000 <= maxAgeSec && quote.state === 'active';
}

// Fill prices for a paper trade: buy at the ask, sell at the bid.
function pnlPct(side, entryQ, exitQ) {
  if (!side) return 0;
  const n = (x) => Number(x);
  if (side > 0) return (n(exitQ.bid_price) / n(entryQ.ask_price) - 1) * 100;
  return (n(entryQ.bid_price) / n(exitQ.ask_price) - 1) * 100;
}

module.exports = { nyClock, phase, sides, fresh, pnlPct, WINDOWS };
