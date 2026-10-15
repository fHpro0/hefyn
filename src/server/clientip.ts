import { isIPv4, isIPv6 } from 'node:net';

// Client IP for rate limiting and audit. The socket peer is the truth. X-Forwarded-For / X-Real-IP are only believed when
// HEFYN_TRUSTED_PROXIES (comma-separated IPs or IPv4 CIDRs) is set AND the socket peer is one of them; otherwise client-supplied
// forwarding headers are ignored (and stripped before Better Auth sees the request), so nobody can pick their own rate-limit bucket.

const norm = (ip: string) => ip.trim().replace(/^::ffff:/i, '').toLowerCase();
const v4 = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);

export function trustedList(spec = process.env.HEFYN_TRUSTED_PROXIES ?? ''): (ip: string) => boolean {
  const rules = spec.split(',').map((s) => s.trim()).filter(Boolean).map((r) => {
    const [addr, bits] = r.split('/');
    const a = norm(addr);
    if (isIPv4(a) && bits !== undefined) { const b = Number(bits); return (ip: string) => isIPv4(ip) && b >= 0 && b <= 32 && (b === 0 || v4(ip) >>> (32 - b) === v4(a) >>> (32 - b)); }
    if (isIPv4(a) || isIPv6(a)) return (ip: string) => ip === a;
    throw new Error(`HEFYN_TRUSTED_PROXIES: invalid entry "${r}"`);
  });
  return (ip) => rules.some((f) => f(norm(ip)));
}

export function clientIp(peer: string | undefined, headers: { xff?: string | null; realIp?: string | null }, isTrusted = trustedList()): string {
  const p = norm(peer ?? '') || 'unknown';
  if (!isTrusted(p)) return p;
  // Walk X-Forwarded-For from the right: the first hop that is not one of our proxies is the client.
  const hops = (headers.xff ?? '').split(',').map(norm).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!isTrusted(hops[i])) return hops[i];
  return norm(headers.realIp ?? '') || hops[0] || p;
}

/** Headers for auth.api calls and the request handed to Better Auth: forwarding headers removed, the resolved IP set. */
export const CLIENT_IP_HEADER = 'x-hefyn-client-ip';
export function cleanedHeaders(h: Headers, peer: string | undefined): Headers {
  const ip = clientIp(peer, { xff: h.get('x-forwarded-for'), realIp: h.get('x-real-ip') });
  const out = new Headers(h);
  for (const k of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', CLIENT_IP_HEADER]) out.delete(k);
  out.set(CLIENT_IP_HEADER, ip);
  return out;
}
export const peerOf = (c: { env?: any }): string | undefined => c.env?.incoming?.socket?.remoteAddress;
