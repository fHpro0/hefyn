import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containerFs, dropSandbox, setFreeRoom, setStopChat } from '../src/server/container-fs.ts';
import { runnerSeed } from '../src/cli-agents/host.ts';

// Every path that creates a sandbox (the Assistant seed, exec, attach) frees an idle chat at the runner's per-user cap and retries; a deleted chat stops its process and sandbox.
const CAP = { error: 'too many sandbox containers for this user' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('the Assistant seed frees an idle chat at the cap and then goes through', async () => {
  let full = true, freed = 0;
  setFreeRoom(() => { freed++; full = false; return true; });
  const seen: string[] = [];
  const f = (async (url: string, init: any) => {
    seen.push(`${init.method} ${new URL(url).pathname}`);
    if (url.endsWith('/sandboxes')) return full ? reply(429, CAP) : reply(200, { id: 'abc' });
    return reply(200, { stdout: '', stderr: '', exitCode: 0, truncated: false });
  }) as any;
  await runnerSeed({ runnerUrl: 'http://r', token: 't', fetch: f, retryMs: 1 })('u', 'c', [{ path: '/x', text: 'y' }]);
  assert.equal(freed, 1);
  assert.deepEqual(seen, ['POST /sandboxes', 'POST /sandboxes', 'POST /sandboxes/abc/exec']);
});

test('nothing to free: the cap error is passed on', async () => {
  setFreeRoom(() => false);
  const fs = containerFs({ userId: 'u', conversationId: 'c', runnerUrl: 'http://r', fetch: (async () => reply(429, CAP)) as any, retryMs: 1 });
  await assert.rejects(fs.run(['true']), /too many sandbox containers/);
});

test('a deleted chat stops its process and then its sandbox', async () => {
  const stopped: string[] = [], calls: string[] = [];
  setStopChat((_u, c) => void stopped.push(c));
  await dropSandbox('u', 'c1', { runnerUrl: 'http://r', token: 't', fetch: (async (url: string, init: any) => { calls.push(`${init.method} ${new URL(url).pathname}`); return reply(200, { ok: true }); }) as any });
  assert.deepEqual(stopped, ['c1']);
  assert.match(calls[0], /^DELETE \/sandboxes\/[0-9a-f]{16}$/);
});
