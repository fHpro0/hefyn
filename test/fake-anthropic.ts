import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Minimal Anthropic Messages API stand-in. Default script: the orchestrator (system prompt mentions
// "You orchestrate") delegates once to the `writer` agent via `task`, then answers; delegates just answer.
// Marker scripts (a marker anywhere in the request body selects one):
//   {{var:EMAIL_1}}  write then read /tmp/note.txt with the placeholder, then answer with it (privacy test)
//   FILETEST         orchestrator -> writer writes /files/x.txt -> orchestrator reads it back
//   HUBTEST          orchestrator delegates to the hub agent `hub-helper`
//   SHELLTEST        call bash (writes /files/out.txt, links /files/p -> /etc/passwd) when the tool exists, else say so
//   MCPTEST          call the MCP tool `lookup`, then answer
//   SLOW<ms>         delay the first delivery of that request body
export const requests: { model: string; system: string; raw: string; key: string }[] = [];

const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
const delayed = new Set<string>();

type Plan = { tool: string; input: object } | { text: string };

function plan(j: any, body: string, system: string): Plan {
  const results = j.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : [])).length;
  const orchestrator = system.includes('You orchestrate');
  if (body.includes('FILETEST')) {
    if (orchestrator) return results === 0 ? { tool: 'task', input: { agent: 'writer', description: 'file', prompt: 'FILETEST write x.txt' } } : results === 1 ? { tool: 'read', input: { path: '/files/x.txt' } } : { text: 'file check done' };
    return results === 0 ? { tool: 'write', input: { path: '/files/x.txt', content: 'hello-from-writer' } } : { text: 'written' };
  }
  if (body.includes('SHELLTEST')) {
    const hasBash = (j.tools ?? []).some((t: any) => t.name === 'bash');
    if (!hasBash) return { text: 'NO-BASH-TOOL tools=' + (j.tools ?? []).map((t: any) => t.name).sort().join(',') };
    return results === 0 ? { tool: 'bash', input: { command: 'echo shell-out > /files/out.txt && ln -sf /etc/passwd /files/p && id -u' } } : { text: 'SHELL-RAN' };
  }
  if (body.includes('HUBTEST')) {
    if (orchestrator) return results === 0 ? { tool: 'task', input: { agent: 'hub-helper', description: 'help', prompt: 'HUBTEST go' } } : { text: 'hub done' };
    return { text: 'hub helper here' };
  }
  if (body.includes('MCPTEST')) {
    const tool = (j.tools ?? []).find((t: any) => t.name.includes('lookup'))?.name;
    return results === 0 && tool ? { tool, input: {} } : { text: tool ? 'lookup done' : 'no mcp tool' };
  }
  if (body.includes('{{var:EMAIL_1}}')) {
    if (results === 0) return { tool: 'write', input: { path: '/tmp/note.txt', content: '{{var:EMAIL_1}} sk-ant-' + 'api03-ToolSideSecret0123456789abcdefXYZ' } };
    return results === 1 ? { tool: 'read', input: { path: '/tmp/note.txt' } } : { text: 'sent it to {{var:EMAIL_1}}' };
  }
  if (orchestrator && results === 0) return { tool: 'task', input: { agent: 'writer', description: 'haiku', prompt: 'Write a haiku about fruit.' } };
  return { text: 'apple, banana, cherry' };
}

export function startFake(port = 0, host = '127.0.0.1'): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      if (req.url?.endsWith('/models')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      const j = JSON.parse(body);
      const slow = /SLOW(\d+)/.exec(body);
      if (slow && !delayed.has(body)) { delayed.add(body); await new Promise((r) => setTimeout(r, Number(slow[1]))); }
      const system = (j.system ?? []).map((s: any) => s.text).join('\n');
      requests.push({ model: j.model, system, raw: body, key: String(req.headers['x-api-key'] ?? req.headers.authorization ?? '') });
      const p = plan(j, body, system);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }));
      if ('tool' in p) {
        res.write(ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu' + Math.random().toString(36).slice(2, 8), name: p.tool, input: {} } }));
        const json = JSON.stringify(p.input);
        for (const part of [json.slice(0, 20), json.slice(20)]) res.write(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: part } })); // split mid-way: placeholders may straddle deltas
      } else {
        res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
        res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: p.text } }));
      }
      res.write(ev('content_block_stop', { index: 0 }));
      res.write(ev('message_delta', { delta: { stop_reason: 'tool' in p ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } }));
      res.write(ev('message_stop', {}));
      res.end();
    });
  });
  return new Promise((ok) => server.listen(port, host, () => ok({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
}
