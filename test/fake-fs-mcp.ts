import http from 'node:http';
import { posix } from 'node:path';
import type { AddressInfo } from 'node:net';

// Tiny MCP server (streamable HTTP, JSON responses) with the official filesystem server's tool names, rooted at /data.
// `readOnly` leaves out write_file, create_directory and move_file.
export function startFakeFsMcp(o: { readOnly?: boolean } = {}): Promise<{ url: string; files: Map<string, string | null>; close: () => void }> {
  const files = new Map<string, string | null>([['/data', null]]); // path -> text, null = directory
  const names = ['list_allowed_directories', 'list_directory', 'list_directory_with_sizes', 'read_text_file', 'get_file_info', ...(o.readOnly ? [] : ['write_file', 'create_directory', 'move_file'])];
  const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  const inside = (p: string) => { const n = posix.normalize(String(p)); return n === '/data' || n.startsWith('/data/') ? n : undefined; };
  function call(name: string, a: any) {
    if (name === 'list_allowed_directories') return text('Allowed directories:\n/data');
    const p = inside(a.path ?? a.source);
    if (!p) return text('Access denied - path outside allowed directories', true);
    switch (name) {
      case 'list_directory': case 'list_directory_with_sizes': {
        if (files.get(p) !== null) return text(`ENOENT: no such file or directory, scandir '${p}'`, true);
        return text([...files.keys()].filter((k) => k !== p && posix.dirname(k) === p).map((k) => files.get(k) === null ? `[DIR] ${posix.basename(k)}` : name === 'list_directory' ? `[FILE] ${posix.basename(k)}` : `[FILE] ${posix.basename(k).padEnd(30)} ${(Buffer.byteLength(files.get(k)!) / 1024).toFixed(2)} KB`).join('\n'));
      }
      case 'read_text_file': { const c = files.get(p); return c == null ? text(`ENOENT: no such file or directory, open '${p}'`, true) : text(c); }
      case 'get_file_info': { const c = files.get(p); return c === undefined ? text('ENOENT: no such file or directory', true) : text(`size: ${c === null ? 0 : Buffer.byteLength(c)}\nmodified: Wed Oct 14 2026 10:00:00 GMT+0000\nisDirectory: ${c === null}\nisFile: ${c !== null}`); }
      case 'write_file': files.set(p, String(a.content)); return text(`Successfully wrote to ${p}`);
      case 'create_directory': { let d = p; while (d.length >= 5 && !files.has(d)) { files.set(d, null); d = posix.dirname(d); } return text(`Successfully created directory ${p}`); }
      case 'move_file': { const to = inside(a.destination); if (!to) return text('Access denied', true); if (files.has(to)) return text('Destination already exists', true); for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) { files.set(to + k.slice(p.length), files.get(k)!); files.delete(k); } return text('moved'); }
    }
    return text('unknown tool', true);
  }
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(405).end();
      const m = JSON.parse(raw);
      if (m.id === undefined) return void res.writeHead(202).end();
      const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-fs', version: '1' } }
        : m.method === 'tools/list' ? { tools: names.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }
        : m.method === 'tools/call' ? (names.includes(m.params.name) ? call(m.params.name, m.params.arguments ?? {}) : text('unknown tool', true))
        : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, files, close: () => { server.close(); server.closeAllConnections(); } })));
}
