import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsGroups } from '../web/src/components/settings-nav.ts';
import { describeAgent } from '../web/src/components/session-label.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-profile-'));
process.env.HEFYN_SECRET = 'profile-test-secret-profile-test-secret1';

const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { avatarError } = await import('../src/server/avatar.ts');

const nav = (label: string, href: string, group?: 'you' | 'workspace') => ({ place: 'settings' as const, label, href, group });

test('settings groups: You first, Workspace only when it has items, a personal twin of a workspace page is dropped', () => {
  const worker = settingsGroups([nav('Profile', '/p'), nav('Your usage', '/usage'), { place: 'main', label: 'Chat', href: '/' }]);
  assert.deepEqual(worker.map((g) => g.label), ['You']);
  const admin = settingsGroups([nav('Profile', '/p'), nav('Users', '/u', 'workspace'), nav('Usage', '/usage', 'workspace'), nav('Your usage', '/usage')]);
  assert.deepEqual(admin.map((g) => [g.label, g.items.map((i) => i.label)]), [['You', ['Profile']], ['Workspace', ['Users', 'Usage']]]);
  assert.deepEqual(settingsGroups([]), []);
});

test('describeAgent reads plain words from a user agent', () => {
  assert.equal(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'Chrome on macOS');
  assert.equal(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Safari/604.1'), 'Safari on iOS');
  assert.equal(describeAgent(null), 'Unknown device');
});

test('avatar: png/jpeg/webp data URLs up to 256 KB; svg, other schemes and oversize refused; null clears', () => {
  const png = `data:image/png;base64,${Buffer.from('x').toString('base64')}`;
  assert.equal(avatarError(png), undefined);
  assert.equal(avatarError(null), undefined);
  assert.match(avatarError(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)!, /PNG, JPEG or WebP/);
  assert.match(avatarError('https://x.test/a.png')!, /PNG, JPEG or WebP/);
  assert.match(avatarError(`data:image/png;base64,${'A'.repeat(360_000)}`)!, /256 KB/);
  assert.equal(avatarError(`data:image/png;base64,${'A'.repeat(349_000)}`), undefined);
});

test('updateUser (Better Auth\'s own endpoint) holds the avatar rules too', async () => {
  const r = await auth.api.signUpEmail({ body: { name: 'Ada', email: 'ada@x.test', password: 'password-12345' } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, 'worker');
  const s = await auth.api.signInEmail({ body: { email: 'ada@x.test', password: 'password-12345' }, returnHeaders: true });
  const headers = new Headers({ cookie: s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') });
  const png = `data:image/png;base64,${Buffer.from('x').toString('base64')}`;
  await auth.api.updateUser({ headers, body: { image: png, name: 'Ada L' } });
  assert.deepEqual({ ...db.prepare('SELECT name, image FROM user WHERE id = ?').get(r.user.id) }, { name: 'Ada L', image: png });
  await assert.rejects(auth.api.updateUser({ headers, body: { image: 'data:image/svg+xml;base64,PHN2Zy8+' } }), /PNG, JPEG or WebP/);
  assert.equal((db.prepare('SELECT image FROM user WHERE id = ?').get(r.user.id) as any).image, png);
});
