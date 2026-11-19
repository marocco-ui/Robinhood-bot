// Optional Telegram alerts. Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from the environment
// (.env file). Never hardcode the token in scripts.
class Telegram {
  constructor({ token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID, prefix = '' } = {}) {
    this.token = token;
    this.chatId = chatId;
    this.prefix = prefix;
    this.enabled = Boolean(token && chatId);
    this.chain = Promise.resolve();
  }

  send(text, { silent = false } = {}) {
    const msg = this.prefix ? `${this.prefix} ${text}` : text;
    if (!this.enabled) {
      console.log(`[ALERT] ${msg.replace(/<[^>]+>/g, '')}`);
      return Promise.resolve(false);
    }
    // Serialize sends with a small gap so Telegram doesn't rate-limit us.
    this.chain = this.chain.then(async () => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.chatId, text: msg, parse_mode: 'HTML', disable_notification: silent }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) console.error(`[ALERT] Telegram ${res.status}: ${await res.text()}`);
      } catch (err) {
        console.error(`[ALERT] Telegram failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 1100));
    });
    return this.chain.then(() => true);
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { Telegram, esc };
