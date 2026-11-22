// pm2 start day-larp/ecosystem.config.js
module.exports = { apps: [{ name: 'day-larp', cwd: __dirname, script: 'src/larp.js', autorestart: true, restart_delay: 60000, max_restarts: 20 }] };
