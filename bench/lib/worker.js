// Worker thread: loads candles once, then runs simulations on request.
const { parentPort, workerData } = require('worker_threads');
const { loadDir } = require('./data');
const { simulateGrid, simulateMomentum } = require('./sim');

const { dataDir } = workerData;
const cache = {};
function series(interval) {
  if (!cache[interval]) cache[interval] = loadDir(dataDir, interval);
  return cache[interval];
}

parentPort.on('message', async (job) => {
  try {
    let res;
    if (job.bot === 'grid') {
      res = await simulateGrid(series(job.interval).SOL, job.params, { ...job.opts, sampleEvery: 1e12 });
    } else {
      res = await simulateMomentum(series(job.interval), job.params, { ...job.opts, sampleEvery: 1e12 });
    }
    parentPort.postMessage({ id: job.id, ok: true, params: job.params, stats: res.stats, cfg: res.cfg });
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, params: job.params, error: err.message });
  }
});
