// Start the bots: pm2 start ecosystem.config.js
const grid = require('./sol-grid/ecosystem.config.js').apps[0];
const momentum = require('./solana-momentum/ecosystem.config.js').apps[0];
const stocks = require('./stock-trend/ecosystem.config.js').apps[0];
const larp = require('./day-larp/ecosystem.config.js').apps[0];
module.exports = { apps: [grid, momentum, stocks, larp] };
