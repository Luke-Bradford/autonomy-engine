import { HTTP_SECRET_HEADERS_FIELD } from '@autonomy-studio/shared';

/**
 * The pieces of an HTTP exchange that `http_request` (`http.ts`) and Web
 * (`http-web.ts`, #1600 OR41 C11a) share: the secret-header sink, the base-URL
 * join, the redirect walk and the network-error test.
 */

/**
 * The `secretFields` key prefix for the `secretHeaders` sink (item 7 / S4),
 * derived from the shared SSOT field name (`HTTP_SECRET_HEADERS_FIELD`) so the
 * catalog declaration and this consumer can't desync. A resolved plaintext
 * arrives keyed `secretHeaders.<headerName>`; the header name is recovered by
 * STRIPPING this prefix (not `split('.')`), so a header name that itself
 * contains `.` (an RFC 7230 tchar) survives intact.
 */
const SECRET_HEADERS_PREFIX = `${HTTP_SECRET_HEADERS_FIELD}.`;

/**
 * Map the resolved `secretFields` (keyed by config path) to request headers.
 * Only keys under the `secretHeaders` sink are consumed; the header name is the
 * path with `secretHeaders.` stripped (prefix-strip, never `split`, so a dotted
 * header name is preserved). Other sink paths — there are none for `http` today
 * — are ignored, keeping this adapter's consumption scoped to what it declares.
 */
export function sinkHeadersFrom(
  secretFields: Readonly<Record<string, string>>,
): Record<string, string> {
  // Build via `Object.fromEntries` (define-property, [[DefineOwnProperty]]) rather
  // than bracket-assignment ([[Set]]): a header named `__proto__` would hit
  // Object.prototype's `__proto__` setter under [[Set]] and be SILENTLY DROPPED —
  // the exact silent-loss failure this sink exists to fail-loudly avoid. Under
  // define-property it becomes a real own property that survives the spread below.
  return Object.fromEntries(
    Object.entries(secretFields)
      .filter(([path]) => path.startsWith(SECRET_HEADERS_PREFIX))
      .map(([path, value]) => [path.slice(SECRET_HEADERS_PREFIX.length), value]),
  );
}

/** Resolve a possibly-relative request url against an optional connection baseUrl. */
export function resolveUrl(baseUrl: string | undefined, url: string): string {
  if (baseUrl === undefined || baseUrl === '') return url;
  if (/^https?:\/\//i.test(url)) return url; // already absolute
  return baseUrl.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
}

export function collectResponseHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** The fetch standard's redirect limit. */
const MAX_REDIRECTS = 20;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers that describe a request body, dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];

/** What Node's own redirect walk already strips on a change of origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * `fetch`, following redirects itself so a secret header never reaches another
 * origin.
 *
 * Node's built-in walk drops `Authorization`, `Cookie` and
 * `Proxy-Authorization` on a cross-origin redirect, but forwards every other
 * header — so a `secretHeaders` entry such as `X-Api-Key` was sent to whatever
 * host a 302 named (measured on Node 25: the other origin received it). This walk
 * follows the same rules as the fetch standard (20 hops; 303, and a 301/302 after
 * a POST, become a GET without a body) and also drops `secretHeaderNames` once
 * the origin has changed. Dropped headers stay dropped for the rest of the walk.
 *
 * Throws what `fetch` throws, plus a `TypeError` past 20 redirects or on a
 * redirect to a non-HTTP URL, so the caller classifies both as it does a bad URL.
 */
export async function fetchWithoutLeakingSecrets(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
  secretHeaderNames: readonly string[],
): Promise<Response> {
  // The first hop sends exactly what the caller built (the url string, a plain
  // headers object), so a request that is never redirected is unchanged.
  let target: string = url;
  let method = init.method;
  let body = init.body;
  let headers = init.headers;
  const without = (names: readonly string[]) => {
    const drop = new Set(names.map((n) => n.toLowerCase()));
    headers = Object.fromEntries(
      Object.entries(headers).filter(([name]) => !drop.has(name.toLowerCase())),
    );
  };
  for (let hop = 0; ; hop += 1) {
    const res = await fetch(target, {
      method,
      headers,
      body,
      signal: init.signal,
      redirect: 'manual',
    });
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || location === null) return res;
    await res.body?.cancel();
    if (hop === MAX_REDIRECTS) throw new TypeError(`more than ${MAX_REDIRECTS} redirects`);
    const current = new URL(target);
    const next = new URL(location, current);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new TypeError(`a redirect to a non-HTTP URL (${next.protocol})`);
    }
    if (
      (res.status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((res.status === 301 || res.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      without(BODY_HEADERS);
    }
    if (next.origin !== current.origin) without([...CREDENTIAL_HEADERS, ...secretHeaderNames]);
    target = next.href;
  }
}

/**
 * The `cause.code`s with which Node's `fetch` reports a failure to reach or keep
 * talking to the server — a retry candidate. Listed, not matched as `UND_ERR_*`:
 * `UND_ERR_INVALID_ARG` or `UND_ERR_HEADERS_OVERFLOW` is a request that will
 * never succeed as it is.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Whether `err` is a network failure. Node's `fetch` throws a `TypeError('fetch
 * failed')` for one, the same class as a malformed request, so the `cause` is
 * what tells them apart (measured on Node 25: a refused port is `ECONNREFUSED`,
 * an unknown host `ENOTFOUND`, a dropped socket `UND_ERR_SOCKET`).
 */
export function isNetworkError(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/**
 * Read a response body, keeping at most `maxBytes`. `overLimit` is true when
 * the body was longer; the stream is then cancelled, so the socket closes and a
 * large (or decompressing) body stops downloading.
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ data: Uint8Array; overLimit: boolean }> {
  if (body === null) return { data: new Uint8Array(0), overLimit: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let overLimit = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - kept;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      kept += room;
      overLimit = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    kept += value.byteLength;
  }
  const data = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data, overLimit };
}
