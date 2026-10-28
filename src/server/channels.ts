import { createHash, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { db } from './appdb.ts';
import { openTeamSecret } from './seal.ts';
import { sealForTeam } from './vault.ts';
import { assertPublicUrl } from './mcp.ts';

// System mail (password resets, invites): one SMTP server, stored as a `channels` row flagged system. The table keeps its name so existing
// installs still open their sealed password. Secrets are never logged or returned; neither are bodies.
export type Kind = 'smtp' | 'telegram'; // telegram: legacy rows only (no writer; kept so keys.ts can still re-seal them)
export interface Channel { id: string; kind: Kind; name: string; config: any; enabled: boolean; system: boolean; hasSecret: boolean }
export interface Outgoing { to: string; subject: string; text: string; html?: string }
export type Transport = (ch: { kind: Kind; config: any; secret: string }, m: Outgoing) => Promise<void>;

const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;
export const validEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

const view = (r: any): Channel => ({ id: r.id, kind: r.kind, name: r.name, config: JSON.parse(r.config), enabled: !!r.enabled, system: !!r.system, hasSecret: !!r.enc });
const row = (id: string) => db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as any;

export const listChannels = (): Channel[] => (db.prepare("SELECT * FROM channels WHERE kind = 'smtp' ORDER BY created_at").all() as any[]).map(view);
export const getChannel = (id: string) => { const r = row(id); return r?.kind === 'smtp' ? view(r) : undefined; };

/** The routing part of a channel's config is bound into its secret's AAD: editing host/port/user in the database makes the secret unreadable. */
export const chanAad = (id: string, kind: Kind, c: any) => kind === 'smtp'
  ? `channel:${id}:smtp:${c.host}:${c.port}:${c.username ?? ''}`
  : `channel:${id}:telegram:${createHash('sha256').update(JSON.stringify([...(c.recipients ?? [])].map((r: any) => ({ label: r.label, chatId: r.chatId })).sort((a, b) => (a.chatId + a.label).localeCompare(b.chatId + b.label)))).digest('hex')}`;

/** The SMTP host gets the same public-address rule as connector URLs (unless HEFYN_ALLOW_PRIVATE_URLS=1). */
function smtpHost(host: string) {
  try { assertPublicUrl(`https://${host}`); } catch { throw new Error('SMTP host: private or internal addresses are not allowed.'); }
}

// Normalises and validates the non-secret config; throws a user-facing Error.
function cleanConfig(c: any) {
  const s = (v: unknown) => String(v ?? '').trim();
  const port = Number(c?.port);
  if (!s(c?.host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP needs a host and a port (1-65535).');
  if (!validEmail(s(c?.from))) throw new Error('The sender address is not a valid email address.');
  smtpHost(s(c.host));
  return { host: s(c.host), port, secure: !!c.secure, username: s(c.username), from: s(c.from), fromName: s(c.fromName).replace(/[\r\n"<>]/g, '') };
}

// The new row becomes the system mail server (the only one).
export function createChannel(i: { name?: string; config: unknown; secret?: string; enabled?: boolean }): Channel {
  const name = String(i.name ?? 'System mail').trim().slice(0, 60);
  if (!name) throw new Error('A name is required.');
  const config = cleanConfig(i.config);
  const id = randomUUID();
  const enc = i.secret ? sealForTeam(i.secret, chanAad(id, 'smtp', config)) : null; // outside the try: a locked team key must not look like a name clash
  try {
    db.prepare('UPDATE channels SET system = 0').run();
    db.prepare('INSERT INTO channels (id, kind, name, config, enc, enabled, system, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, 'smtp', name, JSON.stringify(config), enc, i.enabled === false ? 0 : 1, new Date().toISOString());
  } catch { throw new Error('A channel with this name already exists.'); }
  return getChannel(id)!;
}

// secret: undefined/'' keeps the stored one. system=true makes this the only system mail channel.
export function updateChannel(id: string, p: { name?: string; config?: unknown; secret?: string; enabled?: boolean; system?: boolean }): Channel | undefined {
  const cur = row(id);
  if (cur?.kind !== 'smtp') return undefined;
  if (p.name !== undefined) {
    const name = String(p.name).trim().slice(0, 60);
    if (!name) throw new Error('A name is required.');
    try { db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, id); } catch { throw new Error('A channel with this name already exists.'); }
  }
  // A config change re-seals the stored secret under the new routing (the admin edit path has the team key).
  const config = p.config !== undefined ? cleanConfig(p.config) : JSON.parse(cur.config);
  const secret = p.secret || (cur.enc && p.config !== undefined ? openTeamSecret(cur.enc, chanAad(id, cur.kind, JSON.parse(cur.config))) : undefined);
  if (p.config !== undefined) db.prepare('UPDATE channels SET config = ? WHERE id = ?').run(JSON.stringify(config), id);
  if (secret) db.prepare('UPDATE channels SET enc = ? WHERE id = ?').run(sealForTeam(secret, chanAad(id, cur.kind, config)), id);
  if (p.enabled !== undefined) db.prepare('UPDATE channels SET enabled = ? WHERE id = ?').run(p.enabled ? 1 : 0, id);
  if (p.system !== undefined) {
    if (p.system) db.prepare('UPDATE channels SET system = 0').run();
    db.prepare('UPDATE channels SET system = ? WHERE id = ?').run(p.system ? 1 : 0, id);
  }
  return getChannel(id);
}

export function deleteChannel(id: string) { db.prepare('DELETE FROM channels WHERE id = ?').run(id); }

// ---- transport ----
const realTransport: Transport = async (ch, m) => {
  const c = ch.config;
  smtpHost(c.host); // also at send time: the config row could have been edited in the database
  const t = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    ...(c.username ? { auth: { user: c.username, pass: ch.secret } } : {}) });
  await t.sendMail({ from: c.fromName ? { name: c.fromName, address: c.from } : c.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
};
let transport: Transport = realTransport;
export const setTransport = (t: Transport) => void (transport = t); // tests only

async function deliver(id: string, m: Outgoing) {
  const r = row(id);
  if (r?.kind !== 'smtp') throw new Error('Channel not found.');
  await transport({ kind: r.kind, config: JSON.parse(r.config), secret: r.enc ? openTeamSecret(r.enc, chanAad(id, r.kind, JSON.parse(r.config))) : '' }, m);
}

export async function testChannel(id: string, to: string) {
  if (!getChannel(id)) throw new Error('Channel not found.');
  if (!validEmail(to)) throw new Error('Enter a valid email address.');
  await deliver(id, { to, subject: 'hefyn test message', text: 'This is a test message from hefyn. Your mail settings work.' });
}

// ---- system mail (resets, invites): the SMTP channel flagged system ----
const systemRow = () => db.prepare("SELECT id FROM channels WHERE kind = 'smtp' AND enabled = 1 AND system = 1").get() as { id: string } | undefined;
export const systemMailConfigured = (): boolean => !!systemRow();
export async function sendSystemMail(m: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  const s = systemRow();
  if (!s) throw new Error('System mail is not configured.');
  await deliver(s.id, m);
}
