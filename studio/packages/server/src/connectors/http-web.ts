import {
  DEFAULT_HTTP_TIMEOUT_MS,
  formatZodIssues,
  webCallbackBody,
  webHasBody,
  WARNING_CODES,
  WEB_DEFAULT_CALLBACK_TIMEOUT_SECONDS,
  webConfigSchema,
  type httpConnectionConfigSchema,
} from '@autonomy-studio/shared';
import type { z } from 'zod';
import type { ActivityContext, ActivityEvent } from './types.js';
import { redactSecrets } from './redact.js';
import {
  buildRequestHeaders,
  collectResponseHeaders,
  exchangeDeadline,
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
 *   off makes those two `permanent`; any other 5xx stays a retry candidate.
 * - **The body is bounded.** At most *Max size* bytes are read; a longer body
 *   fails (`permanent`), or with *Truncate* keeps the prefix, sets `truncated`
 *   and warns. A `Content-Length` over the limit fails before the body is read,
 *   except under a `Content-Encoding`, where it is the compressed size, and on
 *   a HEAD, 204 or 304, which have no body.
 * - **Parse as** JSON (an empty body is null; a body that is not JSON, or nests
 *   deeper than `WEB_MAX_JSON_DEPTH`, fails `permanent`, except that an error
 *   status let through keeps a non-JSON body as text) or Text.
 * - **No secret reaches the outputs.** The Bearer and the secret headers are
 *   redacted from the body and the response headers, for an endpoint that
 *   echoes its request.
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
  // #1600 OR41 C11c — Wait for callback sends the author's JSON object body with
  // `callBackUri` added. The executor sets `ctx.callbackUri` for such a node.
  let body = webHasBody(cfg) ? cfg.body : undefined;
  let callbackUri: string | undefined;
  if (cfg.waitForCallback) {
    if (ctx.callbackUri === undefined) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error: 'Wait for callback has no callback URL to send',
      };
      return;
    }
    callbackUri = ctx.callbackUri;
    const withUri = webCallbackBody(cfg.body, callbackUri);
    if (!withUri.ok) {
      yield { type: 'failed', kind: 'permanent', error: withUri.error };
      return;
    }
    body = withUri.json;
  }
  const sinkHeaders = sinkHeadersFrom(secretFields);
  const requestHeaders = buildRequestHeaders(connection.headers, cfg.headers, secret, sinkHeaders);
  // An error message drops every request header value, as `http_request`'s
  // does; the outputs only the secrets, since a response may legitimately hold
  // a plain header's value. The callback URL and its token are secrets too: an
  // endpoint that echoes its request would otherwise put a live capability
  // into the run log (#925).
  const outputSecrets = [
    secret,
    ...Object.values(sinkHeaders),
    ...(callbackUri !== undefined ? [callbackUri, callbackToken(callbackUri)] : []),
  ];
  // The bare secret too: a header value is `Bearer <secret>`, and a 401 body
  // may echo the token alone.
  const headerValues = [...Object.values(requestHeaders), ...outputSecrets];
  // Added after `headerValues`: a fixed media type is no secret, and an error
  // naming `application/json` should keep it.
  if (callbackUri !== undefined && !hasHeader(requestHeaders, 'content-type')) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const timeoutMs =
    cfg.httpRequestTimeoutSeconds !== undefined
      ? cfg.httpRequestTimeoutSeconds * 1000
      : (connection.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  const deadline = exchangeDeadline(ctx.signal, timeoutMs);

  const startedAt = Date.now();
  try {
    const res = await fetchWithoutLeakingSecrets(
      resolveUrl(connection.baseUrl, cfg.url),
      {
        method: cfg.method,
        headers: requestHeaders,
        ...(body !== undefined ? { body } : {}),
        signal: deadline.signal,
      },
      Object.keys(sinkHeaders),
      callbackUri !== undefined,
    );

    const failsOnStatus =
      cfg.failOnHttpError &&
      res.status >= 400 &&
      !(cfg.successStatusCodes ?? []).includes(res.status);
    if (failsOnStatus) {
      // Enough of the body for the excerpt, never more than Max size.
      const { data } = await readBodyBounded(res.body, Math.min(cfg.maxResponseBytes, 4096));
      yield statusFailure(res, new TextDecoder().decode(data), cfg.retryOnThrottle, headerValues);
      return;
    }

    // A HEAD, a 204 and a 304 have no body, whatever their Content-Length says.
    const bodiless = cfg.method === 'HEAD' || res.status === 204 || res.status === 304;
    const declared = Number(res.headers.get('content-length'));
    if (
      !bodiless &&
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
    deadline.disarm(); // exchange complete — disarm before emitting
    const durationMs = Date.now() - startedAt;
    if (overLimit && cfg.whenOverLimit === 'fail') {
      yield overLimitFailure(cfg.maxResponseBytes);
      return;
    }
    // `stream: true` on a truncated body holds back a UTF-8 sequence the cut
    // split, rather than decoding it to U+FFFD.
    // A response that echoes the Bearer or a secret header (an echo endpoint
    // does) must not carry it into the run log.
    const text = redactSecrets(
      new TextDecoder().decode(data, { stream: overLimit }),
      outputSecrets,
    );
    let responseBody: unknown = text;
    if (cfg.parseAs === 'json') {
      const json = parseWebJson(text);
      if (json.ok) responseBody = json.value;
      // An error status let through (Fail on HTTP error off, or Treat as
      // success) is often an HTML page: it stays text rather than fail the
      // node the author asked to succeed.
      else if (res.status < 400) {
        yield { type: 'failed', kind: 'permanent', error: json.error };
        return;
      }
    }
    if (overLimit) {
      yield {
        type: 'warned',
        code: WARNING_CODES.WEB_RESPONSE_TRUNCATED,
        reason: `the response was longer than Max size (${cfg.maxResponseBytes} bytes); the first ${data.byteLength} bytes were kept`,
      };
    }
    const outputs = {
      status: res.status,
      headers: collectResponseHeaders(res, outputSecrets),
      body: responseBody,
      bytes: data.byteLength,
      durationMs,
      truncated: overLimit,
    };
    if (cfg.waitForCallback) {
      // The request succeeded; the node now waits for its callback.
      yield {
        type: 'awaitCallback',
        outputs,
        timeoutSeconds: cfg.callbackTimeoutSeconds ?? WEB_DEFAULT_CALLBACK_TIMEOUT_SECONDS,
      };
      return;
    }
    yield { type: 'succeeded', outputs: { ...outputs, callback: null } };
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), headerValues);
    if (ctx.signal.aborted) {
      yield { type: 'failed', kind: 'cancelled', error: 'web request aborted' };
    } else if (deadline.timedOut()) {
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
    deadline.dispose();
  }
}

function statusFailure(
  res: Response,
  bodyText: string,
  retryOnThrottle: boolean,
  secrets: readonly (string | null)[],
): Extract<ActivityEvent, { type: 'failed' }> {
  const classified = classifyHttpStatus(res.status);
  const throttled = res.status === 429 || res.status === 503;
  const kind = throttled && !retryOnThrottle ? 'permanent' : classified;
  // Redact the whole text, then cut: a secret the cut split would otherwise
  // survive as a prefix.
  const excerpt = errorExcerpt(redactSecrets(bodyText, secrets));
  const event: Extract<ActivityEvent, { type: 'failed' }> = {
    type: 'failed',
    kind,
    error: `HTTP ${res.status}${res.statusText === '' ? '' : ` ${res.statusText}`}${excerpt === '' ? '' : `: ${excerpt}`}`,
  };
  if (kind === 'rate_limit' || kind === 'transient') {
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
 * Deeper JSON fails. The redaction walk (`redact.ts`, `MAX_REDACT_DEPTH` 100)
 * masks whatever lies past its ceiling, so a body nearer that ceiling could lose
 * values to it; 64 leaves the margin.
 */
export const WEB_MAX_JSON_DEPTH = 64;

/**
 * The body read as JSON: an empty body is null. Also reads a Wait for callback's
 * callback body (#1600 C11c, `external-wait-service.ts`). The depth is measured on the
 * text, without recursion, so a value no recursive walk downstream can take
 * (redaction, cloning) never reaches the outputs.
 */
export function parseWebJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: 'the response is not JSON; set Parse as to Text to read it as text',
    };
  }
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
  return { ok: true, value };
}

/** A header set's own case-insensitive lookup: HTTP header names are. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** The capability token at the end of a callback URL, redacted on its own too. */
function callbackToken(callbackUri: string): string {
  return callbackUri.slice(callbackUri.lastIndexOf('/') + 1);
}
