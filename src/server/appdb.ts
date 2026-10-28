import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type SubAgent, isSimple, simpleFlow } from '../assistants/flow.ts';
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
-- Connectors: per-user model credentials (encrypted pi-ai Credential JSON) and MCP servers (secret/tokens encrypted).
CREATE TABLE IF NOT EXISTS user_credentials (user_id TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT, models TEXT, enc TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, provider));
CREATE TABLE IF NOT EXISTS mcp_connectors (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, url TEXT NOT NULL, transport TEXT NOT NULL, auth TEXT NOT NULL, enc TEXT, created_at TEXT NOT NULL);
-- Storage add-ons became Files connections (docs/STORAGE.md): drop the old tables.
DROP TABLE IF EXISTS storage_addons;
DROP TABLE IF EXISTS storage_addon_creds;
-- Connections (private per user): config is non-secret JSON, enc the sealed secrets; folder = the /files/<folder> it syncs with; running_at = the cross-process sync lock.
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, folder TEXT NOT NULL, config TEXT NOT NULL, enc TEXT, remote_root TEXT NOT NULL DEFAULT '/',
  status TEXT NOT NULL DEFAULT 'new', last_sync_at TEXT, last_error TEXT, last_summary TEXT, host_key TEXT, running_at TEXT, created_at TEXT NOT NULL, UNIQUE (user_id, folder));
-- What the last sync saw per path (r_sig = remote etag or mtime): the base of the two-way diff.
CREATE TABLE IF NOT EXISTS connection_state (connection_id TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, r_sig TEXT, r_size INTEGER, l_mtime TEXT, l_size INTEGER, synced_at TEXT NOT NULL, PRIMARY KEY (connection_id, path));
CREATE TABLE IF NOT EXISTS user_builtins (user_id TEXT NOT NULL, id TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (user_id, id));
-- Installed modules (docs/MODULES.md): the validated manifest, and settings per module (secret values sealed with the team key).
CREATE TABLE IF NOT EXISTS modules (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, installed_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS module_settings (module_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (module_id, key));
-- Agent restart coordinator (web and agent processes both read/write it): running -> draining -> restarting -> running.
CREATE TABLE IF NOT EXISTS runtime (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, requested_at TEXT, requested_by TEXT, running_tasks INTEGER NOT NULL DEFAULT 0, heartbeat_at TEXT);
INSERT OR IGNORE INTO runtime (id, state) VALUES (1, 'running');
-- The privacy layer was removed: drop its leftovers (placeholder maps, audit ledger, the images switch).
DROP TABLE IF EXISTS redact_vars;
DROP TABLE IF EXISTS redact_audit;
DROP TABLE IF EXISTS settings;
-- Instance-wide key/value settings (e.g. the two-factor policy).
CREATE TABLE IF NOT EXISTS instance_settings (key TEXT PRIMARY KEY, value TEXT);
-- System mail (SMTP; legacy Telegram rows may remain): config is non-secret JSON, enc holds the password or bot token.
-- outbox: legacy, no writer since outbox removal; kept so existing sealed rows are still deleted/rotated.
CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL UNIQUE, config TEXT NOT NULL, enc TEXT, enabled INTEGER NOT NULL DEFAULT 1, system INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, channel_id TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT);
CREATE INDEX IF NOT EXISTS outbox_user ON outbox (user_id, created_at);
-- Encryption keys (docs/ENCRYPTION.md): a user's data key wrapped by password and by recovery key; the team key wrapped per admin.
CREATE TABLE IF NOT EXISTS user_keys (user_id TEXT PRIMARY KEY, pw_salt TEXT NOT NULL, pw_wrapped TEXT, rec_salt TEXT NOT NULL, rec_wrapped TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ok', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_key_wraps (user_id TEXT PRIMARY KEY, wrapped TEXT NOT NULL, created_at TEXT NOT NULL);
-- HEFYN_KEY_MODE=server only: each data key wrapped by a key derived from HEFYN_SECRET. Deleted at start in user mode.
CREATE TABLE IF NOT EXISTS server_key_wraps (user_id TEXT PRIMARY KEY, wrapped TEXT NOT NULL, created_at TEXT NOT NULL);
-- An admin confirmed this (later) admin may receive a team-key wrap; a role row in the DB alone never hands out the team key.
CREATE TABLE IF NOT EXISTS team_key_grants (user_id TEXT PRIMARY KEY, granted_by TEXT NOT NULL, created_at TEXT NOT NULL);
-- Accounts whose password was chosen by an admin: it never wraps a data key; the user must pick their own first.
CREATE TABLE IF NOT EXISTS password_set_by_admin (user_id TEXT PRIMARY KEY);
`);

try { db.exec('ALTER TABLE conversations ADD COLUMN model TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN thinking TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN accept_messages INTEGER NOT NULL DEFAULT 0'); } catch { /* column exists */ }

// Chat management: pinned/archived/updated_at drive the sidebar. Projects, folders and schedules add their own conversation columns (modules' `migrate`).
try { db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN archived_at TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN updated_at TEXT'); } catch { /* column exists */ }

try { db.exec('ALTER TABLE user_keys ADD COLUMN strict INTEGER NOT NULL DEFAULT 0'); } catch { /* column exists */ }

try { db.exec('ALTER TABLE mcp_connectors ADD COLUMN source TEXT'); } catch { /* column exists */ }

try { db.exec('ALTER TABLE modules ADD COLUMN hub_package TEXT'); } catch { /* column exists */ }

try { db.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'api_key'"); } catch { /* column exists */ }

// Thinking effort: NULL = the model's default. user_agent_prefs: a user's own model/effort per agent ('orchestrator' or an agent name); NULL = the team default.
try { db.exec('ALTER TABLE profiles ADD COLUMN thinking TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE profile_agents ADD COLUMN thinking TEXT'); } catch { /* column exists */ }
db.exec('CREATE TABLE IF NOT EXISTS user_agent_prefs (user_id TEXT NOT NULL, agent TEXT NOT NULL, model TEXT, thinking TEXT, PRIMARY KEY (user_id, agent))');
// Hosted CLI agents (src/cli-agents): agent NULL = a classic hefyn chat; view 'chat' | 'terminal'; acp_session = the agent's own session id.
// cli_events: the conversation's ACP event log, `data` sealed with the owner's key (cli:<conversation>:<seq>).
try { db.exec('ALTER TABLE conversations ADD COLUMN agent TEXT'); } catch { /* column exists */ }
try { db.exec("ALTER TABLE conversations ADD COLUMN view TEXT NOT NULL DEFAULT 'chat'"); } catch { /* column exists */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN acp_session TEXT'); } catch { /* column exists */ }
// Assistant editor chats (assistant-draft.ts): hidden = 'creator' | 'test' (never in the chat list); draft_id ties them to an editor draft; cwd = the agent's working folder (default /files);
// snapshot = the unsaved Assistant a test chat runs on (JSON), instead of a saved one.
// bundle = the unsaved draft's files (tar.gz) a test chat copies; bundle_seeded = 1 once the chat has its copy of the Assistant's extra files (src/server/assistant-bundle.ts).
// profiles.bundle = an Assistant's own files (tar.gz): the draft folder minus the creator's brief.
for (const c of ['hidden TEXT', 'draft_id TEXT', 'cwd TEXT', 'snapshot TEXT', 'bundle BLOB', 'bundle_seeded INTEGER NOT NULL DEFAULT 0']) try { db.exec(`ALTER TABLE conversations ADD COLUMN ${c}`); } catch { /* column exists */ }
// Assistants (src/server/assistants.ts): a profile is an Assistant an admin presets. agent NULL = the classic hefyn chat, else a CLI agent id; skills = Hub skill package ids;
// inputs = JSON rules (images, documents, upload size; missing keys take the defaults); roles = JSON role ids ([] = everyone). conversations.assistant_id NULL = the default one.
for (const [col, def] of [['description', "TEXT NOT NULL DEFAULT ''"], ['icon', "TEXT NOT NULL DEFAULT 'Sparkles'"], ['agent', 'TEXT'], ['skills', "TEXT NOT NULL DEFAULT '[]'"], ['inputs', "TEXT NOT NULL DEFAULT '{}'"],
  ['roles', "TEXT NOT NULL DEFAULT '[]'"], ['is_default', 'INTEGER NOT NULL DEFAULT 0'], ['archived', 'INTEGER NOT NULL DEFAULT 0'], ['sort', 'INTEGER NOT NULL DEFAULT 0'], ['updated_at', 'TEXT']]) {
  try { db.exec(`ALTER TABLE profiles ADD COLUMN ${col} ${def}`); } catch { /* column exists */ }
}
db.exec("UPDATE profiles SET icon = 'Sparkles' WHERE icon = 'sparkles'"); // the first cut stored a lowercase default; icons are lucide component names
try { db.exec('ALTER TABLE conversations ADD COLUMN assistant_id TEXT'); } catch { /* column exists */ }
// Flows (docs/ASSISTANTS.md): flow = JSON (the source of truth; agent/model/... above mirror it while it is the simple shape), owner_id NULL = the team's, scope private | team,
// share_status NULL | pending | declined, version bumps on save. conversations.flow = 1: the chat runs through the engine; parent_id: a hidden chat that belongs to another
// (the CLI-agent sessions of a flow chat). assistant_runs.state is sealed with the owner's key.
for (const [col, def] of [['flow', 'TEXT'], ['owner_id', 'TEXT'], ['scope', "TEXT NOT NULL DEFAULT 'team'"], ['share_status', 'TEXT'], ['version', 'INTEGER NOT NULL DEFAULT 1'], ['bundle', 'BLOB']]) {
  try { db.exec(`ALTER TABLE profiles ADD COLUMN ${col} ${def}`); } catch { /* column exists */ }
}
try { db.exec('ALTER TABLE conversations ADD COLUMN flow INTEGER NOT NULL DEFAULT 0'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN parent_id TEXT'); } catch { /* column exists */ }
db.exec(`CREATE TABLE IF NOT EXISTS assistant_runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, assistant_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
CREATE INDEX IF NOT EXISTS assistant_runs_conv ON assistant_runs (conversation_id, started_at);
-- the Flue instances a flow chat's agent steps ran in (so deleting the chat can purge them)
CREATE TABLE IF NOT EXISTS assistant_steps (instance_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);`);
// chat_activity: what the agent process is doing in a chat right now (state running | waiting, label, agents JSON), written by it and read by conversations.activity in the web process. Cleared at agent start.
db.exec('CREATE TABLE IF NOT EXISTS chat_activity (conversation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL, since TEXT NOT NULL, label TEXT, agents TEXT)');
try { db.exec('ALTER TABLE chat_activity ADD COLUMN ask TEXT'); } catch { /* column exists */ } // the kind of tool the chat itself waits to use (no path, no command)
db.exec('CREATE TABLE IF NOT EXISTS cli_events (conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (conversation_id, seq))');
// cli_agents: the agents an admin installed from the ACP Registry (id = registry id; status installing | ready | failed; roles = JSON list of role ids, [] = every role
// with the sandbox; key_provider = which connected API-key provider they use, NULL = the first suitable). Old conversations say `claude-code`: see canonicalAgent.
db.exec('CREATE TABLE IF NOT EXISTS cli_agents (id TEXT PRIMARY KEY, version TEXT NOT NULL, status TEXT NOT NULL, error TEXT, enabled INTEGER NOT NULL DEFAULT 0, roles TEXT NOT NULL DEFAULT \'[]\', key_provider TEXT, installed_at TEXT)');
// personal_signin: unused since Claude Code runs unmodified on the user's own Claude sign-in with no admin switch (docs/WRAPPER.md); the column stays so old databases keep opening
try { db.exec('ALTER TABLE cli_agents ADD COLUMN personal_signin TEXT'); } catch { /* column exists */ }
// Updates (src/cli-agents/installed.ts): auto_update NULL = the default for the agent's source; update_version = the version being installed next to the current one;
// retired = JSON list of replaced versions still in the volume (removed once no session uses them); cli_version = the agent's own version (the adapter's `version` is the registry's).
for (const c of ['auto_update INTEGER', 'update_version TEXT', 'retired TEXT', 'cli_version TEXT', 'last_checked TEXT', 'last_update_error TEXT', 'last_update_error_at TEXT',
  'default_provider TEXT', 'default_model TEXT']) { // default_*: the provider and model a chat on the agent that has no Assistant runs on (NULL = the agent's own choice)
  try { db.exec(`ALTER TABLE cli_agents ADD COLUMN ${c}`); } catch { /* column exists */ }
}

export const ADMIN_ROLE = 'admin';
export const WORKER_ROLE = 'worker';
export const DEFAULT_PROFILE = 'default';

db.prepare('INSERT OR IGNORE INTO roles (id, name, builtin, permissions) VALUES (?, ?, 1, ?)').run(ADMIN_ROLE, 'Admin', JSON.stringify(PERMISSIONS));
/** `mod.<id>.<name>` of every installed module (docs/MODULES.md). */
export const modulePermissions = () => (db.prepare('SELECT id, manifest FROM modules').all() as { id: string; manifest: string }[])
  .flatMap((m) => (JSON.parse(m.manifest).permissions ?? []).map((p: { name: string }) => `mod.${m.id}.${p.name}`));
// Additive: the agent process never loads the built-in modules, so its PERMISSIONS lacks theirs and replacing the list would strip them from Admin. Only uninstalled `mod.*` entries are dropped.
export function grantAdmin() {
  const mods = modulePermissions();
  const stored = JSON.parse((db.prepare('SELECT permissions FROM roles WHERE id = ?').get(ADMIN_ROLE) as { permissions: string }).permissions) as string[];
  const next = [...new Set([...stored.filter((p) => !p.startsWith('mod.') || mods.includes(p)), ...PERMISSIONS, ...mods])];
  db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(next), ADMIN_ROLE);
}
grantAdmin(); // Admin always has every permission, including ones added later and those of installed modules
db.prepare('INSERT OR IGNORE INTO roles (id, name, builtin, permissions) VALUES (?, ?, 1, ?)').run(WORKER_ROLE, 'Worker', JSON.stringify(WORKER_DEFAULTS));
try { db.exec("ALTER TABLE roles ADD COLUMN description TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
/** The role a new account gets (instance setting `default_role`, Worker until an admin picks another; a deleted pick falls back to Worker). */
export const defaultRole = () => {
  const id = (db.prepare("SELECT value FROM instance_settings WHERE key = 'default_role'").get() as { value: string } | undefined)?.value;
  return id && db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id) ? id : WORKER_ROLE;
};
// Workers could not use any coding agent without the sandbox: an existing Worker gains it once, but only while it still has the original defaults (an edited role is left alone).
if (!db.prepare("SELECT 1 FROM instance_settings WHERE key = 'seed_worker_sandbox_shell'").get()) {
  const w = db.prepare('SELECT permissions FROM roles WHERE id = ?').get(WORKER_ROLE) as { permissions: string };
  const p: string[] = JSON.parse(w.permissions), original = ['models.use', 'hub.install', 'assistants.create', 'assistants.share'];
  if (!p.includes('sandbox.shell') && p.length === original.length && original.every((x) => p.includes(x))) db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify([...p, 'sandbox.shell']), WORKER_ROLE);
  db.prepare("INSERT INTO instance_settings (key, value) VALUES ('seed_worker_sandbox_shell', '1')").run();
}
/** Once per permission: an existing Worker role gains a module's new default (`worker: true`); later removals by an admin stay. */
export function seedWorkerPermission(id: string) {
  const key = `seed_${id.replace(/\./g, '_')}`;
  if (db.prepare('SELECT 1 FROM instance_settings WHERE key = ?').get(key)) return;
  const w = db.prepare('SELECT permissions FROM roles WHERE id = ?').get(WORKER_ROLE) as { permissions: string } | undefined;
  if (w) { const p: string[] = JSON.parse(w.permissions); if (!p.includes(id)) db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify([...p, id]), WORKER_ROLE); }
  db.prepare('INSERT INTO instance_settings (key, value) VALUES (?, ?)').run(key, '1');
}

// Seed the default profile once from profiles/default.json; models are chosen later in the setup wizard.
if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(DEFAULT_PROFILE)) {
  db.prepare('INSERT INTO profiles (id, name, model, instructions) VALUES (?, ?, NULL, ?)').run(DEFAULT_PROFILE, 'General', seed.orchestrator.instructions);
  for (const [name, r] of Object.entries(seed.roles)) {
    db.prepare('INSERT INTO profile_agents (profile_id, name, description, model, instructions, skills) VALUES (?, ?, ?, NULL, ?, ?)')
      .run(DEFAULT_PROFILE, name, r.description, r.instructions, JSON.stringify(r.skills));
  }
}
// The seeded profile is the default Assistant, "General": what every chat used before Assistants existed (images follow the admin switch alone, as they did).
db.prepare("UPDATE profiles SET name = 'General' WHERE id = ? AND name = 'Default'").run(DEFAULT_PROFILE);
db.prepare("UPDATE profiles SET description = 'Everyday questions, writing and research.' WHERE id = ? AND description = ''").run(DEFAULT_PROFILE);
db.prepare("UPDATE profiles SET inputs = ? WHERE id = ? AND inputs = '{}'").run(JSON.stringify({ images: 'on', documents: true, maxUploadMb: 100 }), DEFAULT_PROFILE);
db.prepare('UPDATE profiles SET is_default = 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM profiles WHERE is_default = 1)').run(DEFAULT_PROFILE);

/** The sub-agents of a profile as flow `subAgents` (the classic chat reads profile_agents; the flow is the source of truth, save writes both). */
export const subAgentsOf = (profileId: string): SubAgent[] => (db.prepare('SELECT name, description, model, thinking, instructions, skills FROM profile_agents WHERE profile_id = ? ORDER BY rowid').all(profileId) as any[])
  .map((r) => ({ name: r.name, description: r.description, model: r.model, thinking: r.thinking, instructions: r.instructions, skills: JSON.parse(r.skills) }));
/** A profile row without a flow gets the simple one built from its columns; also called after the columns change (profile.update) to keep a simple flow in step. */
export function syncSimpleFlow(id: string) {
  const r = db.prepare('SELECT agent, model, thinking, instructions, skills, flow FROM profiles WHERE id = ?').get(id) as any;
  if (!r) return;
  if (r.flow) { const f = JSON.parse(r.flow); if (!isSimple(f)) return; }
  db.prepare('UPDATE profiles SET flow = ? WHERE id = ?').run(JSON.stringify(simpleFlow({ agent: r.agent, model: r.model, thinking: r.thinking, instructions: r.instructions, skills: JSON.parse(r.skills), subAgents: subAgentsOf(id) })), id);
}
for (const r of db.prepare('SELECT id FROM profiles WHERE flow IS NULL').all() as { id: string }[]) syncSimpleFlow(r.id);
// Everyone may create and share Assistants by default: roles that exist now gain the two permissions once (an admin can take them away again).
for (const p of ['assistants.create', 'assistants.share']) {
  const key = `seed_all_${p.replace(/\./g, '_')}`;
  if (db.prepare('SELECT 1 FROM instance_settings WHERE key = ?').get(key)) continue;
  for (const r of db.prepare('SELECT id, permissions FROM roles').all() as { id: string; permissions: string }[]) {
    const list: string[] = JSON.parse(r.permissions);
    if (!list.includes(p)) db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify([...list, p]), r.id);
  }
  db.prepare('INSERT INTO instance_settings (key, value) VALUES (?, ?)').run(key, '1');
}
