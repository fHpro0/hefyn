# Hub API contract (v1) — shared by backend and UI

All under `/api/hub`, session required. Permissions: hub.install, hub.publish, hub.approve, profiles.edit_team.

Package
```ts
type Kind = 'skill' | 'agent' | 'mcp' | 'bundle';
interface Pkg {
  id: string; kind: Kind; name: string; description: string; version: string; hash: string;
  source: { type: 'ui' | 'git' | 'marketplace' | 'mcp-registry'; url?: string; ref?: string };
  visibility: 'private' | 'team';
  status: 'draft' | 'pending' | 'approved' | 'rejected'; rejectReason?: string;
  owner: { id: string; name: string };
  installed: { me: boolean; team: boolean };
  guard: { flagged: boolean; reasons: string[] };
  contains?: { skills: string[]; agents: string[]; mcp: string[] };   // bundles
  createdAt: string; updatedAt: string;
}
```

| Method | Path | Body / query | Returns | Permission |
|---|---|---|---|---|
| GET | /packages | ?q=&kind=&status=&mine=1 | Pkg[] (team-approved + own) | any |
| GET | /packages/:id | | Pkg & { manifest: object; files: {path,size}[]; readme?: string } | can see |
| GET | /packages/:id/file | ?path= | text/plain (no HTML) | can see |
| POST | /packages | skill: {kind,name,description,instructions,files?:{path,content}[]} · agent: {kind,name,description,instructions,model?,skills?:string[]} · mcp: {kind,name,url,transport,auth:'none'\|'bearer'\|'oauth'} | Pkg (draft, private) | hub.install |
| PATCH | /packages/:id | same fields | Pkg (new version → back to draft/pending) | owner |
| DELETE | /packages/:id | | 204 | owner or hub.approve |
| POST | /import | {url, ref?} (git URL: SKILL.md dirs, `.claude-plugin/plugin.json`, `agents/*.md`, `.mcp.json`, or a `marketplace.json`) | Pkg[] (private drafts) | hub.install |
| GET | /registry/mcp | ?q= (official MCP Registry search) | {name,description,url,transport,repository?}[] | hub.install |
| POST | /registry/mcp/import | {name} | Pkg | hub.install |
| POST | /packages/:id/publish | | Pkg (status pending; approved directly if caller has hub.approve) | hub.publish |
| POST | /packages/:id/approve | | Pkg | hub.approve |
| POST | /packages/:id/reject | {reason} | Pkg | hub.approve |
| POST | /packages/:id/install | {target:'me'\|'team'} | Pkg | hub.install (+ profiles.edit_team for team) |
| DELETE | /packages/:id/install | ?target=me\|team | Pkg | same |
| GET | /installed | | {me: Pkg[]; team: Pkg[]} | any |
| GET | /review | | Pkg[] (pending) | hub.approve |

Rules: installing requires `approved` (or own private package for target `me`). Every import/create/update runs the
prompt-injection guard over all text; `guard.flagged` is shown to reviewers, never auto-approved. Plugin `hooks/` and
`commands/` are ignored (listed in manifest as `ignored`). Files are stored in the DB, served as text only.
Installed for an agent run = team installs + caller's own installs: skills → `useSkill`, agents → subagents,
mcp → MCP connections (same auth handling as Connectors).

## Clarifications (v1.1)
- `GET /packages/:id` → `manifest` holds the editable fields: skill `{instructions}`, agent `{instructions, model?, skills: string[]}`
  (skill **names**), mcp `{url, transport, auth}`; plus `ignored: string[]` (paths of hooks/commands not installed).
- MCP packages never store credentials. Installing one creates a per-user entry in Connectors (`/api/connectors/mcp`,
  `mine: true`, `source: 'hub:<packageId>'`); bearer/OAuth sign-in happens there ("Sign-in needed" until done).
- No version history endpoint in v1.
