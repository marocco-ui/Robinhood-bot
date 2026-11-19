// Token bucket. Robinhood allows ~100 requests/min per account, shared by every bot
// on that account, so each bot defaults to a slice of it.
class RateLimiter {
  constructor({ perMinute = 40, burst = 10 } = {}) {
    this.capacity = burst;
    this.tokens = burst;
    this.refillPerMs = perMinute / 60000;
    this.last = Date.now();
    this.queue = Promise.resolve();
  }

  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }

  take() {
    // Serialize waiters so they get tokens in order.
    this.queue = this.queue.then(async () => {
      for (;;) {
        this._refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    });
    return this.queue;
  }
}

module.exports = RateLimiter;
