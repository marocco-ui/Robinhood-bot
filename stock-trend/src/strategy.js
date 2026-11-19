// Trend rule (Faber 2007): hold the risk asset while its last month-end close is above the
// average of its last N month-end closes; otherwise hold the safe asset.
function trendSignal(monthCloses, { smaMonths = 10, risk = 'SPY', safe = 'SHY' } = {}) {
  const done = monthCloses.filter((m) => Number.isFinite(m.close) && m.close > 0);
  if (done.length < smaMonths) return null;
  const window = done.slice(-smaMonths);
  const sma = window.reduce((s, m) => s + m.close, 0) / smaMonths;
  const last = window[window.length - 1];
  return {
    target: last.close > sma ? risk : safe,
    month: last.month,
    lastClose: last.close,
    sma: +sma.toFixed(4),
    gapPct: +((last.close / sma - 1) * 100).toFixed(2),
  };
}

// US regular session, 9:35 to 15:55 New York time on weekdays (a few minutes inside the bell).
// Holidays aren't listed: a market order placed on one waits for the next open.
function isRegularHours(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 35 && mins <= 15 * 60 + 55;
}

module.exports = { trendSignal, isRegularHours };
