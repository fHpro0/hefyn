// Stand-in for detect-worker.ts: a "pathological" text (contains SPIN) hangs the thread forever, anything else answers at once.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, text }) => {
  if (text.includes('SPIN')) for (;;) { /* stuck in a regex, say */ }
  parentPort.postMessage({ id, result: [] });
});
