import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanedHeaders, clientIp, trustedList } from '../src/server/clientip.ts';

test('client IP: the socket peer unless the peer is a configured trusted proxy', () => {
  const none = trustedList('');
  assert.equal(clientIp('203.0.113.9', { xff: '1.2.3.4', realIp: '5.6.7.8' }, none), '203.0.113.9'); // spoofing is ignored
  assert.equal(clientIp('::ffff:203.0.113.9', {}, none), '203.0.113.9');
  assert.equal(clientIp(undefined, {}, none), 'unknown');

  const trusted = trustedList('10.0.0.0/8, 192.168.1.5, ::1');
  assert.equal(clientIp('10.1.2.3', { xff: '198.51.100.7' }, trusted), '198.51.100.7'); // behind our proxy: believe it
  assert.equal(clientIp('10.1.2.3', { xff: 'spoofed-by-client, 198.51.100.7, 10.9.9.9' }, trusted), '198.51.100.7'); // right to left, skip our own hops
  assert.equal(clientIp('10.1.2.3', { xff: '', realIp: '198.51.100.8' }, trusted), '198.51.100.8');
  assert.equal(clientIp('192.168.1.5', { xff: '198.51.100.7' }, trusted), '198.51.100.7');
  assert.equal(clientIp('192.168.1.6', { xff: '198.51.100.7' }, trusted), '192.168.1.6'); // not in the list: a client talking directly
  assert.equal(clientIp('172.16.0.1', { xff: '198.51.100.7' }, trusted), '172.16.0.1');
  assert.throws(() => trustedList('not-an-ip'), /invalid entry/);
});

test('client-supplied forwarding headers are stripped before Better Auth sees the request', () => {
  const h = new Headers({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8', forwarded: 'for=9.9.9.9', 'x-hefyn-client-ip': 'forged', cookie: 'a=b' });
  const out = cleanedHeaders(h, '203.0.113.9');
  assert.equal(out.get('x-hefyn-client-ip'), '203.0.113.9');
  assert.equal(out.get('x-forwarded-for'), null);
  assert.equal(out.get('x-real-ip'), null);
  assert.equal(out.get('forwarded'), null);
  assert.equal(out.get('cookie'), 'a=b');
});
