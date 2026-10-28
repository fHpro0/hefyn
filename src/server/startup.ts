// Startup validation shared by web and agent (import first). In production a missing, placeholder or short secret
// is a one-line error and a non-zero exit: no half-configured service.
// `env` indirection: `bun build` would otherwise inline NODE_ENV=development into the web bundle and the check would be dead code.
const env = process.env;
const prod = env.NODE_ENV === 'production';
const bad = (v: string | undefined) => !v || v.startsWith('dev-only') || v.length < 32;
if (prod) {
  const problems = ['HEFYN_SECRET', 'HEFYN_INTERNAL_TOKEN'].filter((k) => bad(env[k]));
  if (problems.length) {
    console.error(`[hefyn] ${problems.join(' and ')} missing, a dev-only placeholder, or shorter than 32 characters. Fix: run "bun run init" (creates .env with random values), or set them to 32+ random characters (openssl rand -hex 32).`);
    process.exit(1);
  }
}
if (!prod && (env.HEFYN_KEY_MODE || 'server') === 'server' && bad(env.HEFYN_SECRET)) console.warn('[hefyn] WARNING: server-held keys (the default) with a missing, dev-only or short HEFYN_SECRET: anyone who knows it can read all keys. Fine for local dev only.');
if (env.HEFYN_KEY_MODE && !['user', 'server'].includes(env.HEFYN_KEY_MODE)) {
  console.error(`[hefyn] HEFYN_KEY_MODE must be "user" or "server", not "${env.HEFYN_KEY_MODE}".`);
  process.exit(1);
}
export {};
