import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentManifest, AgentSpecError } from '../src/modules/agent-manifest.ts';

// The retired `mcp` field (hefyn's own MCP server at /mcp) is gone: a manifest that still has it is refused, and {{hefynMcpUrl}} is no placeholder any more.
test('the manifest: the retired mcp field and {{hefynMcpUrl}} are refused; commandsDir stays under the config dir', () => {
  const base = { kind: 'agent', id: 'acme', name: 'Acme', description: 'x', distribution: { registry: 'acme' }, api: 'anthropic', asksBeforeActing: true, launch: { npm: { package: 'acme-acp', bin: 'acme-acp' } },
    terminal: { command: 'exec acme' }, config: { dir: '/tmp/.acme', instructionsFile: 'AGENTS.md', skillsDir: '/tmp/.acme/skills', mcpConfig: 'x' } };
  const mcp = { path: '/tmp/.acme/mcp.json', format: 'json-merge', content: { servers: { hefyn: { url: '{{hefynMcpUrl}}' } } } };
  assert.doesNotThrow(() => parseAgentManifest(base));
  const refused = (m: unknown, re: RegExp) => assert.throws(() => parseAgentManifest(m), (e: any) => e instanceof AgentSpecError && re.test(e.message));
  refused({ ...base, mcp }, /./);
  refused({ ...base, files: [mcp] }, /unknown placeholder \{\{hefynMcpUrl\}\}/);
  refused({ ...base, env: { ACME_NOTE: '{{hefynMcpUrl}}' } }, /unknown placeholder/);
  refused({ ...base, config: { ...base.config, commandsDir: '/tmp/elsewhere/commands' } }, /commandsDir: must be a path under \/tmp\/\.acme/);
});
