# Per-user storage

Code: `src/server/storage.ts` (core + Flue sandbox), `src/server/storage-routes.ts` (Hono router), `test/storage.test.ts`.

## Layout

`$HEFYN_DATA_DIR` (default `./data`)`/users/<userId>/files/` persistent, `.../tmp/<conversationId>/` scratch.
Agents see `/files/...` and `/tmp/...` (tmp = the current conversation's dir); everything else is rejected. Dirs are created lazily.

| Env | Default | Meaning |
|---|---|---|
| `HEFYN_USER_QUOTA_MB` | 1024 | per user, `files/` + `tmp/` |
| `HEFYN_MAX_UPLOAD_MB` | 100 | single file |

## Flue driver notes

- `sandboxFromDriver(driver, '/files')` needs `readFile, readFileBuffer, writeFile, stat, readdir, exists, mkdir, rm, exec`. It resolves and `..`-collapses paths before the driver sees them; the driver re-validates anyway.
- `writeFile` is retried once after `mkdir -p` of the parent by the wrapper; our `writeFile` also creates the (validated) parent itself.
- Default `grep`/`glob`/`bash` tools run through `exec`, so `userSandboxFactory` replaces the tool set with `read`, `write`, `edit` and a small `list` tool (documented pattern for exec-less sandboxes). `exec` throws `SandboxOperationUnsupportedError` ("shell commands come with the container sandbox").
- Delegates inherit the parent sandbox, so they share the conversation's `/tmp`.

## Wiring (not done yet)

`src/agents/configurable.ts` (the agent receives `{ id }` = conversation id `u_<userId>_<ulid>`):

```ts
import { userSandboxFactory } from '../server/storage.ts';
import { userOfConversation } from '../server/storage.ts';
export function Configurable({ id }: AgentProps) {
  ...
  const userId = userOfConversation(id);
  if (userId) useSandbox(userSandboxFactory({ userId, conversationId: id }), { cwd: '/files' });
```

`src/app.ts` / `api.ts`:

```ts
import { storageRoutes } from './server/storage-routes.ts';
import { cleanupTmp, deleteUserStorage, deleteConversationTmp } from './server/storage.ts';
api.route('/', storageRoutes((c) => c.get('user')?.id));          // behind the session middleware, under /api
setInterval(() => cleanupTmp({ olderThanDays: 7 }).catch(console.error), 6 * 3600_000).unref();
// user deletion handler: await deleteUserStorage(userId);   conversation deletion: await deleteConversationTmp(userId, convId);
```

## Security checks (all tested)

`..` segments, absolute paths outside `/files` `/tmp`, backslashes, NUL, path/segment length, user/conversation id charset,
symlinks to outside (existing, via a directory, dangling, deep new path), realpath on the deepest existing ancestor for every op,
`rm`/`rename` act on the link itself (never follow), roots cannot be removed, downloads are `application/octet-stream` + `attachment` + `nosniff` + CSP sandbox.

## Known limits

- TOCTOU between realpath check and use is not closed (needs a local attacker able to create symlinks; the agent has no shell).
- Quota is computed by walking the tree on each write (fine for small areas; cache if it gets slow). Concurrent writes can overshoot slightly.
- Uploads are buffered in memory (max `HEFYN_MAX_UPLOAD_MB` per file; Hono parses the whole form first).
