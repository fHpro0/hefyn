# Hub API contract

The console's own, session-bound endpoints; no external client calls them. They are the `hub.*` tRPC procedures (`src/server/routers/hub.ts`, `docs/API.md`). All need a session. No console page calls them since the Hub page moved to `old/` (2026-10-27); the Skills page and Add agent use `hub.ts` directly (`docs/HUB.md`). Permissions: `hub.install`, `hub.publish`, `hub.approve`, `profiles.edit_team`, `modules.manage`.

```ts
type Kind = 'skill' | 'agent' | 'mcp' | 'bundle' | 'module' | 'assistant';
// module: carries hefyn.module.json (docs/MODULES.md), installed by src/modules/installed.ts, needs modules.manage.
// assistant: a user's Assistant shared for review (src/server/assistant-share.ts); visible to its owner and reviewers only, never installable; approving it creates the team copy.
interface Pkg {
  id: string; kind: Kind; name: string; description: string; version: string; hash: string;
  source: { type: 'ui' | 'git' | 'marketplace' | 'mcp-registry'; url?: string; ref?: string };   // git = GitHub or GitLab
  visibility: 'private' | 'team';
  status: 'draft' | 'pending' | 'approved' | 'rejected'; rejectReason?: string;
  owner: { id: string; name: string };
  installed: { me: boolean; team: boolean };
  guard: { flagged: boolean; reasons: string[] };
  contains?: { skills: string[]; agents: string[]; mcp: string[] };   // bundles
  createdAt: string; updatedAt: string;
}
```

| Procedure | Input | Returns | Permission |
|---|---|---|---|
| `hub.list` (query) | `{q?, kind?, status?, mine?: boolean}` | `Pkg[]` (team-approved and own; reviewers also see pending team packages) | any |
| `hub.get` | `{id}` | `Pkg & { manifest: object; files: {path,size}[]; readme?: string }` | can see |
| `hub.file` | `{id, path}` | file text | can see |
| `hub.create` (mutation) | skill: `{kind,name,description,instructions,files?:{path,content}[]}` · agent: `{kind,name,description,instructions,model?,thinking?,skills?:string[]}` · mcp: `{kind,name,url,transport,auth:'none'\|'bearer'\|'oauth',storage?:true}` · module: `{kind,manifest}` | `Pkg` (draft, private) | `hub.install` |
| `hub.update` | `{id, body}` (same fields) | `Pkg` (a new version goes back to draft or pending) | owner |
| `hub.delete` | `{id}` | `{ok}` | owner or `hub.approve` |
| `hub.import` | `{url, ref?}`: `https://github.com/o/r[/tree/ref/path]`, a GitLab project `https://<host>/g/p[/-/tree/ref/path]` (gitlab.com or self-hosted, public, https), or a `https://skillsmp.com/skills/<slug>` page (resolved to its GitHub URL). Contents: SKILL.md dirs, `.claude-plugin/plugin.json`, `agents/*.md`, `.mcp.json`, or a `marketplace.json` | `Pkg[]` (private drafts) | `hub.install` |
| `hub.skillsmpSearch` (query) | `{q, page?}` (cached 10 min; fails with a "limit reached" message when the quota is used up) | `{skills: {id,name,author,description,stars,updatedAt,githubUrl,skillUrl}[], page, hasNext}` | `hub.install` |
| `hub.registrySearch` (query) | `{q}` (official MCP Registry) | `{name,description,url,transport,repository?}[]` | `hub.install` |
| `hub.registryImport` | `{name}` | `Pkg` | `hub.install` |
| `hub.publish` | `{id}` | `Pkg` (pending; approved at once if the caller has `hub.approve`) | `hub.publish` |
| `hub.approve` | `{id}` | `Pkg` | `hub.approve` |
| `hub.reject` | `{id, reason?}` | `Pkg` | `hub.approve` |
| `hub.install` | `{id, target:'me'\|'team'}` | `Pkg` | `hub.install` (and `profiles.edit_team` for `team`; `modules.manage` for a module) |
| `hub.uninstall` | `{id, target}` | `Pkg` | same |
| `hub.installed` (query) | none | `{me: Pkg[]; team: Pkg[]}` | any |
| `hub.review` (query) | none | `Pkg[]` (pending) | `hub.approve` |

Errors are `HubError` (`src/server/hub.ts`) with a status of 400, 403, 404, 409 or 502.

## Rules

- Installing needs `approved` (or the owner's own private package, target `me`).
- Every import, create and update runs the prompt-injection guard over all text. `guard.flagged` is shown to reviewers and the package is never auto-approved.
- Plugin `hooks/` and `commands/` are ignored (listed in `manifest.ignored`). Files are stored in the database and handled as text only.
- Installing an `mcp` package creates a per-user entry in Connectors (`mine: true`, `source: 'hub:<packageId>'`). Bearer and OAuth sign-in happens there ("Sign-in needed" until done). No credentials are stored by the hub.
- In `hub.get`, `manifest` holds the editable fields: skill `{instructions}`, agent `{instructions, model?, thinking?, skills: string[]}` (skill names), mcp `{url, transport, auth}`; plus `ignored: string[]`.
- `storage: true` on an mcp package marks a server with filesystem-style tools. The flag is kept in the manifest, but the "use as storage" step it fed (Settings, Storage add-ons) moved to `old/`. Files connections of kind `mcp` pick the user's own MCP servers instead (`docs/STORAGE.md`).
- No version-history procedure.
