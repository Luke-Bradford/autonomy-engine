import { z } from 'zod';
import { optionTitles, presented, singleLine } from '../schemas/field-presentation.js';
import { SecretRefSchema } from '../schemas/secret-ref.js';
import { DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_MAX_READ_BYTES } from './connection-config.js';

/**
 * The `http_request` secret-SINK config field name (item 7 / S4) — the ONE
 * source of truth, shared by `http_request` and `web` (#1600 OR41 C11a). The
 * catalog declares it as a sink on both; the server http adapter
 * (`connectors/http.ts`) imports it to derive the `secretFields` key prefix it
 * consumes. Shared so a rename can't silently desync the two sides (a magic
 * string on each would drop the secret header without a type error).
 */
export const HTTP_SECRET_HEADERS_FIELD = 'secretHeaders';

/**
 * The Zod SHAPE of the `secretHeaders` sink value: header name → inert
 * `{$secret:name}` marker. SSOT'd here (not just the field NAME above) so the
 * catalog `configSchema`s and the http adapter's live input schemas can't desync
 * on the value/key constraints either — one change to the record shape reaches
 * every consumer, type-checked.
 */
export const httpSecretHeadersSchema = z.record(z.string(), SecretRefSchema).optional();

/**
 * #1600 OR41 C11a — Web's config (catalogue §4.6), the SINGLE SOURCE OF TRUTH
 * read by the catalog entry and the `http` adapter's `web` arm
 * (`connectors/http-web.ts`).
 *
 * ADF's Web activity
 * (https://learn.microsoft.com/azure/data-factory/control-flow-web-activity)
 * names `method`, `url`, `headers`, `body` and `httpRequestTimeout`; studio keeps
 * those names, with the timeout in seconds as every studio duration is. The
 * other settings are §4.6's: ADF fails every non-2xx and caps a response at
 * 4 MB, and the toggles let an author keep a status as data instead.
 */

/**
 * ADF's five methods plus HEAD, which studio adds: the connection test already
 * sends one, and `http_request` (lowered to Web in C11b) accepted it.
 */
const WEB_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
const methodSchema = z.enum(WEB_METHODS);

const parseAsSchema = z.enum(['json', 'text']);

const whenOverLimitSchema = z.enum(['fail', 'truncate']);

/** ADF's response limit, 4 MB, as the default Max size. */
export const WEB_DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The largest Max size an author may set: the connections' read ceiling. A
 * response lands in `node.succeeded` on every attempt, so it is bounded by the
 * same figure that bounds a file read, not by a number of Web's own.
 */
export const WEB_MAX_RESPONSE_BYTES = DEFAULT_MAX_READ_BYTES;

/** ADF's `httpRequestTimeout` ceiling, 10 minutes. */
export const WEB_MAX_REQUEST_TIMEOUT_SECONDS = 600;

export const webConfigSchema = z
  .object({
    url: presented(singleLine(z.string()).min(1), {
      title: 'Request URL',
      description: "The address to call, joined to the connection's base URL when it is relative.",
    }),
    method: presented(methodSchema.default('GET'), {
      title: 'Method',
      options: optionTitles(methodSchema, {
        GET: 'GET',
        POST: 'POST',
        PUT: 'PUT',
        PATCH: 'PATCH',
        DELETE: 'DELETE',
        HEAD: 'HEAD',
      }),
    }),
    headers: presented(z.record(z.string(), z.string()).optional(), {
      title: 'Request headers',
    }),
    body: presented(z.string().optional(), {
      title: 'Body',
      description: 'The payload sent with POST, PUT, PATCH or DELETE. GET and HEAD send none.',
    }),
    [HTTP_SECRET_HEADERS_FIELD]: presented(httpSecretHeadersSchema, {
      title: 'Secret headers',
      description:
        'Headers whose values come from stored secrets, sent last and never echoed. Not sent on a redirect to another origin.',
    }),
    // On for a new node, as in ADF. A lowered `http_request` sets it off (§8).
    failOnHttpError: presented(z.boolean().default(true), {
      title: 'Fail on HTTP error',
      description:
        'Fail when the response status is 400 or above. Off, every status succeeds and is read from the status output.',
    }),
    successStatusCodes: presented(z.array(z.number().int().min(100).max(599)).optional(), {
      title: 'Treat as success',
      description: 'Status codes that succeed even though Fail on HTTP error is on, e.g. [404].',
    }),
    httpRequestTimeoutSeconds: presented(
      z.number().int().min(1).max(WEB_MAX_REQUEST_TIMEOUT_SECONDS).optional(),
      {
        title: 'HTTP request timeout',
        description: `Seconds the whole exchange may take, 1 to ${WEB_MAX_REQUEST_TIMEOUT_SECONDS}. Empty uses the connection's timeout, or ${DEFAULT_HTTP_TIMEOUT_MS / 1000}. ADF's httpRequestTimeout.`,
      },
    ),
    parseAs: presented(parseAsSchema.default('json'), {
      title: 'Parse as',
      description:
        'JSON reads the body into a value; an empty body is null. Text keeps it a string. An error status let through keeps a body that is not JSON as text.',
      options: optionTitles(parseAsSchema, { json: 'JSON', text: 'Text' }),
    }),
    maxResponseBytes: presented(
      z.number().int().min(1).max(WEB_MAX_RESPONSE_BYTES).default(WEB_DEFAULT_MAX_RESPONSE_BYTES),
      {
        title: 'Max size (bytes)',
        description: `The largest response body read, up to ${WEB_MAX_RESPONSE_BYTES}. ADF's limit, 4 MB, by default.`,
      },
    ),
    whenOverLimit: presented(whenOverLimitSchema.default('fail'), {
      title: 'When over the limit',
      description:
        'Fail, or keep the first Max size bytes, set truncated and warn. Truncate needs Parse as Text.',
      options: optionTitles(whenOverLimitSchema, { fail: 'Fail', truncate: 'Truncate' }),
    }),
    retryOnThrottle: presented(z.boolean().default(true), {
      title: 'Retry on 429 and 503',
      description:
        "A 429 or 5xx is retried under the activity's retry policy, after the server's Retry-After when it sends one. Off, a 429 or 503 fails without retrying; any other 5xx is still retried.",
    }),
  })
  .superRefine((cfg, ctx) => {
    // As in `deleteConfigSchema`: refuse a setting that would be ignored, rather
    // than quietly ignore it. A `${}` value is decided at dispatch.
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });
    if (cfg.successStatusCodes !== undefined && !cfg.failOnHttpError) {
      issue('successStatusCodes', 'only read when Fail on HTTP error is on');
    }
    if (cfg.whenOverLimit === 'truncate' && cfg.parseAs !== 'text') {
      issue('whenOverLimit', 'Truncate needs Parse as Text: a JSON prefix is not JSON');
    }
    if (webHasBody(cfg) && (cfg.method === 'GET' || cfg.method === 'HEAD')) {
      issue('body', `an HTTP ${cfg.method} cannot carry a body`);
    }
  });

/** An empty Body box is no body, so it never makes a GET unsaveable. */
export function webHasBody(cfg: { body?: string }): cfg is { body: string } {
  return cfg.body !== undefined && cfg.body !== '';
}
