import { z } from 'zod';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';

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
});

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

  async testConnection(config) {
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
      // A HEAD reaches the host; ANY response (even 4xx) proves reachability.
      await fetch(baseUrl, { method: 'HEAD', signal: controller.signal });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  },

  async *runActivity(ctx: ActivityContext, secret: string | null): AsyncIterable<ActivityEvent> {
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
      // The secret (if any) is the LAST word and is never surfaced in outputs.
      ...(secret !== null ? { Authorization: `Bearer ${secret}` } : {}),
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
        // A malformed request (bad URL, forbidden header, etc.) — never succeeds as-is.
        yield { type: 'failed', kind: 'permanent', error: err.message };
      } else {
        yield {
          type: 'failed',
          kind: 'transient',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onExternalAbort);
    }
  },
};
