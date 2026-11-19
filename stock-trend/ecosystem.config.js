// pm2 start stock-trend/ecosystem.config.js   (keeps the bot running and restarts it after a crash)
module.exports = {
  apps: [{
    name: 'stock-trend',
    cwd: __dirname,
    script: 'src/bot.js',
    autorestart: true,
    restart_delay: 60000,
    max_restarts: 20,
    kill_timeout: 10000,
  }],
};
