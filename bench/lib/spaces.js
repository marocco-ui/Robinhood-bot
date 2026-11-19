// Settings the optimizer tries. Edit these lists to widen or narrow the search.
const GRID_SPACE = {
  downPct: [10, 15, 20, 30, 40],      // range below the start price
  upPct: [10, 15, 20, 30, 40],        // range above the start price
  count: [4, 6, 8, 10, 12, 16],       // number of slots
  maxOpenBuys: [4],
  stopLossPct: [0, 8, 15],            // % below the range bottom (0 = no stop)
  trendMaHours: [0, 72, 240, 480],    // trend filter MA length (0 = off; 240h = 10 days)
};

const MOMENTUM_SPACE = {
  minVolumeAccel: [1.2, 1.5, 2, 2.5, 3],
  minBuyRatio: [0.5, 0.55, 0.6, 0.65],
  minChange1h: [0.5, 1, 2, 3],
  maxChange1h: [8, 15, 25],
  breakoutLookbackMin: [30, 60, 120, 240],
  stopLossPct: [-5, -8, -12, -18],
  takeProfitPct: [10, 20, 30, 50],
  trailActivatePct: [4, 8, 12, 20],
  trailPct: [3, 5, 8, 12],
  maxHoldHours: [4, 12, 24, 48],
  minScore: [30, 45, 60],
};

function* gridCombos(space) {
  const keys = Object.keys(space);
  const idx = keys.map(() => 0);
  for (;;) {
    yield Object.fromEntries(keys.map((k, i) => [k, space[k][idx[i]]]));
    let i = keys.length - 1;
    while (i >= 0 && ++idx[i] === space[keys[i]].length) idx[i--] = 0;
    if (i < 0) return;
  }
}

function randomCombos(space, n, seed = 1) {
  let s = seed | 0;
  const rnd = () => { // mulberry32
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const seen = new Set();
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 50) {
    const c = Object.fromEntries(Object.entries(space).map(([k, v]) => [k, v[Math.floor(rnd() * v.length)]]));
    if (c.maxChange1h !== undefined && c.minChange1h >= c.maxChange1h) continue;
    const key = JSON.stringify(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Pickier momentum: only big, fast moves, with room to run. Robinhood's ~1.9% round trip means
// a trade has to win well above 2% on average, so this trades rarely and holds longer.
const MOMENTUM_SELECTIVE_SPACE = {
  minVolumeAccel: [3, 4, 6, 8],
  minBuyRatio: [0.6, 0.65, 0.7],
  minChange1h: [3, 5, 8],
  maxChange1h: [25, 40],
  breakoutLookbackMin: [240, 720, 1440],
  stopLossPct: [-8, -12, -18, -25],
  takeProfitPct: [20, 30, 50, 100],
  trailActivatePct: [12, 20, 30],
  trailPct: [8, 12, 15, 20],
  maxHoldHours: [24, 48, 96, 168],
  minScore: [60, 75, 85],
};
module.exports = { GRID_SPACE, MOMENTUM_SPACE, MOMENTUM_SELECTIVE_SPACE, gridCombos, randomCombos };
