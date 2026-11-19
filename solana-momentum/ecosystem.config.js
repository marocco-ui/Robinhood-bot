const path = require('path');

module.exports = {
  apps: [
    {
      name: 'solana-momentum-bot',
      script: path.join(__dirname, 'src', 'trader.js'),
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 15000,
      kill_timeout: 30000,
      wait_ready: true,
      listen_timeout: 60000,
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
