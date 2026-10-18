import {
  DEFAULT_HTTP_TIMEOUT_MS,
  formatZodIssues,
  hasBody,
  WARNING_CODES,
  WEB_MAX_JSON_DEPTH,
  webConfigSchema,
  type httpConnectionConfigSchema,
} from '@autonomy-studio/shared';
import type { z } from 'zod';
import type { ActivityContext, ActivityEvent } from './types.js';
import { redactSecrets } from './redact.js';
import {
  collectResponseHeaders,
  fetchWithoutLeakingSecrets,
  isNetworkError,
  readBodyBounded,
  resolveUrl,
  sinkHeadersFrom,
} from './http-shared.js';
import { classifyHttpStatus, errorExcerpt, parseRetryAfter } from './llm-shared.js';

type HttpConnectionConfig = z.infer<typeof httpConnectionConfigSchema>;

/**
 * #1600 OR41 C11a — the `http` adapter's arm for Web (catalogue §4.6), ADF's Web
 * activity. The request is `http_request`'s (the same headers, Bearer, secret
 * headers and base URL, in the same order); what differs is the outcome:
 *
 * - **Fail on HTTP error** (on by default): a status of 400 or above, unless
 *   listed in *Treat as success*, FAILS the node with the status and a redacted
 *   excerpt of the body. `classifyHttpStatus` decides the kind: 401/403 `auth`,
 *   429 `rate_limit`, 5xx `transient`, any other `permanent`. A retryable one
 *   carries the server's `Retry-After` to the retry alarm. *Retry on 429 and 503*
 *   off makes a 429 `permanent` and ignores `Retry-After`; a 5xx stays a retry
 *   candidate, as every 5xx is.
 * - **The body is bounded.** At most *Max size* bytes are read; a longer body
 *   fails (`permanent`), or with *Truncate* keeps the prefix, sets `truncated`
 *   and warns. A `Content-Length` over the limit fails before the body is read,
 *   except under a `Content-Encoding`, where it is the compressed size.
 * - **Parse as** JSON (an empty body is null; a body that is not JSON, or nests
 *   deeper than `WEB_MAX_JSON_DEPTH`, fails `permanent`) or Text.
 * - **A network failure is `transient`.** `http_request` reports Node's
 *   `TypeError('fetch failed')` as a malformed request (`permanent`); Web reads
 *   the cause (`isNetworkError`).
 */
export async function* runWeb(
  ctx: ActivityContext,
  connection: HttpConnectionConfig,
  secret: string | null,
  secretFields: Readonly<Record<string, string>>,
): AsyncIterable<ActivityEvent> {
  const parsed = webConfigSchema.safeParse(ctx.input);
  if (!parsed.success) {
    yield {
      type: 'failed',
      kind: 'permanent',
      error: `invalid web activity config: ${formatZodIssues(parsed.error.issues)}`,
    };
    return;
  }
  const cfg = parsed.data;
  const sinkHeaders = sinkHeadersFrom(secretFields);
  const requestHeaders: Record<string, string> = {
    ...(connection.headers ?? {}),
    ...(cfg.headers ?? {}),
    ...(secret !== null ? { Authorization: `Bearer ${secret}` } : {}),
    ...sinkHeaders,
  };
  const secrets = Object.values(requestHeaders);

  const timeoutMs =
    cfg.httpRequestTimeoutSeconds !== undefined
      ? cfg.httpRequestTimeoutSeconds * 1000
      : (connection.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (ctx.signal.aborted) controller.abort();
  else ctx.signal.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = Date.now();
  try {
    const res = await fetchWithoutLeakingSecrets(
      resolveUrl(connection.baseUrl, cfg.url),
      {
        method: cfg.method,
        headers: requestHeaders,
        ...(hasBody(cfg) ? { body: cfg.body } : {}),
        signal: controller.signal,
      },
      Object.keys(sinkHeaders),
    );

    const failsOnStatus =
      cfg.failOnHttpError &&
      res.status >= 400 &&
      !(cfg.successStatusCodes ?? []).includes(res.status);
    if (failsOnStatus) {
      // Enough of the body for the excerpt, never more than Max size.
      const { data } = await readBodyBounded(res.body, Math.min(cfg.maxResponseBytes, 4096));
      yield statusFailure(res, new TextDecoder().decode(data), cfg.retryOnThrottle, secrets);
      return;
    }

    const declared = Number(res.headers.get('content-length'));
    if (
      cfg.whenOverLimit === 'fail' &&
      res.headers.get('content-encoding') === null &&
      Number.isFinite(declared) &&
      declared > cfg.maxResponseBytes
    ) {
      await res.body?.cancel();
      yield overLimitFailure(cfg.maxResponseBytes);
      return;
    }
    const { data, overLimit } = await readBodyBounded(res.body, cfg.maxResponseBytes);
    clearTimeout(timer); // exchange complete — disarm before emitting
    const durationMs = Date.now() - startedAt;
    if (overLimit && cfg.whenOverLimit === 'fail') {
      yield overLimitFailure(cfg.maxResponseBytes);
      return;
    }
    // `stream: true` on a truncated body holds back a UTF-8 sequence the cut
    // split, rather than decoding it to U+FFFD.
    const text = new TextDecoder().decode(data, { stream: overLimit });
    let body: unknown = text;
    if (cfg.parseAs === 'json') {
      const json = parseJsonBody(text);
      if (!json.ok) {
        yield { type: 'failed', kind: 'permanent', error: json.error };
        return;
      }
      body = json.value;
    }
    if (overLimit) {
      yield {
        type: 'warned',
        code: WARNING_CODES.WEB_RESPONSE_TRUNCATED,
        reason: `the response was longer than Max size (${cfg.maxResponseBytes} bytes); the first ${data.byteLength} bytes were kept`,
      };
    }
    yield {
      type: 'succeeded',
      outputs: {
        status: res.status,
        headers: collectResponseHeaders(res),
        body,
        bytes: data.byteLength,
        durationMs,
        truncated: overLimit,
        callback: null,
      },
    };
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    if (ctx.signal.aborted) {
      yield { type: 'failed', kind: 'cancelled', error: 'web request aborted' };
    } else if (timedOut) {
      yield {
        type: 'failed',
        kind: 'transient',
        error: `web request timed out after ${timeoutMs}ms`,
      };
    } else if (err instanceof TypeError && !isNetworkError(err)) {
      // A malformed request (bad URL, forbidden header, a redirect loop) never
      // succeeds as-is. A header-validation TypeError quotes the bad value
      // verbatim, which could be a secret, hence the redaction.
      yield { type: 'failed', kind: 'permanent', error: message };
    } else {
      const cause = (err as { cause?: { code?: unknown } }).cause?.code;
      yield {
        type: 'failed',
        kind: 'transient',
        error: typeof cause === 'string' ? `${message} (${cause})` : message,
      };
    }
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onExternalAbort);
  }
}

function statusFailure(
  res: Response,
  bodyText: string,
  retryOnThrottle: boolean,
  secrets: readonly string[],
): Extract<ActivityEvent, { type: 'failed' }> {
  const classified = classifyHttpStatus(res.status);
  const kind = classified === 'rate_limit' && !retryOnThrottle ? 'permanent' : classified;
  const excerpt = redactSecrets(errorExcerpt(bodyText), secrets);
  const event: Extract<ActivityEvent, { type: 'failed' }> = {
    type: 'failed',
    kind,
    error: `HTTP ${res.status}${res.statusText === '' ? '' : ` ${res.statusText}`}${excerpt === '' ? '' : `: ${excerpt}`}`,
  };
  if (retryOnThrottle && (kind === 'rate_limit' || kind === 'transient')) {
    const retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'), Date.now());
    if (retryAfterSeconds !== undefined) event.retryAfterSeconds = retryAfterSeconds;
  }
  return event;
}

function overLimitFailure(maxBytes: number): Extract<ActivityEvent, { type: 'failed' }> {
  return {
    type: 'failed',
    kind: 'permanent',
    error: `the response is longer than Max size (${maxBytes} bytes); raise Max size, or set When over the limit to Truncate`,
  };
}

/**
 * The body read as JSON: an empty body is null. The depth is measured on the
 * text, without recursion, before `JSON.parse` builds a value that recursive
 * walks downstream (redaction, cloning) could overflow on.
 */
function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: null };
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      depth += 1;
      if (depth > WEB_MAX_JSON_DEPTH) {
        return {
          ok: false,
          error: `the response nests deeper than ${WEB_MAX_JSON_DEPTH} levels; set Parse as to Text`,
        };
      }
    } else if (c === '}' || c === ']') depth -= 1;
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      error: 'the response is not JSON; set Parse as to Text to read it as text',
    };
  }
}
