import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { db } from './appdb.ts';
import { als, stampAls } from './context.ts';
import { audit } from './privacy.ts';

// Outbound HTTP guard, agent process. Every fetch ends in undici's global dispatcher; wrapping it catches calls no matter
// which fetch reference an SDK captured. A request to an AI host (all known pi-ai provider endpoints plus every connected
// company/user provider endpoint, custom ones included) is only let through inside a stamp that the privacy gate sets after
// redaction succeeded. Anything else is a bypass attempt: refused and audited. Token endpoints of OAuth logins are not model
// calls and run under the 'auth' stamp. (Clients that bypass fetch, e.g. node:https, are covered by the network layer: egress proxy.)

export const hostKey = (u: string) => {
  try { const x = new URL(u); return `${x.hostname.toLowerCase()}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`; } catch { return undefined; }
};

let builtin: Set<string> | undefined;
const builtinHosts = () => builtin ??= new Set(builtinProviders().flatMap((p) => p.getAllModels?.() ?? p.getModels()).flatMap((m: any) => [hostKey(m.baseUrl)].filter(Boolean) as string[]).concat(builtinProviders().map((p: any) => hostKey(p.baseUrl ?? '')).filter(Boolean) as string[]));
let dbAt = 0, dbHosts = new Set<string>();
/** Host:port keys of everything that is a model endpoint right now. */
export function aiHosts(): Set<string> {
  if (Date.now() - dbAt > 3000) {
    dbAt = Date.now();
    dbHosts = new Set([...db.prepare('SELECT base_url FROM providers WHERE base_url IS NOT NULL').all(), ...db.prepare('SELECT base_url FROM user_credentials WHERE base_url IS NOT NULL').all()]
      .map((r: any) => hostKey(r.base_url)).filter(Boolean) as string[]);
  }
  return new Set([...builtinHosts(), ...dbHosts]);
}
export const invalidateAiHosts = () => { dbAt = 0; };

export const BYPASS = 'bypass attempt: a model API request that did not pass the privacy gate was blocked';

let guarded = false;
export async function installFetchGuard() {
  if (guarded) return;
  guarded = true;
  await fetch('data:,').catch(() => {}); // loads undici so the global dispatcher exists (with NODE_USE_ENV_PROXY it is the proxy agent)
  const g = globalThis as any;
  let wrapped = 0;
  // Node bundles different undici majors: fetch reads `.2` (newer) or `.1`; wrap every slot that exists.
  for (const name of ['undici.globalDispatcher.2', 'undici.globalDispatcher.1']) {
    const SYM = Symbol.for(name);
    const inner = g[SYM];
    if (!inner) continue;
    wrapped++;
    g[SYM] = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'dispatch') {
          return (opts: any, handler: any) => {
            const k = opts?.origin ? hostKey(String(opts.origin)) : undefined;
            if (k && !stampAls.getStore() && aiHosts().has(k)) {
              try { audit(als.getStore() ?? 'unknown', { provider: k, id: String(opts.path ?? '').slice(0, 80) }, 'blocked', [], null, BYPASS); } catch { /* audit is best effort here */ }
              throw new Error(BYPASS);
            }
            return target.dispatch(opts, handler);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }
  if (!wrapped) throw new Error('cannot install the outbound fetch guard: no global dispatcher');
}
