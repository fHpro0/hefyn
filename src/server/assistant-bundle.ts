import { type Files, parts, summary, unpack } from '../assistants/bundle.ts';
import type { Seed } from '../cli-agents/profiles.ts';
import { db } from './appdb.ts';

// An Assistant's bundle (src/assistants/bundle.ts) in the database and in a chat. profiles.bundle holds a saved Assistant's files; a test chat of the editor carries its draft's in conversations.bundle.

/** Where a chat finds its copy of the Assistant's extra files. /tmp is the chat's own folder in the sandbox (the seed script writes only there), so every chat has a fresh copy. */
export const EXTRA_DIR = '/tmp/assistant';

const read = (blob: unknown): Files | undefined => {
  if (!(blob instanceof Uint8Array) || !blob.length) return;
  try { return unpack(blob); } catch { return; } // a stored bundle that no longer reads is no bundle
};

export const bundleOf = (assistantId: string): Files | undefined => read((db.prepare('SELECT bundle FROM profiles WHERE id = ?').get(assistantId) as { bundle: unknown } | undefined)?.bundle);
/** What the editor's diagram draws: the extra files and the bundled skills. */
export const bundleView = (files?: Files) => summary(files ?? {});

/** The bundle a conversation runs on: its test snapshot's draft files, else its Assistant's. `fresh`: the chat has no copy of the extra files yet. */
export function chatBundle(conversationId: string) {
  const c = db.prepare('SELECT assistant_id, snapshot, bundle, bundle_seeded FROM conversations WHERE id = ?').get(conversationId) as { assistant_id: string | null; snapshot: string | null; bundle: unknown; bundle_seeded: number } | undefined;
  const files = c?.snapshot ? read(c.bundle) : c?.assistant_id ? bundleOf(c.assistant_id) : undefined;
  return files && { ...parts(files), fresh: !c!.bundle_seeded };
}

/** The extra files as seeds into the chat's own folder. */
export const extraSeeds = (extra: Files): Seed[] => Object.entries(extra).map(([p, text]) => ({ path: `${EXTRA_DIR}/${p}`, text }));
/** The chat has its copy: later starts leave /tmp/assistant alone, whatever the person or an Assistant edit does. */
export const markSeeded = (conversationId: string) => void db.prepare('UPDATE conversations SET bundle_seeded = 1 WHERE id = ?').run(conversationId);
