import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';
import { trpcCall } from './trpc.ts';

// Integration (real Docker): assistants.testStep runs a Code step in the caller's sandbox container with the engine's stdin shape ({"input", "steps"}), in JavaScript and Python,
// and reports stdout, stderr, errors and the time limit in plain words. Same stack as flows-docker.test.ts (no agent needed). The pure steps are in assistant-tools.test.ts.
const TOKEN = 'teststep-token-teststep-token-0123456789';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-teststep-'));
process.env.HEFYN_SECRET = 'test-step-secret-test-step-secret-1234567';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

test('integration: testStep runs code in the sandbox', { skip, timeout: 600_000 }, async (t) => {
  const stack = await startStack(t, { run, token: TOKEN });
  process.env.HEFYN_RUNNER_URL = stack.runnerUrl;
  const { Hono } = await import('hono');
  const { db } = await import('../src/server/appdb.ts');
  const { auth } = await import('../src/server/auth.ts');
  const { api } = await import('../src/server/api.ts');
  const vault = await import('../src/server/vault.ts');
  vault.setTeamKey(vault.newKey());
  const app = new Hono().route('/api', api);
  const r = await auth.api.signUpEmail({ body: { name: 'a', email: 'a@x.test', password: 'password-12345' } });
  db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, 'admin')").run(r.user.id);
  const cookie = (await auth.api.signInEmail({ body: { email: 'a@x.test', password: 'password-12345' }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  vault.rememberUserKey(r.user.id, vault.newKey());
  const node = (id: string, type: string, config: Record<string, any> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
  const step = async (code: Record<string, any>, input: object = { start: { text: 'Ann', files: [] }, prev: { text: 'Hello', json: { n: 2 } } }) => {
    const flow = { version: 1, nodes: [node('start', 'trigger.chat'), node('c', 'code', code), node('reply', 'output.reply', { text: 'x' })], edges: [] };
    const res = await trpcCall((p, i) => app.request(p, i), cookie, 'assistants.testStep', { flow, nodeId: 'c', input }, true);
    assert.equal(res.status, 200, res.error ?? '');
    return res.json;
  };

  const js = await step({ language: 'javascript', source: "const { input, steps } = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); console.error('note'); console.log(JSON.stringify({ who: input.text, prev: steps.prev.json.n, keys: Object.keys(steps) }));" });
  assert.equal(js.ok, true, JSON.stringify(js));
  assert.deepEqual(js.output.json, { who: 'Ann', prev: 2, keys: ['prev'] }); // the trigger is `input`, the step itself and the trigger are not in `steps`
  assert.equal(js.stderr.trim(), 'note'); assert.match(js.stdout, /"who":"Ann"/); assert.ok(js.ms >= 0);

  const py = await step({ language: 'python', source: 'import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({"n": d["steps"]["prev"]["json"]["n"] * 2}))' });
  assert.deepEqual(py.output.json, { n: 4 });

  const boom = await step({ language: 'python', source: 'raise ValueError("bad thing")' });
  assert.equal(boom.ok, false); assert.match(boom.error, /ValueError: bad thing/); assert.match(boom.stderr, /Traceback/);

  const text = await step({ language: 'javascript', source: 'console.log("not json")' });
  assert.equal(text.ok, false); assert.match(text.error, /print its result as JSON/); assert.equal(text.stdout.trim(), 'not json');

  const slow = await step({ language: 'javascript', source: 'setTimeout(() => {}, 20000)', timeoutSec: 1 });
  assert.equal(slow.ok, false); assert.match(slow.error, /longer than 1 seconds/);

  const empty = await step({ language: 'javascript', source: '' });
  assert.equal(empty.ok, true); assert.equal(empty.output.json, undefined);
});
