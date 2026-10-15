import { SandboxDiedError, sandboxFromDriver, type Sandbox, type SandboxDriver, type SandboxFactory } from '@flue/runtime';
import { ContainerFsError, RunnerDownError, cleanPath, containerFs, type ContainerSandboxOptions } from './container-fs.ts';

// Flue sandbox backed by a per-conversation container (see container-fs.ts and docs/SANDBOX.md).
export * from './container-fs.ts';

const QUOTA_MESSAGE = 'storage quota exceeded: delete files in /files or /tmp before running more commands';
const died = (e: unknown) => (e instanceof RunnerDownError ? new SandboxDiedError({ operation: 'exec', reason: 'probe_silent' }) : e);
const guarded = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => { try { return await f(...a); } catch (e) { throw died(e); } };

export function containerSandbox(opts: ContainerSandboxOptions): Sandbox {
  const fs = containerFs(opts);
  const writeFile = async (p: string, c: string | Uint8Array) => { if (await opts.overQuota?.()) throw new ContainerFsError('ENOSPC', QUOTA_MESSAGE); return fs.writeFile(p, c); };
  const driver: SandboxDriver = {
    readFile: guarded(fs.readFile), readFileBuffer: guarded(fs.readFileBuffer), writeFile: guarded(writeFile), stat: guarded(fs.stat),
    readdir: guarded(fs.readdir), exists: guarded(fs.exists), mkdir: guarded(fs.mkdir), rm: guarded(fs.rm),
    async exec(command, o) {
      if (await opts.overQuota?.()) return { stdout: '', stderr: QUOTA_MESSAGE, exitCode: 1 };
      const r = await guarded(fs.run)(command, { cwd: o?.cwd ? cleanCwd(o.cwd) : '/files', env: o?.env, timeoutMs: o?.timeoutMs, signal: o?.signal });
      const notes = [r.timedOut ? `[command timed out after ${o?.timeoutMs} ms]` : '', r.truncated ? '[output truncated]' : ''].filter(Boolean).join('\n');
      return { stdout: r.stdout, stderr: notes ? `${r.stderr}${r.stderr && !r.stderr.endsWith('\n') ? '\n' : ''}${notes}` : r.stderr, exitCode: r.exitCode };
    },
  };
  return sandboxFromDriver(driver, '/files');
}
const cleanCwd = (c: string) => cleanPath(c);

/** Factory for `useSandbox(...)`: the container starts on first use; default Flue tools (bash, grep, glob, read, write, edit) apply. */
export const containerSandboxFactory = (opts: ContainerSandboxOptions): SandboxFactory => ({ createSandbox: async () => containerSandbox(opts) });
