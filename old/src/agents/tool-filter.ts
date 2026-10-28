// Which tools an Assistant has turned off (flow.tools.disabled, docs/ASSISTANTS.md "Tools"), as the agent process applies it. Light on purpose: mount.ts imports it.
// Tool ids: `builtin:<tool name>` (a sandbox or data tool), `connector:<connector id>:<tool>`, `skill:<package id>`, `assistant:<assistant id>`.

export const TOOL_ID = /^(?:builtin|connector|skill|assistant):[\x21-\x7e]{1,200}$/;
export type Off = ReadonlySet<string>;
export const offOf = (flow?: { tools?: { disabled?: string[] } } | null): Set<string> => new Set(flow?.tools?.disabled ?? []);

/** The tool names of one connector that are off. */
export const offOfConnector = (off: Off, connectorId: string) => new Set([...off].filter((t) => t.startsWith(`connector:${connectorId}:`)).map((t) => t.slice(`connector:${connectorId}:`.length)));

/**
 * An MCP connection's fetch that hides some tools: they leave `tools/list` (JSON or event-stream answer) and a `tools/call` for one is answered with an error, without reaching the server.
 * Used because an agent function is synchronous and cannot ask the server for its tool names first (which Flue's own `tools` allowlist needs).
 */
export function hideTools(base: typeof fetch, hidden: ReadonlySet<string>): typeof fetch {
  const strip = (j: any) => { if (Array.isArray(j?.result?.tools)) j.result.tools = j.result.tools.filter((t: any) => !hidden.has(t?.name)); return j; };
  return async (input, init) => {
    let body: any;
    if (typeof init?.body === 'string') try { body = JSON.parse(init.body); } catch { /* not JSON-RPC */ }
    if (body?.method === 'tools/call' && hidden.has(body.params?.name)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `The tool "${body.params.name}" is turned off for this Assistant.` } }), { headers: { 'content-type': 'application/json' } });
    }
    const res = await base(input, init);
    if (body?.method !== 'tools/list') return res;
    const text = await res.text();
    const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
    const one = (s: string) => { try { return JSON.stringify(strip(JSON.parse(s))); } catch { return s; } };
    const out = sse ? text.split('\n').map((l) => (l.startsWith('data:') ? `data: ${one(l.slice(5).trim())}` : l)).join('\n') : one(text);
    const headers = new Headers(res.headers);
    for (const h of ['content-length', 'content-encoding']) headers.delete(h); // fetch has decoded the body
    return new Response(out, { status: res.status, statusText: res.statusText, headers });
  };
}
