import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PERMISSIONS, WORKER_DEFAULTS } from './permissions.ts';
import seed from '../../profiles/default.json' with { type: 'json' };

export const DATA_DIR = process.env.HEFYN_DATA_DIR ?? './data';
mkdirSync(DATA_DIR, { recursive: true });

// app.db is shared by web and agent. Two things make that safe: a busy timeout, and write transactions that start with
// BEGIN IMMEDIATE. Better Auth's Kysely dialect issues a plain (deferred) `begin`; a deferred transaction that reads and then
// writes after another process committed fails at once with SQLITE_BUSY_SNAPSHOT (517), which busy_timeout does NOT retry.
// So every transaction start on this connection is upgraded to IMMEDIATE (it waits on the busy timeout instead).
class AppDatabase extends DatabaseSync {
  prepare(sql: string) { return super.prepare(/^\s*begin(\s+deferred)?\s*;?\s*$/i.test(sql) ? 'BEGIN IMMEDIATE' : sql); }
}
export const db = new AppDatabase(join(DATA_DIR, 'app.db'));
// busy_timeout FIRST: switching to WAL needs a lock too, and web and agent open this file at the same moment on boot.
db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');

// App tables only; Better Auth creates its own (user, session, account, verification) via migrate().
db.exec(`
CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, builtin INTEGER NOT NULL DEFAULT 0, permissions TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id));
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT, enc_key TEXT NOT NULL, models TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT, instructions TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_agents (profile_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, model TEXT, instructions TEXT NOT NULL, skills TEXT NOT NULL, PRIMARY KEY (profile_id, name));
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS usage_user_ts ON usage (user_id, ts);
-- Privacy layer: per-conversation {name: real value} map (encrypted, it holds the secrets) and one audit row per model request.
CREATE TABLE IF NOT EXISTS redact_vars (conversation_id TEXT PRIMARY KEY, enc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS redact_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  findings TEXT NOT NULL, bytes INTEGER NOT NULL, payload TEXT, error TEXT, ts TEXT NOT NULL);
-- Connectors: per-user model credentials (encrypted pi-ai Credential JSON) and MCP servers (secret/tokens encrypted).
CREATE TABLE IF NOT EXISTS user_credentials (user_id TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT, models TEXT, enc TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, provider));
CREATE TABLE IF NOT EXISTS mcp_connectors (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, url TEXT NOT NULL, transport TEXT NOT NULL, auth TEXT NOT NULL, enc TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_builtins (user_id TEXT NOT NULL, id TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (user_id, id));
-- Agent restart coordinator (web and agent processes both read/write it): running -> draining -> restarting -> running.
CREATE TABLE IF NOT EXISTS runtime (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, requested_at TEXT, requested_by TEXT, running_tasks INTEGER NOT NULL DEFAULT 0, heartbeat_at TEXT);
INSERT OR IGNORE INTO runtime (id, state) VALUES (1, 'running');
CREATE INDEX IF NOT EXISTS redact_audit_conv ON redact_audit (conversation_id, id);
`);

try { db.exec('ALTER TABLE conversations ADD COLUMN model TEXT'); } catch { /* column exists */ }

try { db.exec('ALTER TABLE mcp_connectors ADD COLUMN source TEXT'); } catch { /* column exists */ }

try { db.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'api_key'"); } catch { /* column exists */ }

export const ADMIN_ROLE = 'admin';
export const WORKER_ROLE = 'worker';
export const DEFAULT_PROFILE = 'default';

db.prepare('INSERT OR IGNORE INTO roles (id, name, builtin, permissions) VALUES (?, ?, 1, ?)').run(ADMIN_ROLE, 'Admin', JSON.stringify(PERMISSIONS));
db.prepare('INSERT OR IGNORE INTO roles (id, name, builtin, permissions) VALUES (?, ?, 1, ?)').run(WORKER_ROLE, 'Worker', JSON.stringify(WORKER_DEFAULTS));

// Seed the default profile once from profiles/default.json; models are chosen later in the setup wizard.
if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(DEFAULT_PROFILE)) {
  db.prepare('INSERT INTO profiles (id, name, model, instructions) VALUES (?, ?, NULL, ?)').run(DEFAULT_PROFILE, 'Default', seed.orchestrator.instructions);
  for (const [name, r] of Object.entries(seed.roles)) {
    db.prepare('INSERT INTO profile_agents (profile_id, name, description, model, instructions, skills) VALUES (?, ?, ?, NULL, ?, ?)')
      .run(DEFAULT_PROFILE, name, r.description, r.instructions, JSON.stringify(r.skills));
  }
}
