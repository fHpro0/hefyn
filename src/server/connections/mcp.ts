import { posix } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { connectorFor, listConnectors, openClient } from '../mcp.ts';
import { StorageError, maxUploadBytes } from '../storage.ts';
import { msg, oneChunk, segments, tooBig, type Adapter, type RemoteEntry, type StorageProvider } from './types.ts';

// A remote MCP server with filesystem-style tools (the official filesystem server's tool names) as a connection. This is how third parties extend Files:
// they run a server, the user adds it under Settings, MCP and picks it here. Reads return text, or bytes when the server answers base64 (image/audio/blob content).
// shortcut: every operation opens a fresh MCP session (connect + tools/list + call); listings carry no times, so change detection there is by size only.
const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
const mcpError = (text: string) => new StorageError(/ENOENT|not found|no such file/i.test(text) ? 404 : /exist/i.test(text) ? 409 : /outside|not allowed|denied|permission/i.test(text) ? 403 : 502, `storage server: ${text.slice(0, 200) || 'error'}`);

export function mcpAdapter(open: () => Promise<Client>): Adapter {
  interface S { tools: Set<string>; call(name: string, args: Record<string, unknown>): Promise<string>; bytes(name: string, args: Record<string, unknown>): Promise<Buffer>; root?: string }
  async function session<T>(f: (s: S) => Promise<T>): Promise<T> {
    let c: Client;
    try { c = await open(); } catch (e) { throw new StorageError(502, `storage server unreachable: ${msg(e)}`); }
    try {
      const raw = async (name: string, args: Record<string, unknown>) => {
        const r: any = await c.callTool({ name, arguments: args });
        const content: any[] = r.content ?? [];
        const text = content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
        if (r.isError) throw mcpError(text);
        return { text, content };
      };
      const s: S = {
        tools: new Set((await c.listTools()).tools.map((t) => t.name)),
        call: async (name, args) => (await raw(name, args)).text,
        async bytes(name, args) {
          const { text, content } = await raw(name, args);
          const bin = content.flatMap((x) => (typeof x.data === 'string' && x.type !== 'text' ? [x.data] : typeof x.resource?.blob === 'string' ? [x.resource.blob] : [])); // base64
          return bin.length ? Buffer.concat(bin.map((b) => Buffer.from(b, 'base64'))) : Buffer.from(content.map((x) => x.resource?.text).find((t) => typeof t === 'string') ?? text);
        },
      };
      return await f(s);
    } catch (e) {
      throw e instanceof StorageError ? e : new StorageError(502, `storage server error: ${msg(e)}`);
    } finally { await c.close().catch(() => {}); }
  }
  const need = (s: S, ...names: string[]) => names.find((n) => s.tools.has(n)) ?? (() => { throw new StorageError(403, `this storage server cannot do that (needs ${names.join(' or ')})`); })();
  // The server's first allowed directory is the root; without that tool paths start at "/".
  async function abs(s: S, rel: string, ...extra: string[]) {
    const segs = [...segments(rel), ...extra];
    if (s.root === undefined) {
      const t = s.tools.has('list_allowed_directories') ? (await s.call('list_allowed_directories', {})).split('\n').map((l) => l.trim()).find((l) => l && !/^allowed/i.test(l)) : undefined;
      s.root = t ?? '/';
    }
    return posix.join(s.root, ...segs);
  }
  const parse = (text: string): RemoteEntry[] => text.split('\n').flatMap((l) => {
    const m = /^\[(DIR|FILE)\]\s+(.*?)\s*$/.exec(l);
    if (!m) return [];
    const sz = m[1] === 'FILE' ? /^(.*?)\s+(\d+(?:\.\d+)?) (B|KB|MB|GB|TB)$/.exec(m[2]) : null;
    const name = sz ? sz[1] : m[2];
    return name ? [{ name, type: m[1] === 'DIR' ? 'dir' as const : 'file' as const, size: sz ? Math.round(Number(sz[2]) * UNITS[sz[3]]) : 0, mtime: '' }] : [];
  });
  const list = (s: S, rel: string) => abs(s, rel).then((p) => s.call(need(s, 'list_directory_with_sizes', 'list_directory'), { path: p })).then(parse);

  return {
    caps: () => session(async (s) => ({ write: s.tools.has('write_file'), mkdir: s.tools.has('create_directory'), rename: s.tools.has('move_file'), delete: s.tools.has('delete_file') || s.tools.has('delete'), etag: false })),
    list: (rel) => session((s) => list(s, rel)),
    stat: (rel) => session(async (s) => {
      const segs = segments(rel);
      if (!segs.length) return { name: '', type: 'dir' as const, size: 0, mtime: '' };
      if (s.tools.has('get_file_info')) {
        const t = await s.call('get_file_info', { path: await abs(s, rel) });
        const mod = Date.parse(/^modified:\s*(.+)$/im.exec(t)?.[1] ?? '');
        return { name: segs.at(-1)!, type: /^isDirectory:\s*true/im.test(t) ? 'dir' as const : 'file' as const, size: Number(/^size:\s*(\d+)/im.exec(t)?.[1]) || 0, mtime: Number.isNaN(mod) ? '' : new Date(mod).toISOString() };
      }
      const e = (await list(s, '/' + segs.slice(0, -1).join('/'))).find((x) => x.name === segs.at(-1));
      if (!e) throw new StorageError(404, 'not found');
      return e;
    }),
    read: (rel) => session(async (s) => {
      const bytes = await s.bytes(need(s, 'read_text_file', 'read_file'), { path: await abs(s, rel) });
      if (bytes.byteLength > maxUploadBytes()) throw tooBig();
      return oneChunk(bytes);
    }),
    write: (rel, data) => session(async (s) => {
      const tool = need(s, 'write_file');
      if (!segments(rel).length) throw new StorageError(400, 'is a directory');
      if (data.byteLength > maxUploadBytes()) throw tooBig();
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new StorageError(415, 'this storage only holds text files (the server has no binary write tool)'); }
      if (s.tools.has('create_directory')) await s.call('create_directory', { path: posix.dirname(await abs(s, rel)) }); // official tool is recursive
      await s.call(tool, { path: await abs(s, rel), content });
    }),
    mkdir: (rel) => session(async (s) => void await s.call(need(s, 'create_directory'), { path: await abs(s, rel) })),
    delete: (rel) => session(async (s) => {
      const tool = need(s, 'delete_file', 'delete');
      if (!segments(rel).length) throw new StorageError(403, 'the storage root cannot be deleted');
      await s.call(tool, { path: await abs(s, rel) });
    }),
    rename: (from, to) => session(async (s) => void await s.call(need(s, 'move_file'), { source: await abs(s, from), destination: await abs(s, to) })),
  };
}

export const mcpProvider: StorageProvider = {
  kind: 'mcp', label: 'MCP server (filesystem tools)',
  fields: (userId) => [{ name: 'connectorId', label: 'MCP server', type: 'select', required: true, hint: 'Add servers under Settings, MCP first.', options: listConnectors(userId).map((m) => ({ value: m.id, label: m.name })) }],
  async connect(c, _s, ctx) {
    const id = String(c.connectorId ?? '');
    if (!connectorFor(ctx.userId, id)) throw new StorageError(400, 'connectorId: pick one of your MCP servers');
    return mcpAdapter(() => openClient(ctx.userId, id));
  },
};
