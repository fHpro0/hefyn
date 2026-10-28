# hefyn — Data

Collections and records you define yourself (tasks, projects, time bookings, anything), shown PocketBase-style under **Data**, and usable by the chat agent. Phase 2 builds screens on top of the query API below.

## Model

- **Collection**: `id (dc_…), scope (personal | team), name, slug, icon, description, fields[], access (team)`. A personal collection belongs to its owner. A team collection has `access: {view: roleIds, edit: roleIds}` (edit implies view). The scope cannot change after creation.
- **Record**: `id, created, updated, createdBy, updatedBy, values` (one value per field, `null` = empty).
- **Field**: `{id, name, type, required, unique, default, …}`. `id` is stable and lets a rename keep its values; `name` (`[A-Za-z_][A-Za-z0-9_]*`, max 40; not `id created updated createdBy updatedBy expand values`) is what records, filters and CSV use.

| type | value | options |
|---|---|---|
| text, longtext | string (5 000 / 100 000 chars) | `unique` (text) |
| number | finite number | `min`, `max`, `integer`, `unique` |
| bool | true / false (never empty) | |
| date | `YYYY-MM-DD` | default `@today` |
| datetime | ISO 8601, stored as UTC | default `@now` |
| select | one of `options` (list if `multiple`) | `options`, `multiple` |
| relation | record id (list if `multiple`) of `collection` (a collection id, `self`, or `users`) | `multiple`; users default `@me` |
| email | lower-cased address | `unique` |
| url | `http(s)` URL only | |
| json | any JSON, ≤ 64 KB | |
| duration | whole minutes ≥ 0 (UI: h:mm) | |

`@today`, `@now`, `@me` are also accepted as a value (agents use them) and stand for what they name. **File** fields are not in phase 1 (Files stays the place for files).

Relations must point at records the writer can read. A team collection can only relate to team collections and users. Deleting a record or collection does not touch references to it (they show as missing); deleting a collection that another visible collection relates to is refused.

## Schema changes

`PATCH /collections/:c {fields}` replaces the field list. Fields are matched by `id`: a different `name` renames (values kept), a missing one is dropped with its values, a new one gets its default. Type, `multiple` and the relation target of an existing field cannot change (add a new field, delete the old one). Removed select options are cleared. All records are re-validated in one transaction; if any would no longer fit (a new required field without default, a new `unique` over duplicates) nothing changes (`409`).

## Filter, sort, search

`filter` is a small expression, parsed by a hand-written parser into an AST (no eval, no SQL; strings are only ever compared):

```
status != "done" && (due <= @today || priority = "high")
project.name ~ "web" && billable = true && date >= @weekStart && date <= @weekEnd
```

- Operators `= != > >= < <= ~ !~` (`~` = contains, case-insensitive; `=` is exact). Join with `&&`, `||`, group with `( )`.
- Values: `"text"` or `'text'` (escape with `\`), numbers, `true`, `false`, `null` (empty), `@now @today @me @weekStart @weekEnd @monthStart @monthEnd` (Monday–Sunday; the server's time zone, set `TZ`).
- Fields: your own plus `id created updated createdBy updatedBy`. One relation level: `project.name` (users: `assignee.name`). For fields with several values `=` means "contains".
- A date compared with a datetime: `=` matches the whole day; `<=` and `>` mean the end of that day (UTC).
- Errors are `400` with the position: `filter: put text in quotes: "x" (at position 8)`. Limits: 2 000 characters, 200 tokens, 20 levels of parentheses.
- `sort=-due,title` (max 5 keys, empty values last, ties by creation order; default `-created`). `q=` searches the text-like fields. `expand=project,assignee` adds `expand` (a record, or `{id, name}` for users) one level deep, skipped silently if the related collection is not readable. `perPage` ≤ 500 (default 30).

## Storage and encryption

`data_collections` holds `id, scope, owner_id, access (role ids), enc, timestamps`; `enc` seals `{name, slug, icon, description, fields}` with AAD `datacol:<id>`. `data_records` holds `id, collection_id, created/updated at and by`, and `data` sealed with AAD `rec:<collection>:<id>`. Personal collections use the owner's user key, team collections the team key (see [ENCRYPTION.md](ENCRYPTION.md): strict mode, server key mode and unlock work as for every sealed value). So app.db holds no names, field names or values, and a ciphertext moved to another row does not open. A locked user key answers `423`; a locked team key hides team collections (`teamLocked: true`) until an admin signs in. Metadata that stays readable: ids, scope, owner, role ids in `access`, timestamps, who created or changed a record, record counts.

Queries open the records in memory, then filter, sort and page there. **Shortcut: a collection holds at most 20 000 records** (`409` with advice beyond that). Upgrade when a query takes about a second: keep an index of sealed-free fields (e.g. dates and ids) or move the collection to its own table. Unique checks also run in memory, inside the write transaction.

## Permissions

- `data.use` (Admin, Worker): personal collections; team collections as their access allows (view: read; edit: records; both through the role of the user). Without it, nothing under `/api/data` and no agent tools.
- `data.manage` (Admin): create team collections, change their schema, settings and access; always sees all team collections. Instances that already had a Worker role got `data.use` once at upgrade.

## CSV

Export writes a header of field names; lists join with `|`, json is JSON, duration is minutes. Text-like cells starting with `= + - @` get a leading `'` (spreadsheet formula guard), removed on import. Import maps header → field (case-insensitive name, or an explicit `mapping`, `null` skips a column), accepts `h:mm` for durations, validates every row like a normal write and is all-or-nothing unless `skipInvalid`; `dryRun` reports without writing. Limits: 5 MB, 20 000 rows.

## Agent tools

For users with `data.use` who can see a collection, chats get `data_collections()` (names, slugs, fields, counts, today's date), `data_query({collection, filter?, sort?, limit? ≤ 200})`, `data_create({collection, values})`, `data_update({collection, id, values})`. Relations come back as `{id, label}`. Errors are returned as `Error: …` text so the model can retry. There is no delete tool. Results are ordinary tool results and reach the model as they are.
