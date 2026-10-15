// Child process of sqlite-contention.test.ts: one of the writers sharing app.db.
const [, , role, dir, seconds] = process.argv;
process.env.HEFYN_DATA_DIR = dir;
process.env.HEFYN_SECRET = 'contention-test-secret-contention-1234';
const { db } = await import('../src/server/appdb.ts');
const end = Date.now() + Number(seconds) * 1000;
let ok = 0;
const errors: string[] = [];
const guard = async (f: () => unknown) => { try { await f(); ok++; } catch (e) { errors.push(String((e as Error).message)); } };
const tag = `${role}${process.pid}`;

if (role === 'agent') { // the agent's runtime/state writes, far more often than the real one
  while (Date.now() < end) { await guard(() => db.prepare('UPDATE runtime SET running_tasks = ? WHERE id = 1').run(ok % 5)); await new Promise((r) => setTimeout(r, 2)); }
} else if (role === 'usage') {
  while (Date.now() < end) { await guard(() => db.prepare('INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)').run('u', 'u_u_01', 'p', 'm', 1, 1, 0, 0, 0, new Date().toISOString())); await new Promise((r) => setTimeout(r, 2)); }
} else if (role === 'users') { // Better Auth user creation: deferred read-then-write transactions are what used to fail
  const { auth } = await import('../src/server/auth.ts');
  for (let i = 0; Date.now() < end; i++) await guard(() => auth.api.signUpEmail({ body: { name: tag, email: `${tag}-${i}@x.test`, password: 'password-12345' } }));
}
console.log(JSON.stringify({ role, ok, errors: errors.slice(0, 5), errorCount: errors.length }));
process.exit(0);
export {};
