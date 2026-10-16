// Stand-in for gliner-worker.ts in tests: same protocol, no model. "Alice" is the only entity it knows.
import { parentPort } from 'node:worker_threads';

if (process.env.FAKE_GLINER_FATAL) parentPort.postMessage({ type: 'fatal', error: 'no model' });
else {
  parentPort.on('message', ({ id, text }) => {
    if (text.includes('CRASH')) process.exit(3);
    if (text.includes('HANG')) return;
    const i = text.indexOf('Alice');
    parentPort.postMessage({ id, spans: i < 0 ? [] : [{ start: i, end: i + 5, label: 'person', detector: 'gliner', score: 0.9 }] });
  });
  parentPort.postMessage({ type: 'ready' });
}
