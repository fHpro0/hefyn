import { posix } from 'node:path';
import { SandboxOperationUnsupportedError, createEditTool, createReadTool, createWriteTool, sandboxFromDriver, type Sandbox, type SandboxDriver, type SandboxFactory } from '@flue/runtime';
import { withAddons } from './storage-addons.ts';
import { userFs } from './storage.ts';

// The Flue side of per-user storage (agent process only); the pure filesystem part is storage.ts.

/** Flue sandbox confined to the user's `/files` + this conversation's `/tmp`. No shell until the container sandbox. */
export function userSandbox(opts: { userId: string; conversationId: string }): Sandbox {
  const fs = withAddons(userFs(opts), opts.userId); // /files/<add-on> goes to the user's storage add-ons
  const driver: SandboxDriver = {
    readFile: fs.readFile, readFileBuffer: fs.readFileBuffer, writeFile: fs.writeFile, stat: fs.stat,
    readdir: fs.readdir, exists: fs.exists, mkdir: fs.mkdir, rm: fs.rm,
    exec: async () => { throw new SandboxOperationUnsupportedError({ operation: 'exec', provider: 'hefyn user storage', options: ['any command (shell commands come with the container sandbox)'] }); },
  };
  return sandboxFromDriver(driver, '/files');
}

/**
 * Factory for `useSandbox(...)`. The default grep/glob/bash tools shell out via exec, so they are replaced by
 * read/write/edit plus a small `list` tool (the documented pattern for exec-less sandboxes).
 */
export function userSandboxFactory(opts: { userId: string; conversationId: string }): SandboxFactory {
  return {
    createSandbox: async () => userSandbox(opts),
    tools: (sandbox) => [createReadTool(sandbox), createWriteTool(sandbox), createEditTool(sandbox), listTool(sandbox) as any],
  };
}

function listTool(sandbox: Sandbox) {
  return {
    name: 'list',
    label: 'List Files',
    description: 'List files and directories. Paths: /files (persistent; connected storage add-ons appear as folders in it) and /tmp (scratch for this conversation). Set recursive to walk subdirectories.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: [] },
    async execute(_id: string, params: { path?: string; recursive?: boolean }) {
      const out: string[] = [];
      const walk = async (dir: string) => {
        for (const name of await sandbox.readdir(dir)) {
          if (out.length >= 500) return;
          const p = posix.join(dir, name);
          const isDir = (await sandbox.stat(p).catch(() => null))?.isDirectory;
          out.push(isDir ? p + '/' : p);
          if (isDir && params.recursive) await walk(p);
        }
      };
      await walk(sandbox.resolvePath(params.path || '/'));
      return { content: [{ type: 'text' as const, text: out.join('\n') || '(empty)' }], details: {} };
    },
  };
}

