#!/usr/bin/env node
// Writes fake candles with known patterns, for testing the bench itself (NOT for picking
// settings). SOL: choppy range, then a selloff. Coins: random walk with planted volume-led
// pumps that partly fade, so momentum rules have something to find.
//   node bench/scripts/make-synthetic.js [outDir] [days]
const fs = require('fs');
const path = require('path');

const out = process.argv[2] || path.join(__dirname, '..', 'data-synthetic');
const days = Number(process.argv[3] || 60);
fs.mkdirSync(out, { recursive: true });

// mulberry32: proper 32-bit PRNG (a plain LCG in JS doubles loses precision and cycles).
let seed = 7;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => { const u = rnd() || 1e-9; const v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const start = Date.UTC(2026, 6, 1);

function write(name, rows) {
  fs.writeFileSync(path.join(out, name), 'time,open,high,low,close,volume\n' + rows.map((r) => r.map((x) => +x.toPrecision(10)).join(',')).join('\n') + '\n');
}

function sol(stepMs) {
  const n = Math.floor((days * 86400000) / stepMs);
  const perHour = 3600000 / stepMs;
  let p = 75;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const frac = i / n;
    const target = frac < 0.75 ? 75 : 75 - 22 * Math.min(1, (frac - 0.75) / 0.2);
    const o = p;
    p = p + (0.02 / perHour) * (target - p) + gauss() * p * (0.012 / Math.sqrt(perHour));
    const h = Math.max(o, p) * (1 + rnd() * 0.004 / Math.sqrt(perHour));
    const l = Math.min(o, p) * (1 - rnd() * 0.004 / Math.sqrt(perHour));
    rows.push([start + i * stepMs, o, h, l, p, 1000 * (1 + rnd())]);
  }
  return rows;
}

function coin(base, stepMs) {
  const n = Math.floor((days * 86400000) / stepMs);
  let p = base;
  let pump = 0; // candles left in a pump
  let fade = 0;
  let this_fake = false;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    let drift = 0;
    let vol = 1000 * (0.6 + rnd());
    // ~1 event per 2 days. Half are real pumps (2-4h up, then a longer fade), half are
    // fake-outs (volume spike, 40 min up, then a sharp dump) that should cost money.
    if (pump === 0 && fade === 0 && rnd() < 1 / (2 * 288)) {
      if (rnd() < 0.5) { pump = 24 + Math.floor(rnd() * 24); this_fake = false; }
      else { pump = 8; this_fake = true; }
    }
    if (pump > 0) { drift = this_fake ? 0.003 : 0.004; vol *= 4; pump--; if (pump === 0) fade = this_fake ? 24 : 60; }
    else if (fade > 0) { drift = this_fake ? -0.005 : -0.0028; vol *= 1.5; fade--; }
    p = p * (1 + drift + gauss() * 0.004);
    const h = Math.max(o, p) * (1 + rnd() * 0.002);
    const l = Math.min(o, p) * (1 - rnd() * 0.002);
    rows.push([start + i * stepMs, o, h, l, p, vol]);
  }
  return rows;
}

write('SOL-1h.csv', sol(3600000));
write('SOL-5m.csv', sol(300000));
for (const [sym, px] of [['BONK', 0.0000024], ['WIF', 0.134], ['POPCAT', 0.028], ['JUP', 0.27]]) write(`${sym}-5m.csv`, coin(px, 300000));
console.log(`Synthetic data (${days} days) written to ${out}`);
