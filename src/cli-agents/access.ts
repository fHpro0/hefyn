import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../server/appdb.ts';
import { DbCredentialStore, nsId } from '../server/connectors.ts';
import { build } from '../server/providers.ts';
import { openProviderSecret } from '../server/seal.ts';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { chatBase } from './providers.ts';

// Which Anthropic connection a hosted CLI agent may use. Shared by the gateway (agent process) and the availability query (web); no Flue imports.

export class Refused extends Error {
  status: number; type: string; detail?: string; // detail: the technical reason, for the audit row (the message is for the user)
  constructor(status: number, type: string, message: string, detail?: string) { super(message); this.status = status; this.type = type; this.detail = detail; }
}

/** The key the admin picked for the agent (cli_agents.key_provider): while set, the company's connection of that provider is used and the user's own is ignored.
 *  Carried in async context so the two gateway fronts need no change; null/unset = automatic (the user's own key first, then the company's). */
export const keyPolicy = new AsyncLocalStorage<{ provider: string | null; /** the provider the agent session runs on (the session decides it, never the sandbox); unset = the agent's own API's */ session?: string }>();
const pinned = (provider: string) => keyPolicy.getStore()?.provider === provider;

/** Only API-key credentials: a Claude subscription (OAuth) may not be used in another product (Anthropic's terms). Throws Refused. */
export async function anthropicUpstream(userId: string) {
  const own = pinned('anthropic') ? undefined : db.prepare("SELECT base_url FROM user_credentials WHERE user_id = ? AND provider = 'anthropic'").get(userId) as { base_url: string | null } | undefined;
  let provider = 'anthropic', key: string, baseUrl: string | null;
  if (own) {
    const cred = await new DbCredentialStore(userId).read('anthropic');
    if (cred?.type !== 'api_key' || !cred.key) throw new Refused(403, 'permission_error', 'Your connected Anthropic account is a Claude subscription (sign-in). Anthropic does not allow subscriptions to be used in other products: connect an Anthropic API key instead. Nothing was sent to the model.');
    provider = nsId(userId, 'anthropic'); key = cred.key; baseUrl = own.base_url;
  } else {
    const co = db.prepare("SELECT id, base_url, enc_key, kind FROM providers WHERE id = 'anthropic'").get() as { id: string; base_url: string | null; enc_key: string; kind: string } | undefined;
    if (!co) throw new Refused(403, 'permission_error', 'No Anthropic API key is connected in hefyn (yours or the company\'s). Nothing was sent to the model.');
    if (co.kind === 'oauth') throw new Refused(403, 'permission_error', 'The company\'s Anthropic connection is a Claude subscription (sign-in). Anthropic does not allow subscriptions to be used in other products: an admin must connect an API key. Nothing was sent to the model.');
    key = openProviderSecret(co); baseUrl = co.base_url;
  }
  const root = (baseUrl ?? (build({ id: 'anthropic' }, 'x').getModels()[0] as any).baseUrl as string).replace(/\/+$/, '');
  return { provider, key, root };
}

/** Only API-key credentials: a ChatGPT sign-in (OAuth) may not be used in another product (OpenAI's terms). Root has no `/v1`. Throws Refused. */
export async function openaiUpstream(userId: string) {
  const own = pinned('openai') ? undefined : db.prepare("SELECT base_url FROM user_credentials WHERE user_id = ? AND provider = 'openai'").get(userId) as { base_url: string | null } | undefined;
  let provider = 'openai', key: string, baseUrl: string | null;
  if (own) {
    const cred = await new DbCredentialStore(userId).read('openai');
    if (cred?.type !== 'api_key' || !cred.key) throw new Refused(403, 'permission_error', 'Your connected OpenAI account is a ChatGPT sign-in. OpenAI does not allow sign-ins to be used in other products: connect an OpenAI API key instead. Nothing was sent to the model.');
    provider = nsId(userId, 'openai'); key = cred.key; baseUrl = own.base_url;
  } else {
    const co = db.prepare("SELECT id, base_url, enc_key, kind FROM providers WHERE id = 'openai'").get() as { id: string; base_url: string | null; enc_key: string; kind: string } | undefined;
    if (!co) throw new Refused(403, 'permission_error', 'No OpenAI API key is connected in hefyn (yours or the company\'s). Nothing was sent to the model.');
    if (co.kind === 'oauth') throw new Refused(403, 'permission_error', 'The company\'s OpenAI connection is a ChatGPT sign-in. OpenAI does not allow sign-ins to be used in other products: an admin must connect an API key. Nothing was sent to the model.');
    key = openProviderSecret(co); baseUrl = co.base_url;
  }
  const root = (baseUrl ?? (build({ id: 'openai' }, 'x').getModels()[0] as any).baseUrl as string).replace(/\/+$/, '').replace(/\/v1$/, '');
  return { provider, key, root };
}

/** The upstream of an agent session on an OpenAI-compatible provider (OpenRouter, Mistral, Groq, a custom endpoint ...): the user's own API key for it first (unless the admin pinned the company's),
 *  else the company's. Root includes whatever version path the provider's base URL has: the request goes to `<root>/chat/completions`. Throws Refused. */
export async function chatUpstream(userId: string, id: string) {
  const label = PROVIDER_LABEL(id);
  const own = pinned(id) ? undefined : db.prepare('SELECT base_url FROM user_credentials WHERE user_id = ? AND provider = ?').get(userId, id) as { base_url: string | null } | undefined;
  let provider = id, key: string, baseUrl: string | null;
  if (own) {
    const cred = await new DbCredentialStore(userId).read(id);
    if (cred?.type !== 'api_key' || !cred.key) throw new Refused(403, 'permission_error', `Your connected ${label} account is a sign-in. Connect a ${label} API key instead. Nothing was sent to the model.`);
    provider = nsId(userId, id); key = cred.key; baseUrl = own.base_url;
  } else {
    const co = db.prepare('SELECT id, base_url, enc_key, kind FROM providers WHERE id = ?').get(id) as { id: string; base_url: string | null; enc_key: string; kind: string } | undefined;
    if (!co) throw new Refused(403, 'permission_error', `No ${label} API key is connected in hefyn (yours or the company's). Nothing was sent to the model.`);
    if (co.kind === 'oauth') throw new Refused(403, 'permission_error', `The company's ${label} connection is a sign-in, not an API key. An admin must connect an API key. Nothing was sent to the model.`);
    key = openProviderSecret(co); baseUrl = co.base_url;
  }
  let root = (baseUrl ?? chatBase(id))?.replace(/\/+$/, '');
  if (!root) throw new Refused(403, 'permission_error', `${label} has no OpenAI-compatible address in hefyn. An admin must set one under Settings, Agents & keys. Nothing was sent to the model.`);
  if (id === 'openai') root = `${root.replace(/\/v1$/, '')}/v1`; // the Responses upstream stores the root without it
  return { provider, key, root };
}
const PROVIDER_LABEL = (id: string) => (id === 'custom' ? 'custom' : (builtinProviders().find((p) => p.id === id)?.name ?? id));

/** Why an agent cannot run on provider `id` for this user, in plain words (undefined = usable). */
export async function providerProblem(userId: string, id: string): Promise<string | undefined> {
  if (id === 'anthropic') return anthropicProblem(userId);
  if (id === 'openai') return openaiProblem(userId);
  try { await chatUpstream(userId, id); return; } catch (e) {
    if (!(e instanceof Refused)) return 'Your data is locked. Sign in again.';
    return /No .* API key/.test(e.message) ? `No ${PROVIDER_LABEL(id)} API key is connected yet. Connect one under Settings, Agents & keys.` : e.message.replace(/ Nothing was sent to the model\.$/, '');
  }
}

/** Why Claude Code cannot be used with the user's Anthropic connection, in plain words (undefined = usable). Does not need the key itself, except to tell a sign-in from a key for the user's own connection. */
export async function anthropicProblem(userId: string): Promise<string | undefined> {
  try { await anthropicUpstream(userId); return; } catch (e) {
    if (!(e instanceof Refused)) return 'Your data is locked. Sign in again.';
    if (/No Anthropic API key/.test(e.message)) return 'No Anthropic API key is connected yet. Connect one under Settings, Agents & keys.';
    return /company/.test(e.message) ? 'The company\'s Anthropic connection is a Claude subscription sign-in, which Anthropic does not allow here. An admin needs to connect an API key.' : 'Your Anthropic connection is a Claude subscription sign-in, which Anthropic does not allow here. Connect an API key instead.';
  }
}

/** The same for an agent that speaks the OpenAI Responses API. */
export async function openaiProblem(userId: string): Promise<string | undefined> {
  try { await openaiUpstream(userId); return; } catch (e) {
    if (!(e instanceof Refused)) return 'Your data is locked. Sign in again.';
    if (/No OpenAI API key/.test(e.message)) return 'No OpenAI API key is connected yet. Connect one under Settings, Agents & keys.';
    return /company/.test(e.message) ? 'The company\'s OpenAI connection is a ChatGPT sign-in, which OpenAI does not allow here. An admin needs to connect an API key.' : 'Your OpenAI connection is a ChatGPT sign-in, which OpenAI does not allow here. Connect an API key instead.';
  }
}
