import { parentPort } from 'node:worker_threads';
import { EntropyDetector } from './entropy.ts';
import { guard } from './guard.ts';
import { RegexDetector } from './rules.ts';

// worker_thread for everything that is CPU-bound on user text and not the model: regex rules, entropy, guard. A pathological input
// can only stall this thread; pool.ts kills it on timeout. Protocol: {id, kind: 'detect' | 'guard', text} -> {id, result} | {id, error}.
const detectors = [new RegexDetector(), new EntropyDetector()];
parentPort!.on('message', ({ id, kind, text }: { id: number; kind: string; text: string }) => {
  try {
    parentPort!.postMessage({ id, result: kind === 'guard' ? guard(text) : detectors.flatMap((d) => d.detect(text)) });
  } catch (e) { parentPort!.postMessage({ id, error: (e as Error).message }); }
});
