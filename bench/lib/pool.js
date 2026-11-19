// Runs simulations on worker threads (one per CPU core by default).
const path = require('path');
const { Worker } = require('worker_threads');

class Pool {
  constructor(size, dataDir) {
    this.workers = Array.from({ length: size }, () => new Worker(path.join(__dirname, 'worker.js'), { workerData: { dataDir } }));
    this.idle = [...this.workers];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 0;
    for (const w of this.workers) {
      w.on('message', (msg) => {
        const done = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.idle.push(w);
        this.pump();
        done(msg);
      });
    }
  }
  run(job) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.queue.push({ ...job, id });
      this.pump();
    });
  }
  pump() {
    while (this.idle.length && this.queue.length) this.idle.pop().postMessage(this.queue.shift());
  }
  close() { for (const w of this.workers) w.terminate(); }
}

module.exports = { Pool };
