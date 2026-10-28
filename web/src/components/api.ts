import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';

export interface Me { id: string; email: string; name: string; image?: string | null; role: string; roleId: string; permissions: string[]; twoFactorEnabled?: boolean; twoFactorSetupRequired?: boolean; passwordChangeRequired?: boolean; providerConnected: boolean; modelReady: boolean }

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 423) dispatchEvent(new CustomEvent('hefyn-locked', { detail: { scope: data.scope } })); // Unlock.tsx asks for the password / explains the team lock
  if (!res.ok) throw Object.assign(new Error(res.status === 423 ? 'Locked' : data.error ?? res.statusText), { status: res.status });
  return data;
}

// Loads the session; sends visitors to /setup or /login as needed.
export function useMe() {
  const [me, setMe] = useState<Me>();
  // Refetch on tab focus and after 'hefyn-me' (e.g. a provider was connected) so banners stay current.
  useEffect(() => {
    const f = () => api<Me>('/api/me').then(setMe).catch(() => {});
    addEventListener('focus', f); addEventListener('hefyn-me', f);
    return () => { removeEventListener('focus', f); removeEventListener('hefyn-me', f); };
  }, []);
  // Only a real 401 means "not signed in"; a 5xx or a network error (server restarting) shows "Reconnecting…" and retries with backoff.
  useEffect(() => {
    let stop = false, timer: ReturnType<typeof setTimeout>;
    const load = (wait: number) => api<Me>('/api/me').then((m) => { if (!stop) { setMe(m); dispatchEvent(new CustomEvent('hefyn-reconnecting', { detail: false })); } }).catch(async (e) => {
      if (stop) return;
      if (e?.status !== 401) { dispatchEvent(new CustomEvent('hefyn-reconnecting', { detail: true })); timer = setTimeout(() => load(Math.min(wait * 2, 10000)), wait); return; }
      const s = await trpc.setup.status.query().catch(() => ({ needsSetup: false }));
      location.href = s.needsSetup ? '/setup' : '/login';
    });
    load(1000);
    return () => { stop = true; clearTimeout(timer); };
  }, []);
  return me;
}
/** True while the first /api/me keeps failing for a reason other than being signed out. */
export function useReconnecting() {
  const [r, setR] = useState(false);
  useEffect(() => { const f = (e: Event) => setR((e as CustomEvent<boolean>).detail); addEventListener('hefyn-reconnecting', f); return () => removeEventListener('hefyn-reconnecting', f); }, []);
  return r;
}

export interface NavItem { place: 'main' | 'settings'; label: string; href: string; icon?: string; permission?: string | string[]; order?: number; group?: 'you' | 'workspace' }
export interface ModuleCommand { label: string; href: string; icon?: string; permission?: string | string[]; order?: number }
export interface ModulePermission { id: string; label: string; hint?: string; group?: string }
export interface Modules { modules: { id: string; name: string; icon?: string }[]; nav: NavItem[]; commands: ModuleCommand[]; permissions: ModulePermission[] }
const NO_MODULES: Modules = { modules: [], nav: [], commands: [], permissions: [] };
// Last response is cached so the sidebar renders at once; the fresh one replaces it.
export function useModules() {
  const [mods, setMods] = useState<Modules>(() => { try { return { ...NO_MODULES, ...JSON.parse(localStorage.getItem('hefyn-modules') ?? '{}') }; } catch { return NO_MODULES; } });
  useEffect(() => {
    const f = () => trpc.modules.list.query().then((m) => { setMods(m); localStorage.setItem('hefyn-modules', JSON.stringify(m)); }).catch(() => {});
    f(); addEventListener('hefyn-modules', f);
    return () => removeEventListener('hefyn-modules', f);
  }, []);
  return mods;
}
/** Call after installing, enabling or removing a module so the sidebar and palette update without a reload. */
export const refreshModules = () => dispatchEvent(new Event('hefyn-modules'));
export const can =(me: Me, p: string) => me.permissions.includes(p);
/** A one-shot `#hash` link (e.g. #connect opens a dialog): true on the first render, then removed so a reload does not open it again. */
export function useHashFlag(h: string) {
  const [on] = useState(() => location.hash === h);
  useEffect(() => { if (location.hash === h) history.replaceState(null, '', location.pathname + location.search); }, [h]);
  return on;
}
export const money = (n: number) => `$${(n ?? 0).toFixed(n && n < 0.1 ? 4 : 2)}`;
export const useLoad = <T,>(path: string, deps: unknown[] = []) => {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const reload = () => api<T>(path).then(setData).catch((e) => setError(e.message));
  useEffect(() => void reload(), deps);
  return { data, error, reload };
};
/** useLoad for tRPC: `useQuery(() => trpc.mail.list.query(), [deps])` gives {data, error, reload}. */
export const useQuery = <T,>(fn: () => Promise<T>, deps: unknown[] = []) => {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const reload = () => fn().then(setData).catch((e) => setError(e.message));
  useEffect(() => void reload(), deps);
  return { data, error, reload };
};

export interface Runtime { state: 'running' | 'draining' | 'restarting'; runningTasks: number; agentUp: boolean; requestedAt: string | null; requestedBy: string | null }
// Polls runtime.info: every 3 s while not running, 15 s otherwise, and on focus or after 'hefyn-rt'. Errors keep the last value.
export function useRuntime() {
  const [rt, setRt] = useState<Runtime>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stop = false;
    const tick = async () => {
      const r = await (trpc.runtime.info.query() as Promise<Runtime>).catch(() => undefined);
      if (stop) return;
      if (r) setRt(r);
      clearTimeout(timer);
      timer = setTimeout(tick, r && r.state !== 'running' ? 3000 : 15000);
    };
    tick();
    addEventListener('focus', tick); addEventListener('hefyn-rt', tick);
    return () => { stop = true; clearTimeout(timer); removeEventListener('focus', tick); removeEventListener('hefyn-rt', tick); };
  }, []);
  return rt;
}

export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

// Multipart upload with progress (fetch cannot report upload progress). Rejects with Error(message) and .status.
export function upload<T = any>(url: string, files: File[], onProgress?: (frac: number) => void): Promise<T> {
  return new Promise((ok, fail) => {
    const form = new FormData();
    files.forEach((f) => form.append('file', f, f.name));
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onerror = () => fail(new Error('Upload failed. Check your connection.'));
    x.onload = () => {
      let data: any = {};
      try { data = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status === 423) dispatchEvent(new CustomEvent('hefyn-locked', { detail: { scope: data.scope } }));
      if (x.status >= 200 && x.status < 300) return ok(data);
      fail(Object.assign(new Error(x.status === 413 ? `Not enough storage left or file too large. ${data.error ?? ''}`.trim() : data.error ?? x.statusText), { status: x.status }));
    };
    x.send(form);
  });
}
