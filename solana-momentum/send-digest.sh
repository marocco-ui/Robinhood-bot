#!/bin/bash
# Trading digest built from the bots' real status files (the old version printed hardcoded numbers).
BOTS="$(cd "$(dirname "$0")/.." && pwd)"
node -e '
const fs = require("fs");
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const ago = (t) => t ? Math.round((Date.now() - Date.parse(t)) / 60000) + " min ago" : "never";
const m = read(process.argv[1] + "/solana-momentum/data/status.json");
const g = read(process.argv[1] + "/sol-grid/data/status.json");
console.log("📊 Trading digest " + new Date().toLocaleString());
if (m) {
  console.log("\nMomentum (" + m.mode + "), updated " + ago(m.updatedAt));
  console.log("  Equity $" + m.equity + " (" + m.returnPct + "%), realized $" + m.realizedPnl + ", trades " + m.trades);
  for (const p of m.openPositions) console.log("  " + p.symbol + " " + p.pnlPct + "%");
  if (m.halted) console.log("  HALTED: " + m.halted.reason);
} else console.log("\nMomentum: no status yet");
if (g) {
  console.log("\nGrid (" + g.mode + "), updated " + ago(g.updatedAt));
  console.log("  SOL $" + g.price + (g.inRange ? "" : " (OUT OF RANGE)") + ", realized $" + g.realizedPnl + ", round trips " + g.roundTrips);
  console.log("  Holding " + g.gridQty + " SOL, unrealized $" + g.unrealizedPnl);
  if (g.halted) console.log("  HALTED: " + g.halted.reason);
} else console.log("\nGrid: no status yet");
' "$BOTS"
