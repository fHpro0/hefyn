import { Worker } from 'node:worker_threads';
import { RedactError } from './spans.ts';

// A small pool of worker threads for CPU-bound jobs on untrusted text. One job per worker at a time; the rest wait in a bounded queue.
// A job that exceeds the hard timeout (or crashes its worker) fails, its worker is terminated and replaced; other jobs carry on.
export interface PoolOptions { file: string; size?: number; timeoutMs?: number; maxQueue?: number }
interface Job { msg: object; resolve: (v: any) => void; reject: (e: Error) => void }
interface Slot { worker?: Worker; job?: Job; timer?: NodeJS.Timeout; id: number }

export class WorkerPool {
  private slots: Slot[];
  private queue: Job[] = [];
  private seq = 0;
  private stopped = false;
  private o: Required<PoolOptions>;

  constructor(o: PoolOptions) {
    this.o = { size: 2, timeoutMs: 10_000, maxQueue: 256, ...o };
    this.slots = Array.from({ length: Math.max(1, this.o.size) }, () => ({ id: 0 }));
  }

  run<T = any>(msg: object): Promise<T> {
    if (this.stopped) return Promise.reject(new RedactError('redaction engine stopped'));
    if (this.queue.length >= this.o.maxQueue) return Promise.reject(new RedactError('redaction is overloaded (queue full)'));
    return new Promise((resolve, reject) => { this.queue.push({ msg, resolve, reject }); this.pump(); });
  }

  private pump() {
    for (const s of this.slots) {
      if (s.job || !this.queue.length) continue;
      const job = this.queue.shift()!;
      s.job = job;
      const w = (s.worker ??= this.spawn(s));
      const id = (s.id = ++this.seq);
      s.timer = setTimeout(() => this.fail(s, w, 'redaction timed out'), this.o.timeoutMs);
      w.postMessage({ ...job.msg, id });
    }
  }

  private spawn(s: Slot): Worker {
    const w = new Worker(this.o.file);
    w.on('message', (m: { id: number; result?: unknown; error?: string }) => {
      if (s.worker !== w || m.id !== s.id || !s.job) return;
      const job = s.job;
      clearTimeout(s.timer); s.job = undefined;
      m.error !== undefined ? job.reject(new RedactError(m.error)) : job.resolve(m.result);
      this.pump();
    });
    w.on('error', (e: Error) => this.fail(s, w, `redaction worker crashed: ${e.message}`));
    w.on('exit', (code) => this.fail(s, w, `redaction worker exited (${code})`));
    w.unref(); // after the listeners (they ref the port): idle workers must not keep the process alive; a pending job's timeout timer does
    return w;
  }

  private fail(s: Slot, w: Worker, why: string) {
    if (s.worker !== w) return;
    clearTimeout(s.timer);
    s.worker = undefined; // replaced lazily by the next job
    const job = s.job; s.job = undefined;
    void w.terminate();
    job?.reject(new RedactError(why));
    this.pump();
  }

  stop() {
    this.stopped = true;
    for (const s of this.slots) { const w = s.worker; if (w) this.fail(s, w, 'redaction engine stopped'); }
    for (const j of this.queue.splice(0)) j.reject(new RedactError('redaction engine stopped'));
  }
}
