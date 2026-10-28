import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-channels-'));
process.env.HEFYN_SECRET = 'channels-test-secret-channels-test-1234';

const ch = await import('../src/server/channels.ts');
const { db } = await import('../src/server/appdb.ts');
const vault = await import('../src/server/vault.ts');
vault.setTeamKey(vault.newKey()); // team secrets are sealed (docs/ENCRYPTION.md)

const sent: any[] = [];
ch.setTransport(async (c, m) => { sent.push({ kind: c.kind, secret: c.secret, ...m }); });

const smtp = ch.createChannel({ name: 'work-mail', secret: 'hunter2-password', config: { host: 'smtp.example.com', port: 587, from: 'bot@example.com', username: 'bot' } });

test('secrets are encrypted at rest and never returned', () => {
  const raw = db.prepare('SELECT config, enc FROM channels WHERE id = ?').get(smtp.id) as any;
  assert.ok(raw.enc && !raw.enc.includes('hunter2') && !raw.config.includes('hunter2'));
  assert.equal(smtp.hasSecret, true);
  assert.ok(!JSON.stringify(ch.listChannels()).includes('hunter2'));
});

test('update keeps the secret when blank; one system mail channel', async () => {
  ch.updateChannel(smtp.id, { system: false });
  assert.equal(ch.systemMailConfigured(), false);
  await assert.rejects(ch.sendSystemMail({ to: 'a@b.de', subject: 's', text: 't' }), /not configured/);
  ch.updateChannel(smtp.id, { secret: '', system: true });
  assert.equal(ch.systemMailConfigured(), true);
  await ch.sendSystemMail({ to: 'a@b.de', subject: 's', text: 't' });
  assert.equal(sent.at(-1).secret, 'hunter2-password');
});
test('a new server becomes the only system mail server; test mail validates the address', async () => {
  const second = ch.createChannel({ name: 'other', config: { host: 'smtp2.example.com', port: 465, secure: true, from: 'bot@example.com' } });
  assert.equal(second.system, true);
  assert.equal(ch.listChannels().filter((c) => c.system).length, 1);
  await assert.rejects(ch.testChannel(second.id, 'not-an-email'), /valid email/);
  await ch.testChannel(second.id, 'me@example.com');
  assert.equal(sent.at(-1).to, 'me@example.com');
  assert.throws(() => ch.createChannel({ config: { host: 'smtp.example.com', port: 0, from: 'a@b.de' } }), /host and a port/);
  ch.deleteChannel(second.id);
  ch.updateChannel(smtp.id, { system: false });
  assert.equal(ch.systemMailConfigured(), false);
});

test('legacy telegram rows are neither listed nor editable', () => {
  db.prepare("INSERT INTO channels (id, kind, name, config, enc, created_at) VALUES ('tg-old', 'telegram', 'old-tg', '{\"recipients\":[]}', NULL, 'now')").run();
  assert.ok(!ch.listChannels().some((c) => c.id === 'tg-old'));
  assert.equal(ch.updateChannel('tg-old', { enabled: false }), undefined);
});
