import { parentPort, workerData } from 'node:worker_threads';
import { GlinerModel } from './gliner.ts';

// worker_thread: owns the ONNX session so inference never blocks the event loop. Protocol: {id, text} -> {id, spans} | {id, error};
// {type: 'ready'} once the model is loaded, {type: 'fatal', error} when it cannot be. A crash of this thread is handled by gliner-client.ts.
const port = parentPort!;
try {
  const model = await GlinerModel.load(workerData.dir);
  let chain: Promise<unknown> = Promise.resolve();
  port.on('message', ({ id, text }: { id: number; text: string }) => {
    chain = chain.then(() => model.detect(text)).then((spans) => port.postMessage({ id, spans }), (e) => port.postMessage({ id, error: (e as Error).message }));
  });
  port.postMessage({ type: 'ready' });
} catch (e) {
  port.postMessage({ type: 'fatal', error: (e as Error).message });
}
