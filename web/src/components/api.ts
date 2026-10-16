import { useEffect, useState } from 'react';

export interface Me { id: string; email: string; name: string; role: string; roleId: string; permissions: string[]; providerConnected: boolean; modelReady: boolean }

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
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
  useEffect(() => {
    api<Me>('/api/me').then(setMe).catch(async () => {
      const s = await api('/api/setup/status').catch(() => ({ needsSetup: false }));
      location.href = s.needsSetup ? '/setup' : '/login';
    });
  }, []);
  return me;
}

export const can = (me: Me, p: string) => me.permissions.includes(p);
export const money = (n: number) => `$${(n ?? 0).toFixed(n && n < 0.1 ? 4 : 2)}`;
export const useLoad = <T,>(path: string, deps: unknown[] = []) => {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const reload = () => api<T>(path).then(setData).catch((e) => setError(e.message));
  useEffect(() => void reload(), deps);
  return { data, error, reload };
};

export interface Runtime { state: 'running' | 'draining' | 'restarting'; runningTasks: number; agentUp: boolean; requestedAt: string | null; requestedBy: string | null; privacy?: { gliner: boolean; glinerSource?: 'huggingface' | 'mirror' | 'image' | 'local'; glinerState?: 'ready' | 'missing' | 'downloading' | 'invalid' | 'error'; glinerDetail?: string; glinerHost?: string; imagesAllowed: boolean } }
// Polls /api/runtime: every 3 s while not running, 15 s otherwise, and on focus or after 'hefyn-rt'. Errors keep the last value.
export function useRuntime() {
  const [rt, setRt] = useState<Runtime>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stop = false;
    const tick = async () => {
      const r = await api<Runtime>('/api/runtime').catch(() => undefined);
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
      if (x.status >= 200 && x.status < 300) return ok(data);
      fail(Object.assign(new Error(x.status === 413 ? `Not enough storage left or file too large. ${data.error ?? ''}`.trim() : data.error ?? x.statusText), { status: x.status }));
    };
    x.send(form);
  });
}
