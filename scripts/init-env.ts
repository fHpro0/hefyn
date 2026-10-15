// `bun run init`: create .env from .env.example if missing and replace every `dev-only…` secret with a random one.
// Never overwrites real values. Prints which keys were generated.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const example = '.env.example', target = '.env';
if (!existsSync(example)) { console.error(`${example} not found: run this from the project root`); process.exit(1); }
const created = !existsSync(target);
const lines = readFileSync(created ? example : target, 'utf8').split('\n');
const generated: string[] = [];
const out = lines.map((line) => {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m || !(m[2].startsWith('dev-only') || (m[2] === '' && /SECRET|TOKEN/.test(m[1])))) return line;
  generated.push(m[1]);
  return `${m[1]}=${randomBytes(32).toString('hex')}`;
});
writeFileSync(target, out.join('\n'));
chmodSync(target, 0o600);
console.log(`${created ? 'created' : 'updated'} ${target} (mode 600)${generated.length ? `; generated: ${generated.join(', ')}` : '; nothing to generate, existing values kept'}`);
