import { Hono } from 'hono';
import { randomBytes, randomUUID } from 'node:crypto';
import { ADMIN_ROLE, DEFAULT_PROFILE, WORKER_ROLE, db } from './appdb.ts';
import { auth } from './auth.ts';
import { cleanedHeaders, peerOf } from './clientip.ts';
import { type Env, meFromUserId, requireAuth, requirePermission } from './guard.ts';
import { isPermission, PERMISSIONS } from './permissions.ts';
import { loadProfile } from './profile.ts';
import { connect, connectedIds, connectedModels, disconnect, listProviders, validate } from './providers.ts';
import { auditFor, imagesAllowed, sealsFor, setImagesAllowed, sidecarHealth } from './privacy.ts';
import { glinerInfo, invalidateGlinerInfo } from './redact/download.ts';
import { modelDir, sourceOf } from './redact/models.ts';
import { MAX_UPLOAD, UploadError, saveModelFiles } from './redact/upload.ts';
import { availableModels, companyConnections, modelAllowed } from './connectors.ts';
import { connectorRoutes } from './connectors-routes.ts';
import { hubRoutes } from './hub-routes.ts';
import { removeHubConnectors, upsertHubConnectors } from './mcp.ts';
import { fsFor } from './runner.ts';
import { storageAddonRoutes } from './storage-addon-routes.ts';
import { saveUploads, storageRoutes } from './storage-routes.ts';
import { requestRestart, runtimeInfo } from './runtime.ts';
import { usageSummary, userOfConversation } from './usage.ts';

export const api = new Hono<Env>();
const bad = (c: any, msg: string, status = 400) => c.json({ error: msg }, status);
const countUsers = () => (db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n;
const adminCount = () => (db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?').get(ADMIN_ROLE) as { n: number }).n;

// ---- public: setup ----
api.get('/setup/status', (c) => c.json({ needsSetup: countUsers() === 0, providerConnected: connectedIds().length > 0 }));

let setupLock = false; // the first account is created once; the lock closes the check-then-create race
api.post('/setup', async (c) => {
  if (setupLock || countUsers() > 0) return bad(c, 'Setup is already done.', 409);
  setupLock = true;
  try {
    const { name, email, password } = await c.req.json();
    const r = await auth.api.signUpEmail({ body: { name, email, password }, headers: cleanedHeaders(c.req.raw.headers, peerOf(c)) });
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, ADMIN_ROLE);
    return c.json({ ok: true });
  } catch (e) {
    return bad(c, (e as Error).message);
  } finally {
    setupLock = false;
  }
});

// ---- self ----
api.get('/me', requireAuth, (c) => c.json({ ...c.var.me, providerConnected: connectedIds().length > 0, modelReady: !!loadProfile().model }));

api.get('/conversations', requireAuth, (c) =>
  c.json(db.prepare('SELECT id, title, model, created_at AS createdAt FROM conversations WHERE user_id = ? ORDER BY created_at DESC').all(c.var.me.id)));

const ulid = () => Date.now().toString(36).padStart(9, '0') + randomBytes(8).toString('hex');
api.post('/conversations', requirePermission('models.use'), async (c) => {
  const { title } = await c.req.json().catch(() => ({ title: '' }));
  const id = `u_${c.var.me.id}_${ulid()}`;
  db.prepare('INSERT INTO conversations (id, user_id, title, created_at) VALUES (?, ?, ?, ?)').run(id, c.var.me.id, String(title || 'New chat').slice(0, 80), new Date().toISOString());
  return c.json({ id });
});

// The user's own transcript marks sealed spans with this: placeholder, label, real value. Owner only; contains secrets, so never cached.
api.get('/conversations/:id/seals', requireAuth, (c) => {
  if (userOfConversation(c.req.param('id')) !== c.var.me.id) return bad(c, 'not found', 404);
  c.header('Cache-Control', 'no-store');
  return c.json(sealsFor(c.req.param('id')));
});
api.get('/conversations/:id/audit', requireAuth, (c) =>
  userOfConversation(c.req.param('id')) === c.var.me.id ? c.json(auditFor(c.req.param('id'))) : bad(c, 'forbidden', 403));

// Conversation model: company models or the user's own connections only.
api.patch('/conversations/:id', requirePermission('models.use'), async (c) => {
  const id = c.req.param('id');
  if (userOfConversation(id) !== c.var.me.id) return bad(c, 'forbidden', 403);
  const { model } = await c.req.json().catch(() => ({}));
  if (model !== null && typeof model !== 'string') return bad(c, 'model must be a model id or null');
  if (model && !availableModels(c.var.me.id).some((m) => m.id === model)) return bad(c, 'This model is not available to you.', 403);
  db.prepare('UPDATE conversations SET model = ? WHERE id = ?').run(model, id);
  return c.json({ ok: true, model });
});
api.get('/models/available', requirePermission('models.use'), (c) => c.json(availableModels(c.var.me.id)));
api.route('/connectors', connectorRoutes);
api.route('/storage-addons', storageAddonRoutes);
api.route('/hub', hubRoutes({
  onMcpInstall: (me, target, list) => upsertHubConnectors(me.id, target === 'team' ? 'team' : 'private', list),
  onMcpUninstall: (me, target, id) => removeHubConnectors(me.id, target === 'team' ? 'team' : 'private', `hub:${id}`),
}));

// Per-user files; chat attachments land in the conversation's scratch dir.
api.use('/files', requireAuth);
api.use('/files/*', requireAuth);
api.route('/', storageRoutes((c) => c.get('me')?.id));
api.post('/conversations/:id/attachments', requirePermission('models.use'), async (c) => {
  const id = c.req.param('id');
  if (userOfConversation(id) !== c.var.me.id) return bad(c, 'forbidden', 403);
  return saveUploads(c, c.var.me.id, fsFor(c.var.me.id, id), '/tmp', (p) => p);
});

// `privacy.gliner` false = the redaction service runs without GLiNER (only allowed with HEFYN_ALLOW_NO_GLINER=1): show a red warning.
// `glinerSource` / `glinerState` / `glinerDetail` / `glinerHost`: where the model comes from and whether it is in place (see redact/download.ts).
const privacy = async () => {
  const [h, g] = await Promise.all([sidecarHealth(), glinerInfo()]);
  return { gliner: h.gliner, glinerSource: g.source, glinerState: g.state, glinerDetail: g.detail, glinerHost: g.host, imagesAllowed: imagesAllowed() };
};
api.get('/runtime', requireAuth, async (c) => c.json({ ...(await runtimeInfo()), privacy: await privacy() }));
api.get('/settings/privacy', requirePermission('models.manage'), async (c) => c.json({ allowImages: imagesAllowed(), ...(await privacy()) }));
// GLiNER cannot read images: by default the gate replaces them with text; this lets them through unredacted (audited as IMAGE_SENT_UNREDACTED).
api.post('/settings/privacy', requirePermission('models.manage'), async (c) => {
  const { allowImages } = await c.req.json().catch(() => ({}));
  if (typeof allowImages !== 'boolean') return bad(c, 'allowImages must be a boolean');
  setImagesAllowed(allowImages);
  return c.json({ allowImages });
});
// Source `local`: the admin uploads the pinned GLiNER files (multipart of the files, or one .tar/.zip). Every file is verified against the
// pinned size + SHA-256 before anything is written; anything else is rejected.
api.post('/settings/privacy/gliner/upload', requirePermission('models.manage'), async (c) => {
  if (sourceOf() !== 'local') return bad(c, 'uploads are only possible with HEFYN_GLINER_SOURCE=local', 409);
  if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD) return bad(c, 'upload too large', 413);
  try {
    const form = await c.req.formData().catch(() => { throw new UploadError(400, 'expected a multipart upload'); });
    const inputs = [];
    for (const v of form.values()) if (typeof v !== 'string') inputs.push({ name: v.name, data: new Uint8Array(await v.arrayBuffer()) });
    const saved = saveModelFiles(modelDir(), inputs);
    invalidateGlinerInfo();
    return c.json({ saved, ...(await glinerInfo()) });
  } catch (e) {
    if (e instanceof UploadError) return bad(c, e.message, e.status);
    return bad(c, `could not store the model files: ${(e as Error).message}`, 500);
  }
});
api.post('/runtime/restart', requirePermission('models.manage'), async (c) => (requestRestart(c.var.me.email), c.json(await runtimeInfo())));

api.get('/usage/me', requireAuth, (c) => c.json(usageSummary(c.var.me.id)));
api.get('/usage/all', requirePermission('usage.view_all'), (c) => c.json(usageSummary()));

// ---- models ----
api.get('/models', requirePermission('models.use', 'models.manage'), (c) => c.json(connectedModels()));
api.get('/models/providers', requirePermission('models.manage'), async (c) => c.json({ available: listProviders(), connected: await companyConnections() }));
api.post('/models/providers', requirePermission('models.manage'), async (c) => {
  const { provider, apiKey, baseUrl, models } = await c.req.json();
  if (!provider || !apiKey) return bad(c, 'provider and apiKey are required');
  const conn = { id: provider, baseUrl: baseUrl || undefined, models: Array.isArray(models) ? models : undefined };
  try {
    await validate(conn, apiKey);
    connect(conn, apiKey);
  } catch (e) {
    return bad(c, (e as Error).message);
  }
  return c.json({ ok: true });
});
api.delete('/models/providers/:id', requirePermission('models.manage'), (c) => (disconnect(c.req.param('id')), c.json({ ok: true })));

api.get('/profile', requirePermission('models.manage'), (c) => c.json(loadProfile()));
api.put('/profile', requirePermission('models.manage'), async (c) => {
  const { model, agents } = await c.req.json() as { model: string; agents: Record<string, string | null> };
  const known = new Set(connectedModels().flatMap((p) => p.models.map((m) => m.id)));
  if (!known.has(model)) return bad(c, 'Pick a model from a connected provider.');
  for (const m of Object.values(agents ?? {})) if (m && !known.has(m)) return bad(c, `Unknown model ${m}`);
  db.prepare('UPDATE profiles SET model = ? WHERE id = ?').run(model, DEFAULT_PROFILE);
  for (const [name, m] of Object.entries(agents ?? {})) db.prepare('UPDATE profile_agents SET model = ? WHERE profile_id = ? AND name = ?').run(m || null, DEFAULT_PROFILE, name);
  return c.json({ ok: true });
});

// ---- users ----
api.get('/users', requirePermission('users.manage'), (c) =>
  c.json(db.prepare('SELECT u.id, u.email, u.name, r.id AS roleId, r.name AS role FROM user u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id ORDER BY u.createdAt').all()));

// Invite = admin creates the account with a temporary password; signups are otherwise closed.
api.post('/users', requirePermission('users.manage'), async (c) => {
  const { name, email, password, roleId = WORKER_ROLE } = await c.req.json();
  if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(roleId)) return bad(c, 'Unknown role');
  try {
    const r = await auth.api.signUpEmail({ body: { name: name || email, email, password: password || randomUUID() }, headers: cleanedHeaders(c.req.raw.headers, peerOf(c)) });
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, roleId);
    return c.json({ id: r.user.id });
  } catch (e) {
    return bad(c, (e as Error).message);
  }
});

api.patch('/users/:id/role', requirePermission('users.manage'), async (c) => {
  const { roleId } = await c.req.json();
  const id = c.req.param('id');
  if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(roleId)) return bad(c, 'Unknown role');
  const cur = meFromUserId(id);
  if (!cur) return bad(c, 'Unknown user', 404);
  if (cur.roleId === ADMIN_ROLE && roleId !== ADMIN_ROLE && adminCount() <= 1) return bad(c, 'The last Admin cannot be demoted.', 409);
  db.prepare('UPDATE user_roles SET role_id = ? WHERE user_id = ?').run(roleId, id);
  return c.json({ ok: true });
});

// ---- roles ----
const parsePerms = (p: unknown) => (Array.isArray(p) && p.every(isPermission) ? (p as string[]) : undefined);

api.get('/roles', requirePermission('roles.manage', 'users.manage'), (c) =>
  c.json({ permissions: PERMISSIONS, roles: (db.prepare('SELECT id, name, builtin, permissions FROM roles ORDER BY builtin DESC, name').all() as any[]).map((r) => ({ ...r, builtin: !!r.builtin, permissions: JSON.parse(r.permissions) })) }));

api.post('/roles', requirePermission('roles.manage'), async (c) => {
  const { name, permissions } = await c.req.json();
  const perms = parsePerms(permissions);
  if (!name?.trim() || !perms) return bad(c, 'name and valid permissions are required');
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO roles (id, name, builtin, permissions) VALUES (?, ?, 0, ?)').run(id, name.trim(), JSON.stringify(perms));
    return c.json({ id });
  } catch {
    return bad(c, 'A role with this name already exists.', 409);
  }
});

api.patch('/roles/:id', requirePermission('roles.manage'), async (c) => {
  const id = c.req.param('id');
  const role = db.prepare('SELECT builtin FROM roles WHERE id = ?').get(id) as { builtin: number } | undefined;
  if (!role) return bad(c, 'Unknown role', 404);
  if (role.builtin) return bad(c, 'Built-in roles cannot be edited.', 409);
  const { name, permissions } = await c.req.json();
  const perms = permissions === undefined ? undefined : parsePerms(permissions);
  if (permissions !== undefined && !perms) return bad(c, 'invalid permissions');
  try {
    if (name?.trim()) db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(name.trim(), id);
    if (perms) db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(perms), id);
  } catch {
    return bad(c, 'A role with this name already exists.', 409);
  }
  return c.json({ ok: true });
});

api.delete('/roles/:id', requirePermission('roles.manage'), (c) => {
  const id = c.req.param('id');
  const role = db.prepare('SELECT builtin FROM roles WHERE id = ?').get(id) as { builtin: number } | undefined;
  if (!role) return bad(c, 'Unknown role', 404);
  if (role.builtin) return bad(c, 'Built-in roles cannot be deleted.', 409);
  db.prepare('UPDATE user_roles SET role_id = ? WHERE role_id = ?').run(WORKER_ROLE, id); // members fall back to Worker
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  return c.json({ ok: true });
});
