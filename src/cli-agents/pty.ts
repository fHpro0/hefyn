import type { Proc } from './attach.ts';

// One process in a PTY in the sandbox, shared by whoever looks at it: scrollback for a late viewer, live output to every viewer, input from any of them.
// (The chat view types into the same PTY the terminal view shows: docs/WRAPPER.md.)

export const SCROLLBACK = 256 * 1024;
interface Viewer { data(b: Buffer): void; end(): void }

export class Pty {
  private scroll: Buffer[] = [];
  private size = 0;
  private viewers = new Set<Viewer>();
  lastOutput = 0;
  active = Date.now();
  ended = false;
  /** Called with every chunk the process prints, and once when it ends. */
  onData?: (b: Buffer) => void;
  onEnd?: () => void;

  constructor(readonly proc: Proc) {
    proc.stream.on('data', (b: Buffer) => {
      this.lastOutput = Date.now();
      this.scroll.push(b); this.size += b.length;
      while (this.size > SCROLLBACK && this.scroll.length) { const over = this.size - SCROLLBACK, f = this.scroll[0]!; if (f.length <= over) { this.scroll.shift(); this.size -= f.length; } else { this.scroll[0] = f.subarray(over); this.size -= over; } }
      for (const v of this.viewers) v.data(b);
      this.onData?.(b);
    });
    proc.stream.on('error', () => {});
    proc.stream.on('close', () => {
      if (this.ended) return;
      this.ended = true;
      for (const v of this.viewers) v.end();
      this.onEnd?.();
    });
  }
  get watching() { return this.viewers.size; }
  /** The scrollback first (as one chunk), then live output. `end` is called when the process ends. Returns the way to stop watching. */
  watch(first: (b: Buffer) => void, push: (b: Buffer) => void, end: () => void) {
    const v = { data: push, end };
    first(Buffer.concat(this.scroll));
    this.viewers.add(v); this.active = Date.now();
    return () => { this.viewers.delete(v); this.active = Date.now(); };
  }
  write(data: string | Buffer) { this.active = Date.now(); if (!this.ended) this.proc.stream.write(data); }
  async resize(cols: number, rows: number) { this.active = Date.now(); await this.proc.resize(cols, rows); }
  kill() { this.proc.stream.destroy(); }
}
