// Helpers for rounding to exchange increments without float drift in the output string.

function decimalsOf(increment) {
  const s = String(increment);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// Round down to a multiple of increment, return a string with the increment's precision.
function floorTo(value, increment) {
  const inc = Number(increment);
  if (!(inc > 0)) throw new Error(`Bad increment ${increment}`);
  const d = decimalsOf(increment);
  const steps = Math.floor(value / inc + 1e-9);
  return (steps * inc).toFixed(d);
}

function roundTo(value, increment) {
  const inc = Number(increment);
  const d = decimalsOf(increment);
  return (Math.round(value / inc) * inc).toFixed(d);
}

function ceilTo(value, increment) {
  const inc = Number(increment);
  const d = decimalsOf(increment);
  const steps = Math.ceil(value / inc - 1e-9);
  return (steps * inc).toFixed(d);
}

module.exports = { decimalsOf, floorTo, roundTo, ceilTo };
