// Node built-ins only. Writes the config files hefyn's agent profile asks for (HEFYN_SEED, a JSON list; src/cli-agents/profiles.ts) before run-agent.sh execs the agent.
// {path, text}: the file is replaced. {path, json, force}: deep-merged into the existing file; force: the seed wins, else what is there already wins. Only under /tmp (and /claude-home: the config dir of Claude Code on the user's own account).
// {path, json, force, owns}: `owns` is the key path to an object whose entries are hefyn's (MCP servers); the ones it wrote earlier that are no longer in `json` are removed first.
// {path, sweep}: removes the subdirectories of `path` that hold a .hefyn-managed file (the skills of an earlier Assistant); with `files`: the files of `path` that hold the
// line <!-- hefyn-managed --> (slash commands). `--stdin`: the list comes from stdin
// instead (an Assistant's instructions and skills are too big for an environment variable; hefyn runs this through the runner's exec before the agent starts).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { // b wins; arrays and scalars are replaced
  if (!plain(a) || !plain(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) { if (k === '__proto__') continue; out[k] = k in a ? merge(a[k], v) : v; }
  return out;
};

const OWNED = '/tmp/.hefyn/owned.json'; // {path: [names]}: what hefyn's MCP seeds wrote into a shared config file
const source = process.argv[2] === '--stdin' ? readFileSync(0, 'utf8') : process.env.HEFYN_SEED;
for (const s of JSON.parse(source || '[]')) {
  const path = resolve(String(s.path));
  if (!path.startsWith('/tmp/') && !path.startsWith('/claude-home/')) throw new Error(`seed path outside /tmp and /claude-home: ${s.path}`);
  if (s.sweep === true && s.files === true) { // command files: those that hold the hefyn marker line
    if (existsSync(path)) for (const e of readdirSync(path, { withFileTypes: true })) if (e.isFile() && readFileSync(`${path}/${e.name}`, 'utf8').includes('<!-- hefyn-managed -->')) rmSync(`${path}/${e.name}`, { force: true });
    continue;
  }
  if (s.sweep === true) {
    if (existsSync(path)) for (const e of readdirSync(path, { withFileTypes: true })) if (e.isDirectory() && existsSync(`${path}/${e.name}/.hefyn-managed`)) rmSync(`${path}/${e.name}`, { recursive: true, force: true });
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (typeof s.text === 'string') { writeFileSync(path, s.text); continue; }
  let cur = {};
  try { cur = JSON.parse(readFileSync(path, 'utf8')); } catch { /* absent or unreadable: start over */ }
  if (!plain(cur)) cur = {};
  if (Array.isArray(s.owns)) { // entries hefyn wrote here earlier (recorded in OWNED) and the seed no longer has are removed; the user's own are never in the record
    const at = (o) => s.owns.reduce((x, k) => (plain(x) ? x[k] : undefined), o), mine = at(s.json), here = at(cur);
    let owned = {};
    try { owned = JSON.parse(readFileSync(OWNED, 'utf8')); } catch { /* none yet */ }
    // 'hefyn' is the retired MCP server older versions wrote (the /mcp URL no longer exists)
    if (plain(here)) for (const n of [...(owned[path] ?? []), 'hefyn']) if (n !== '__proto__' && !(plain(mine) && n in mine)) delete here[n];
    owned[path] = plain(mine) ? Object.keys(mine) : [];
    mkdirSync(dirname(OWNED), { recursive: true });
    writeFileSync(OWNED, JSON.stringify(owned));
  }
  writeFileSync(path, JSON.stringify(s.force ? merge(cur, s.json) : merge(s.json, cur), null, 2));
}
