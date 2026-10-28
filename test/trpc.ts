// Calls a tRPC procedure over real HTTP, like the REST `req()` helpers do: `trpcCall(fetchLike, cookie, 'mail.list')`, `trpcCall(f, cookie, 'roles.delete', { id }, true)`.
// `fetchLike` is `(path, init) => Response` (app.request of an in-process Hono app, or `(p, i) => fetch(base + p, i)`). Resolves {status, json: the result, error: the message}.
type Fetch = (path: string, init: RequestInit) => Response | Promise<Response>;
export async function trpcCall(f: Fetch, cookie: string, proc: string, input?: unknown, mutate = false, origin?: string) {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) };
  const res = mutate ? await f(`/api/trpc/${proc}`, { method: 'POST', headers, body: JSON.stringify(input ?? {}) })
    : await f(`/api/trpc/${proc}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, { method: 'GET', headers });
  const body = await res.json() as { result?: { data: any }; error?: { message: string; data?: { code: string; scope?: string; details?: any } } };
  return { status: res.status, json: body.result?.data, error: body.error?.message, code: body.error?.data?.code, scope: body.error?.data?.scope, details: body.error?.data?.details };
}
