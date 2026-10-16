import { Worker } from 'node:worker_threads';
import { GLINER_FILES, verifyModel } from './models.ts';
import type { ModelFile } from './models.ts';
import { RedactError } from './spans.ts';
import { workerPath } from './worker-path.ts';
import type { Span } from './spans.ts';

// Supervisor of the GLiNER worker thread (main side). State: `loading` (model files not there yet / worker starting),
// `ready`, `error` (bad files, worker crashed or hung). Anything but `ready` rejects detect(): requests fail closed.
// A dead or hung worker is respawned with backoff; model files are verified (size + SHA-256) before every spawn.

const defaultWorker = () => workerPath('gliner-worker');

export type GlinerState = 'loading' | 'ready' | 'error';
export interface ClientOptions {
  dir: string;
  files?: ModelFile[];
  workerFile?: string;
  /** Per request; a request that exceeds it fails and the worker is restarted. */
  timeoutMs?: number;
  /** Requests in flight (running + queued); more are refused. */
  maxQueue?: number;
  /** Backoff after a crash: min doubles up to max. */
  backoffMs?: [number, number];
  /** Poll interval while the model files are missing. */
  pollMs?: number;
}

export class GlinerClient {
  readonly name = 'gliner';
  state: GlinerState = 'loading';
  error = '';
  private worker?: Worker;
  private pending = new Map<number, { resolve: (s: Span[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private stopped = false;
  private wake?: () => void;
  private o: Required<Omit<ClientOptions, 'files' | 'workerFile'>> & { files: ModelFile[]; workerFile: string };

  constructor(o: ClientOptions) {
    this.o = { files: GLINER_FILES, workerFile: defaultWorker(), timeoutMs: 60_000, maxQueue: 64, backoffMs: [500, 30_000], pollMs: 2000, ...o };
    void this.supervise();
  }

  private sleep(ms: number) { return new Promise<void>((r) => { const t = setTimeout(r, ms).unref(); this.wake = () => { clearTimeout(t); r(); }; }); }

  private async supervise() {
    let failures = 0;
    while (!this.stopped) {
      const v = await verifyModel(this.o.dir, this.o.files).catch((e: Error) => ({ ok: false as const, missing: false, error: e.message }));
      if (!v.ok) {
        this.state = v.missing ? 'loading' : 'error'; this.error = v.error;
        await this.sleep(v.missing ? this.o.pollMs : Math.max(this.o.pollMs, 10_000)); // web re-downloads a corrupt file; look again later
        continue;
      }
      this.state = 'loading'; this.error = '';
      const ranReady = await this.run();
      if (this.stopped) return;
      failures = ranReady ? 1 : failures + 1;
      const [min, max] = this.o.backoffMs;
      await this.sleep(Math.min(max, min * 2 ** (failures - 1)));
    }
  }

  /** One worker lifetime. Resolves (true when it had become ready) after it died; pending requests are rejected. */
  private run(): Promise<boolean> {
    return new Promise((resolve) => {
      let ready = false, done = false;
      const w = new Worker(this.o.workerFile, { workerData: { dir: this.o.dir } });
      this.worker = w;
      const end = (why: string) => {
        if (done) return;
        done = true;
        if (this.worker === w) this.worker = undefined;
        if (!this.stopped) { this.state = 'error'; this.error = why; }
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new RedactError(`detector \`gliner\` failed: ${why}`)); this.pending.delete(id); }
        void w.terminate();
        resolve(ready);
      };
      w.on('message', (m: any) => {
        if (m.type === 'ready') { ready = true; this.state = 'ready'; this.error = ''; return; }
        if (m.type === 'fatal') return end(`worker could not load the model: ${m.error}`);
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(new RedactError(`detector \`gliner\` failed: ${m.error}`)) : p.resolve(m.spans);
      });
      w.on('error', (e: Error) => end(`worker crashed: ${e.message}`));
      w.on('exit', (code) => end(`worker exited (${code})`));
      w.unref(); // after the listeners (they ref the port): the server keeps the process alive, tests and scripts can exit
      this.kill = (why) => end(why);
    });
  }
  private kill: (why: string) => void = () => {};

  detect(text: string): Promise<Span[]> {
    if (this.state !== 'ready' || !this.worker) return Promise.reject(new RedactError(`detector \`gliner\` is not ready (${this.state}${this.error ? `: ${this.error}` : ''})`));
    if (this.pending.size >= this.o.maxQueue) return Promise.reject(new RedactError('detector `gliner` is overloaded (request queue full)'));
    const id = ++this.seq, w = this.worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.kill(`request timed out after ${this.o.timeoutMs} ms`), this.o.timeoutMs); // a hung worker cannot be cancelled: restart it
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, text });
    });
  }

  stop() { this.stopped = true; this.kill('stopped'); this.wake?.(); }
}
