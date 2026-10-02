// The one place that decides which URLs the Worker may fetch on a visitor's
// behalf (both /api/proxy and the capabilities probe in /api/resolve), so the
// two can't drift apart. Workers can't reach private networks anyway, but a
// service that redirects, or a hostname spelled in a way a naive string check
// misses, shouldn't be a way to find out.

export class UnsafeUrlError extends Error {}

/** True for hostnames that must never be fetched: local names, private/reserved IPv4, any IPv6 literal. */
export function blockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain')) {
    return true;
  }
  // No public WMS/WCS is addressed by a raw IPv6 literal, and the loopback,
  // ULA, link-local and IPv4-mapped forms are too many to enumerate safely.
  if (host.startsWith('[')) return true;
  // The URL parser has already normalized decimal/hex/octal spellings of an
  // IPv4 address into dotted-quad form by the time we get here.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c] = ipv4.slice(1).map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return false;
}

/** Throw UnsafeUrlError unless `url` is an http(s) URL on a public-looking host. */
export function assertPublicHttpUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UnsafeUrlError('Only http(s) URLs can be fetched.');
  }
  if (blockedHost(url.hostname)) {
    throw new UnsafeUrlError('Local/private service URLs are not allowed.');
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() that follows redirects itself, re-checking every hop: the default
 * automatic redirect handling would let a public URL bounce the request onto
 * a host that was blocked up front.
 */
export async function safeFetch(url, init = {}, fetchImpl = fetch, maxRedirects = 3) {
  let current = new URL(url);
  for (let hop = 0; ; hop += 1) {
    assertPublicHttpUrl(current);
    const response = await fetchImpl(current.toString(), { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (hop >= maxRedirects) throw new UnsafeUrlError('The source server redirected too many times.');
    await response.body?.cancel?.();
    current = new URL(location, current);
  }
}
