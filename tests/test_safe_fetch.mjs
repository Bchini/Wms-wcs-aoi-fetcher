import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedHost, safeFetch, UnsafeUrlError } from '../src/safe-fetch.mjs';

test('blockedHost: local names and private IPv4 ranges', () => {
  for (const host of [
    'localhost', 'LOCALHOST.', 'foo.localhost', 'printer.local', 'db.internal', 'x.localdomain',
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '198.18.0.1',
  ]) {
    assert.equal(blockedHost(host), true, host);
  }
});

test('blockedHost: public hosts and the edges of the private ranges are allowed', () => {
  for (const host of ['example.com', 'geoservizi.regione.liguria.it', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1']) {
    assert.equal(blockedHost(host), false, host);
  }
});

test('blockedHost: every IPv6 literal is refused', () => {
  for (const host of ['[::1]', '[fe80::1]', '[::ffff:7f00:1]', '[2001:db8::1]']) {
    assert.equal(blockedHost(host), true, host);
  }
});

test('blockedHost: a decimal/hex IPv4 spelling is caught once the URL parser normalizes it', () => {
  assert.equal(blockedHost(new URL('http://2130706433/').hostname), true);
  assert.equal(blockedHost(new URL('http://0x7f.1/').hostname), true);
});

function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return new Response(null, route);
  };
  return { impl, calls };
}

test('safeFetch never lets fetch follow redirects on its own', async () => {
  const { impl, calls } = stubFetch({ 'https://a.test/x': { status: 200 } });
  await safeFetch('https://a.test/x', {}, impl);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('safeFetch follows a redirect between public hosts', async () => {
  const { impl, calls } = stubFetch({
    'https://a.test/x': { status: 302, headers: { location: 'https://b.test/y' } },
    'https://b.test/y': { status: 200 },
  });
  const response = await safeFetch('https://a.test/x', {}, impl);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.url), ['https://a.test/x', 'https://b.test/y']);
});

test('safeFetch resolves a relative Location against the current URL', async () => {
  const { impl, calls } = stubFetch({
    'https://a.test/dir/x': { status: 301, headers: { location: '../moved' } },
    'https://a.test/moved': { status: 200 },
  });
  await safeFetch('https://a.test/dir/x', {}, impl);
  assert.equal(calls[1].url, 'https://a.test/moved');
});

test('safeFetch refuses a redirect onto a private host without ever fetching it', async () => {
  const { impl, calls } = stubFetch({
    'https://a.test/x': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } },
  });
  await assert.rejects(() => safeFetch('https://a.test/x', {}, impl), UnsafeUrlError);
  assert.equal(calls.length, 1);
});

test('safeFetch refuses a private starting URL', async () => {
  const { impl, calls } = stubFetch({});
  await assert.rejects(() => safeFetch('http://127.0.0.1/', {}, impl), UnsafeUrlError);
  assert.equal(calls.length, 0);
});

test('safeFetch refuses non-http(s) schemes, including via redirect', async () => {
  const { impl } = stubFetch({ 'https://a.test/x': { status: 302, headers: { location: 'file:///etc/passwd' } } });
  await assert.rejects(() => safeFetch('https://a.test/x', {}, impl), UnsafeUrlError);
});

test('safeFetch gives up after too many redirects', async () => {
  const loop = { status: 302, headers: { location: 'https://a.test/x' } };
  const { impl } = stubFetch({ 'https://a.test/x': loop });
  await assert.rejects(() => safeFetch('https://a.test/x', {}, impl, 3), /redirected too many times/);
});
