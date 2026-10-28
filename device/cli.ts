import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

// The laptop side of docs/DEVICES.md: `bun run device pair <server-url>`, `status`, `unpair`.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters, so `byte & 31` is uniform

export const newCode = () => Array.from(randomBytes(8), (b) => ALPHABET[b & 31]).join('');
export const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
/** The secret travels as a bearer token: https only, except for a server on this machine. */
export function serverUrl(s: string): string {
  const u = new URL(s);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('The server URL must be https (http only for localhost).');
  return u.origin;
}

export function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv;
  const i = rest.indexOf('--name');
  const name = (i >= 0 ? rest[i + 1] : undefined) || hostname().replace(/\.local$/, '');
  return { cmd, arg: rest.find((a, j) => !a.startsWith('--') && (i < 0 || j !== i + 1)), name };
}

type Config = { server: string; secret: string; name: string };
const configPath = () => process.env.HEFYN_DEVICE_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hefyn', 'device.json');
const load = (): Config | undefined => existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), 'utf8')) : undefined;
function save(c: Config) {
  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(c), { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}
const die = (m: string): never => { console.error(m); process.exit(1); };
const self = (c: Pick<Config, 'server' | 'secret'>, method = 'GET') => fetch(`${c.server}/api/devices/self`, { method, headers: { authorization: `Bearer ${c.secret}` } });

async function pair(url: string | undefined, name: string) {
  if (load()) die('This computer is already paired. Run `bun run device unpair` first.');
  if (!url) die('Usage: bun run device pair <server-url> [--name <name>]');
  const server = serverUrl(url!);
  const secret = randomBytes(32).toString('base64url'), secretHash = createHash('sha256').update(secret).digest('hex');
  let code = '', expiresAt = '';
  for (let i = 0; i < 3 && !expiresAt; i++) {
    code = newCode();
    const r = await fetch(`${server}/api/devices/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, code, secretHash }) });
    if (r.status === 201) expiresAt = ((await r.json()) as { expiresAt: string }).expiresAt;
    else if (r.status !== 409) die(`The server refused to pair (${r.status}): ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'unknown error'}`);
  }
  if (!expiresAt) die('Could not get a pairing code. Try again.');
  console.log(`Open ${server}/settings/devices and enter: ${showCode(code)}  (expires in 10 minutes)`);
  while (Date.now() < Date.parse(expiresAt)) {
    await Bun.sleep(2000);
    const r = await self({ server, secret }).catch(() => undefined);
    if (!r || r.status === 202) continue;
    if (r.status !== 200) die('The code expired. Run the command again.');
    const d = (await r.json()) as { user: { email: string } };
    save({ server, secret, name });
    return console.log(`Paired with ${d.user.email} as "${name}"`);
  }
  die('The code expired. Run the command again.');
}

async function status() {
  const c = load() ?? die('Not paired. Run `bun run device pair <server-url>`.');
  const r = await self(c!).catch((e) => die(`Cannot reach ${c!.server}: ${e.message}`));
  if (r.status === 401) die('This device was removed in the console. Run `bun run device unpair`.');
  if (r.status !== 200) die(`Server answered ${r.status}.`);
  const d = (await r.json()) as { user: { email: string } };
  console.log(`Paired with ${d.user.email} as "${c!.name}" on ${c!.server}`);
}

async function unpair() {
  const c = load() ?? die('Not paired.');
  await self(c!, 'DELETE').catch((e) => console.error(`Warning: could not tell the server (${e.message}); remove the device in the console.`));
  rmSync(configPath(), { force: true });
  console.log('Unpaired.');
}

if (import.meta.main) {
  const { cmd, arg, name } = parseArgs(process.argv.slice(2));
  try {
    if (cmd === 'pair') await pair(arg, name);
    else if (cmd === 'status') await status();
    else if (cmd === 'unpair') await unpair();
    else die('Usage: bun run device <pair <server-url> [--name <name>] | status | unpair>');
  } catch (e) { die((e as Error).message); }
}
