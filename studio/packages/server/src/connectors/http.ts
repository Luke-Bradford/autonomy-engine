import {
  DEFAULT_HTTP_TIMEOUT_MS,
  formatZodIssues,
  httpConnectionConfigSchema,
  httpRequestInputSchema,
  WEB_ACTIVITY_TYPE,
} from '@autonomy-studio/shared';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import { redactSecrets } from './redact.js';
import {
  buildRequestHeaders,
  collectResponseHeaders,
  exchangeDeadline,
  fetchFailure,
  fetchWithoutLeakingSecrets,
  resolveUrl,
  sinkHeadersFrom,
} from './http-shared.js';
import { runWeb } from './http-web.js';

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
 * run). `DEFAULT_HTTP_TIMEOUT_MS`, overridable per connection via `config.timeoutMs`.
 */

// #1087 — the connection shape lives in `shared/catalog/connection-config.ts`, and
// #1480 moved the request shape (`httpRequestInputSchema`) to the shared catalog,
// where the save gate checks a literal config against this same instance. The
// helpers shared with Web are in `http-shared.ts` (#1600 OR41 C11a).

export const httpAdapter: ConnectorAdapter = {
  kind: 'http',
  configSchema: httpConnectionConfigSchema,

  async testConnection(config, secret) {
    const parsed = httpConnectionConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid http connection config: ${formatZodIssues(parsed.error.issues)}`,
      };
    }
    const baseUrl = parsed.data.baseUrl;
    // Nothing to probe without a baseUrl — a valid config is all we can assert.
    // Nothing to reach, so nothing was reached: `probed: 'config'` (#1191).
    if (baseUrl === undefined || baseUrl === '') return { ok: true, probed: 'config' };
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
      return { ok: true, probed: 'liveness' };
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
      yield {
        type: 'failed',
        kind: 'permanent',
        error: `invalid http connection config: ${formatZodIssues(connConfig.error.issues)}`,
      };
      return;
    }
    // #1600 OR41 C11a — Web shares the connection, not the outcome mapping.
    if (ctx.activityType === WEB_ACTIVITY_TYPE) {
      yield* runWeb(ctx, connConfig.data, secret, secretFields);
      return;
    }
    const req = httpRequestInputSchema.safeParse(ctx.input);
    if (!req.success) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error: `invalid http_request activity config: ${formatZodIssues(req.error.issues)}`,
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
    const sinkHeaders = sinkHeadersFrom(secretFields);
    // The connection secret (if any) is a bearer default, but a resolved
    // config-sink header (item 7 / S4) is the LAST word — it overrides even the
    // Bearer. Neither is surfaced in outputs (a response that echoes one is
    // redacted, #1600 C11a), and their values are redacted from any echoed
    // error below.
    const requestHeaders = buildRequestHeaders(
      connConfig.data.headers,
      headers,
      secret,
      sinkHeaders,
    );
    const outputSecrets = [secret, ...Object.values(sinkHeaders)];

    // Bound the WHOLE exchange (connect + headers + body read). The controller
    // is aborted by the run's own signal (→ cancelled) OR by the timeout (→
    // transient); we track which so the catch can classify correctly.
    const timeoutMs = connConfig.data.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const deadline = exchangeDeadline(ctx.signal, timeoutMs);

    try {
      // A redirect to another origin drops the secret headers (#1600 C11a).
      const res = await fetchWithoutLeakingSecrets(
        resolveUrl(connConfig.data.baseUrl, url),
        { method: httpMethod, headers: requestHeaders, body, signal: deadline.signal },
        Object.keys(sinkHeaders),
      );
      const responseBody = await res.text();
      deadline.disarm(); // exchange complete — disarm before emitting
      yield {
        type: 'succeeded',
        outputs: {
          status: res.status,
          body: redactSecrets(responseBody, outputSecrets),
          headers: collectResponseHeaders(res, outputSecrets),
        },
      };
    } catch (err) {
      // The run's own cancel wins over a coincident timeout.
      if (ctx.signal.aborted) {
        yield { type: 'failed', kind: 'cancelled', error: 'http request aborted' };
      } else if (deadline.timedOut()) {
        yield {
          type: 'failed',
          kind: 'transient',
          error: `http request timed out after ${timeoutMs}ms`,
        };
      } else {
        yield { type: 'failed', ...fetchFailure(err, Object.values(requestHeaders)) };
      }
    } finally {
      deadline.dispose();
    }
  },
};
