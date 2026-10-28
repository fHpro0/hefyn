import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): an older Claude Code adapter is installed by the runner's installer, the update job brings it to the registry's version next to
// it, the version shown is Claude Code's own (read from the install), and the old version's files stay until the session that holds them is gone.
// Not covered here: a live ACP session across the update (session/load of the new version on the old session files): see docs/SANDBOX.md.
const TOKEN = 'cli-upd-token-cli-upd-token-cli-upd-token-0123456789';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cliupd-'));
process.env.HEFYN_SECRET = 'cli-upd-secret-cli-upd-secret-1234567890';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

test('integration: auto-update installs the registry version next to the old one, shows the real Claude Code version, removes the old one when unused', { skip, timeout: 1_800_000 }, async (t) => {
  const stack = await startStack(t, { run, token: TOKEN });
  const { docker, IMAGE, AGENTS, install } = stack;
  const inVolume = (cmd: string) => docker('run', '--rm', '-v', `${AGENTS}:/a:ro`, IMAGE, 'sh', '-c', cmd).trim();

  const { bundledRegistry, resetRegistryCache } = await import('../src/cli-agents/registry.ts');
  const inst = await import('../src/cli-agents/installed.ts');
  const { profileOf } = await import('../src/cli-agents/profiles.ts');
  const { db } = await import('../src/server/appdb.ts');

  const OLD = '2.1.308', NEW = '2.1.310'; // two real versions of the package
  const claude = bundledRegistry().find((a) => a.id === 'claude-acp')!;
  const at = (v: string) => ({ ...claude, version: v, distribution: { npx: { package: `@anthropic-ai/claude-code@${v}` } } });
  // the ACP Registry and, on the same stand-in, npm's `latest` of Claude Code (registry.ts withClaudeCode): both say NEW
  const fakeRegistry = Bun.serve({ port: 0, fetch: (req: Request) => (new URL(req.url).pathname.includes('claude-code') ? Response.json({ version: NEW }) : Response.json({ version: '1.0.0', agents: [at(NEW)] })) });
  t.after(() => fakeRegistry.stop(true));
  process.env.HEFYN_ACP_REGISTRY_URL = `http://127.0.0.1:${fakeRegistry.port}/registry.json`;
  process.env.HEFYN_NPM_REGISTRY_URL = `http://127.0.0.1:${fakeRegistry.port}`;
  process.env.HEFYN_RUNNER_URL = stack.runnerUrl;
  resetRegistryCache();

  assert.deepEqual(await install(inst.installRequest(at(OLD), profileOf('claude-acp')!)), { state: 'ready' });
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles) VALUES ('claude-acp', ?, 'ready', 1, '[]')").run(OLD);
  const release = inst.lease('claude-acp', OLD); // a chat open on the old version

  await inst.checkUpdates(true);
  assert.equal(inst.rowOf('claude-acp')!.update_version, NEW);
  assert.ok(!('reason' in inst.launchable('u', 'claude-acp', true)), 'usable while the update installs');
  for (let i = 0; i < 600 && inst.rowOf('claude-acp')!.version !== NEW; i++) { await new Promise((r) => setTimeout(r, 1000)); await inst.reconcile(); }
  const row = inst.rowOf('claude-acp')!;
  assert.deepEqual([row.version, row.update_version, row.last_update_error ?? null], [NEW, null, null]);
  assert.equal((inst.launchable('u', 'claude-acp', true) as any).row.version, NEW, 'a new session starts on the new version');

  await inst.reconcile();
  assert.equal(inst.rowOf('claude-acp')!.cli_version, NEW, 'Claude Code\'s own version, read from the package in the install (there is no adapter)');
  const c = inst.mergeCatalog([at(NEW)], inst.allRows()).find((x) => x.id === 'claude-acp')!;
  assert.deepEqual([c.version, c.adapterVersion], [NEW, NEW]);

  assert.equal(inVolume(`test -x /a/claude-acp/${OLD}/node_modules/.bin/claude && echo there`), 'there', 'the open session\'s files are intact');
  release();
  await inst.reconcile();
  assert.equal(inVolume(`ls /a/claude-acp`), NEW, 'the old version is removed once nothing runs on it');
});
