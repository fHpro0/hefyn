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

## Storage add-ons (external storage)

Code: `src/server/storage-addons.ts` (adapters, mount router), `storage-addon-routes.ts` (`/api/storage-addons`), `test/storage-addons.test.ts`.
Storage is the Docker volume, or an add-on the user or team connected. No cloud SDKs, nothing AWS/S3.

- **Mount**: an add-on called `nextcloud` is the folder `/files/nextcloud/...` for the Files page, uploads/downloads and the agent's file tools
  (`read`, `write`, `edit`, `list`), in the file-only sandbox and in the container sandbox alike (`withAddons(fs, userId)` routes the path before the
  host dir or the container sees it). Names are lowercase slugs (`[a-z0-9][a-z0-9-]{0,39}`) and unique among what the user can see. A name that
  already exists as a local folder is refused when the add-on is created; an add-on shadows a same-named local folder that appears later (e.g. made by a shell).
  Moving between a local folder and an add-on, or between add-ons, and renaming/deleting the mount itself are refused (download and upload instead).
- **Shell commands cannot reach add-ons**: `bash`, `grep`, `glob` run inside the container, which only has the local volume. Agents use the
  read/write/edit/list tools for `/files/<add-on>/...` (the `list` tool shows add-ons as folders).
- **Quota**: add-on bytes are never counted against `HEFYN_USER_QUOTA_MB` and never blocked by it; the per-file limit `HEFYN_MAX_UPLOAD_MB` applies to every read and write (streams are cut off at the limit).
- **Downloads** from an add-on are streamed through hefyn and keep the same headers as local files (`attachment`, `application/octet-stream`, `nosniff`, CSP sandbox).
- **Privacy**: what an agent reads from an add-on reaches the model only as a tool result, so it goes through the redaction gate like everything else
  (tested: an email inside a WebDAV file shows up as `{{var:EMAIL_1}}` in the audit payload and is never sent). The Files page and downloads are the user's own view, not model traffic.
- **Egress**: the agent only reaches the internet through the egress proxy, whose allowlist is global (the proxy cannot tell users apart). Hosts of connected WebDAV add-ons are
  therefore added to the allowlist for everyone (like MCP connector hosts); MCP storage hosts are already there. A host is listed as long as one add-on of any user points at it.

### Kinds

| Kind | What it is | Notes |
|---|---|---|
| WebDAV | Nextcloud, ownCloud, most NAS. Base URL + username + app password | Plain `fetch` (PROPFIND/GET/PUT/MKCOL/DELETE/MOVE), no dependency. https only (http only with `HEFYN_ALLOW_PRIVATE_URLS=1` for dev/tests), private/internal hosts refused (same guard as connectors), no credentials in the URL. Redirects are followed only inside the same origin; a redirect to another host is refused and the credentials are never sent there. Names are sent percent-encoded, `..`/`.` segments are refused before any request, and PROPFIND answers naming paths outside the requested folder are ignored |
| MCP storage | An existing MCP connector the user marks as storage | Needs the official filesystem server's tools. Detected per call: `list_directory(_with_sizes)`, `read_text_file`/`read_file`, `write_file`, `create_directory`, `move_file`, `get_file_info`, `list_allowed_directories` (its first directory is the root); optional `delete_file`/`delete`. Missing write tools make it read only (writes fail with 403); the official server has no delete tool. Text files only (binary writes are refused with 415; binary reads are not supported by the text tools) |

### Visibility and credentials

Same rules as team MCP connectors: the definition is private (owner) or team (visible to all, `profiles.edit_team` to create); credentials are always per user.
A team WebDAV add-on shows as "needs sign-in" until each user sets their own username and app password (`PUT /api/storage-addons/:id/credentials`).
A **shared account** exists only when a team editor explicitly creates the add-on with `sharedAccount: true`; only editors can replace its login. An MCP add-on follows its
connector: private connector = private add-on (only the connector owner can mark it), team connector = team add-on (team editors), and each user's own bearer token/OAuth sign-in on the connector is used.
Removing the connector removes the mount. WebDAV passwords are encrypted (AES-GCM, `HEFYN_SECRET`) in `storage_addon_creds`; the API never returns them.

### Limits

- Every operation opens a new connection (MCP: connect + `tools/list` + call). Fine for browsing; cache sessions if a server is slow.
- Uploads/downloads are buffered per file for MCP and streamed for WebDAV reads; WebDAV uploads are buffered (max `HEFYN_MAX_UPLOAD_MB`).
- DNS rebinding is not covered by the URL guard (hostname check only, as for connectors).
- MCP storage listings have no modified time; sizes only with `list_directory_with_sizes`.

## Known limits

- TOCTOU between realpath check and use is not closed (needs a local attacker able to create symlinks; the agent has no shell).
- Quota is computed by walking the tree on each write (fine for small areas; cache if it gets slow). Concurrent writes can overshoot slightly.
- Uploads are buffered in memory (max `HEFYN_MAX_UPLOAD_MB` per file; Hono parses the whole form first).
