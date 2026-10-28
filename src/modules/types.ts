import type { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { StorageProvider } from '../server/connections/types.ts';

// Slots of docs/MODULES.md and docs/HARNESS.md that the built-in modules use. `permission` as a list means any of them.
type Needs = string | string[];

/** One sealed table the key code must know about: key rotation / migration to strict re-seals `cols`, "start fresh" drops the rows. */
export interface SealedSpec { sql: string; args: unknown[]; table: string; where: string[]; cols: Record<string, (r: any) => string>; server: boolean }

type Me = { id: string; permissions: string[] };
type Query = (key: string) => string | undefined;

export interface HefynModule {
  id: string;
  name: string;
  description?: string;
  /** lucide icon name */
  icon?: string;
  /** Can be switched off (instance setting `modules_disabled` / env HEFYN_MODULES_DISABLED, read at boot). A disabled module registers nothing. */
  optional?: boolean;
  /** `worker`: granted to the Worker role once, when the module first appears (an admin may remove it later). */
  permissions?: { id: string; label: string; hint?: string; group?: string; worker?: boolean }[];
  /** `group` (settings only): "you" = personal pages, "workspace" = admin pages; default "you". */
  nav?: { place: 'main' | 'settings'; label: string; href: string; icon?: string; permission?: Needs; order?: number; group?: 'you' | 'workspace' }[];
  commands?: { label: string; href: string; icon?: string; permission?: Needs; order?: number }[];
  /** built-in modules only: mounted under /api */
  routes?: { path: string; app: Hono<any> }[];
  /** Idempotent, runs at boot in every process that loads the module (web and agent). Tables, and columns on `conversations` the module owns. */
  migrate?: (db: DatabaseSync) => void;
  /** The module's sealed columns (user key / team key); the core key code loops over these. */
  sealed?: { user?: (userId: string) => SealedSpec[]; team?: () => SealedSpec[] };
  /** Called inside the chat-delete transaction for every deleted conversation of the user. */
  onConversationDelete?: (conversationId: string, userId: string) => void;
  /** Called by "start fresh" (the user's sealed data is gone): remove the module's rows of this user. */
  onUserDelete?: (userId: string) => void;
  conversation?: {
    /** POST /api/conversations: may refuse, add columns to the INSERT and fields to the answer. */
    create?: (ctx: { me: Me; body: any }) =>
      { error?: [string, 400 | 403]; columns?: Record<string, unknown>; response?: Record<string, unknown> } | void;
    /** GET /api/conversations: extra select expressions (aliased), an optional filter from the query string, and the output fields of a row. */
    list?: { select?: string[]; filter?: (q: Query) => { sql: string; args: unknown[] } | undefined; fields?: (row: any) => Record<string, unknown> };
    /** PATCH /api/conversations/:id: the body keys the module owns; validate first (an error text refuses everything), then apply. */
    patch?: { keys: string[]; validate: (ctx: { userId: string; id: string }, body: any) => string | undefined; apply: (ctx: { userId: string; id: string }, body: any) => void };
    /** POST /api/conversations/bulk: extra actions; `meta` turns the request into the fields chat metadata takes. */
    bulk?: Record<string, { validate: (ctx: { userId: string }, body: any) => string | undefined; meta: (body: any) => Record<string, unknown> }>;
  };
  /** built-in modules only: kinds of Files connection (WebDAV, SFTP…) the user can add; registered with `ctx.storage` while the module is loaded. */
  storageProviders?: StorageProvider[];
  /** Background loops, started once in the web process; a failing run is logged and the loop goes on. */
  jobs?: { name: string; everyMs: number; first?: number; init?: () => void; run: () => unknown }[];
}

export const defineModule = (m: HefynModule): HefynModule => m;
