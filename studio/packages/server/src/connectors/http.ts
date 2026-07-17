import { z } from 'zod';
import { HTTP_SECRET_HEADERS_FIELD, SecretRefSchema } from '@autonomy-studio/shared';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import { redactSecrets } from './redact.js';

/**
 * The `http` connector adapter: a generic HTTP request activity (the MVP
 * self-contained connector). No paid SDK — Node's global `fetch`.
 *
 * The Connection's non-secret `config` may set a `baseUrl` (prepended to a
 * relative request `url`) and default `headers`. The per-request activity
 * `input` (the node's substituted config) supplies `url`, `method`, `headers`,
 * `body`. A resolved `secret`, when present, is sent as `Authorization: Bearer
 * <secret>` — and is NEVER echoed back in the outputs (only the RESPONSE status,
 * body, and response headers are surfaced).
 *
 * A SECOND secret channel (item 7 / S4, the unified secret model): the node's
 * `secretHeaders` config field is a declared secret SINK (header name →
 * `{$secret:name}` marker). The executor resolves each marker at dispatch and
 * hands the plaintext in via `secretFields`, keyed by CONFIG PATH
 * (`secretHeaders.<headerName>`); this adapter merges those headers LAST — so a
 * config-sink header is the request's final word (it beats a connection default,
 * a request header, and the connection-secret Bearer). Like the connection
 * secret, a resolved value is NEVER surfaced in an output; `ctx.input` retains
 * only the inert marker (a name), so the plaintext lives only in `secretFields`.
 *
 * OUTCOME MAPPING (deliberate): a completed HTTP exchange is a `succeeded` event
 * REGARDLESS of status code — a 4xx/5xx is a real response the pipeline can
 * branch on via `${nodes.x.output.status}` and success/failure edges. Only a
 * failure to COMPLETE the exchange is a `failed` event: `cancelled` when the
 * RUN's signal aborted; `transient` on a network error OR a request TIMEOUT (a
 * retry candidate); `permanent` on a malformed request (bad URL, or a body on a
 * GET/HEAD). This keeps HTTP-level status in the data plane, not the taxonomy.
 *
 * EVERY request is bounded by a timeout spanning the WHOLE exchange (connect +
 * headers + body read), so a hung/slowloris endpoint can never permanently hold
 * a worker-pool slot (which, with the shared pool, would otherwise stall every
 * run). Default 30s, overridable per connection via `config.timeoutMs`.
 */

/** Default per-request timeout (ms) — bounds a hung endpoint. */
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * The `secretFields` key prefix for the `secretHeaders` sink (item 7 / S4),
 * derived from the shared SSOT field name (`HTTP_SECRET_HEADERS_FIELD`) so the
 * catalog declaration and this consumer can't desync. A resolved plaintext
 * arrives keyed `secretHeaders.<headerName>`; the header name is recovered by
 * STRIPPING this prefix (not `split('.')`), so a header name that itself
 * contains `.` (an RFC 7230 tchar) survives intact.
 */
const SECRET_HEADERS_PREFIX = `${HTTP_SECRET_HEADERS_FIELD}.`;

/** The Connection-level (non-secret) config for an `http` connection. */
const httpConnectionConfigSchema = z.object({
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Per-request timeout in ms (whole exchange). Defaults to 30s. */
  timeoutMs: z.number().int().positive().optional(),
});

/** The per-activity request settings, read from the node's prepared `input`. */
const httpRequestInputSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  // The declared secret SINK (item 7 / S4): header name → inert `{$secret:name}`
  // marker. Documentation-only here — the RESOLVED plaintext is read from the
  // `secretFields` side channel, NEVER from this marker. Declared so a malformed
  // value at the sink is caught rather than silently ignored. The key is the
  // shared SSOT constant (computed, not a literal) so a rename can't desync this
  // schema from the sink/prefix wiring.
  [HTTP_SECRET_HEADERS_FIELD]: z.record(z.string(), SecretRefSchema).optional(),
});

/**
 * Map the resolved `secretFields` (keyed by config path) to request headers.
 * Only keys under the `secretHeaders` sink are consumed; the header name is the
 * path with `secretHeaders.` stripped (prefix-strip, never `split`, so a dotted
 * header name is preserved). Other sink paths — there are none for `http` today
 * — are ignored, keeping this adapter's consumption scoped to what it declares.
 */
function sinkHeadersFrom(secretFields: Readonly<Record<string, string>>): Record<string, string> {
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
function resolveUrl(baseUrl: string | undefined, url: string): string {
  if (baseUrl === undefined || baseUrl === '') return url;
  if (/^https?:\/\//i.test(url)) return url; // already absolute
  return baseUrl.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
}

function collectResponseHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

export const httpAdapter: ConnectorAdapter = {
  kind: 'http',
  configSchema: httpConnectionConfigSchema,

  async testConnection(config, secret) {
    const parsed = httpConnectionConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, error: `invalid http connection config: ${parsed.error.message}` };
    }
    const baseUrl = parsed.data.baseUrl;
    // Nothing to probe without a baseUrl — a valid config is all we can assert.
    if (baseUrl === undefined || baseUrl === '') return { ok: true };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      parsed.data.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    );
    try {
      // Probe WITH the credential (mirroring a real request), so an auth-gated
      // endpoint is exercised as it would be at run time — otherwise a bad or
      // missing secret would still report ok. The secret is sent, never returned.
      const probeHeaders: Record<string, string> = {
        ...(parsed.data.headers ?? {}),
        ...(secret !== null ? { Authorization: `Bearer ${secret}` } : {}),
      };
      // A HEAD reaches the host; ANY response proves reachability EXCEPT a 401,
      // which specifically means the credential is bad/missing. We do NOT treat
      // 403/404/405 as a failure — a HEAD to a bare root legitimately yields
      // those even with a valid token, so failing on them would be a false negative.
      const res = await fetch(baseUrl, {
        method: 'HEAD',
        headers: probeHeaders,
        signal: controller.signal,
      });
      if (res.status === 401) {
        return { ok: false, error: 'authentication failed (HTTP 401)' };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: redactSecrets(err instanceof Error ? err.message : String(err), [secret]),
      };
    } finally {
      clearTimeout(timer);
    }
  },

  async *runActivity(
    ctx: ActivityContext,
    secret: string | null,
    secretFields: Readonly<Record<string, string>> = {},
  ): AsyncIterable<ActivityEvent> {
    const connConfig = httpConnectionConfigSchema.safeParse(ctx.connectionConfig);
    if (!connConfig.success) {
      yield { type: 'failed', kind: 'permanent', error: 'invalid http connection config' };
      return;
    }
    const req = httpRequestInputSchema.safeParse(ctx.input);
    if (!req.success) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error: `invalid http_request activity config: ${req.error.message}`,
      };
      return;
    }

    const { url, method, headers, body } = req.data;
    const httpMethod = method ?? 'GET';
    if (body !== undefined && /^(GET|HEAD)$/i.test(httpMethod)) {
      // Node's fetch throws a TypeError for a GET/HEAD body; catch it as the
      // config error it is (permanent) rather than a retryable transient.
      yield {
        type: 'failed',
        kind: 'permanent',
        error: `an HTTP ${httpMethod} cannot carry a body`,
      };
      return;
    }
    const requestHeaders: Record<string, string> = {
      ...(connConfig.data.headers ?? {}),
      ...(headers ?? {}),
      // The connection secret (if any) is a bearer default...
      ...(secret !== null ? { Authorization: `Bearer ${secret}` } : {}),
      // ...but a resolved config-sink header (item 7 / S4) is the LAST word — it
      // overrides even the Bearer. Both are never surfaced in outputs, and their
      // values are redacted from any echoed error below.
      ...sinkHeadersFrom(secretFields),
    };

    // Bound the WHOLE exchange (connect + headers + body read). The controller
    // is aborted by the run's own signal (→ cancelled) OR by the timeout (→
    // transient); we track which so the catch can classify correctly.
    const timeoutMs = connConfig.data.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetch(resolveUrl(connConfig.data.baseUrl, url), {
        method: httpMethod,
        headers: requestHeaders,
        body,
        signal: controller.signal,
      });
      const responseBody = await res.text();
      clearTimeout(timer); // exchange complete — disarm before emitting
      yield {
        type: 'succeeded',
        outputs: {
          status: res.status,
          body: responseBody,
          headers: collectResponseHeaders(res),
        },
      };
    } catch (err) {
      // The run's own cancel wins over a coincident timeout.
      if (ctx.signal.aborted) {
        yield { type: 'failed', kind: 'cancelled', error: 'http request aborted' };
      } else if (timedOut) {
        yield {
          type: 'failed',
          kind: 'transient',
          error: `http request timed out after ${timeoutMs}ms`,
        };
      } else if (err instanceof TypeError) {
        // A malformed request (bad URL, forbidden header, etc.) — never succeeds
        // as-is. Redact outgoing header values: a header-validation TypeError
        // quotes the bad value verbatim, which could be the secret bearer token.
        yield {
          type: 'failed',
          kind: 'permanent',
          error: redactSecrets(err.message, Object.values(requestHeaders)),
        };
      } else {
        yield {
          type: 'failed',
          kind: 'transient',
          error: redactSecrets(
            err instanceof Error ? err.message : String(err),
            Object.values(requestHeaders),
          ),
        };
      }
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onExternalAbort);
    }
  },
};
