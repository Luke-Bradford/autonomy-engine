import type { ZodType } from 'zod';
import { ApiErrorBodySchema, type ApiErrorBody } from '@autonomy-studio/shared';

// `ApiErrorBody`/`ApiErrorBodySchema` are the SSOT for the error-response
// contract, authored once in `@autonomy-studio/shared` and shared with the
// server error handler (which builds every response `satisfies ApiErrorBody`).
// The hand-rolled interface that used to live here mirrored that shape by hand
// and could drift silently — see `packages/server/src/errors.ts` and #525.

/**
 * A non-2xx response. `status` is the HTTP code; `message` is the best
 * human-readable string the server offered (its `message`, else joined
 * validation issues, else the `error` code, else a generic fallback). The
 * raw parsed `body` is kept for callers that want to branch on `error`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | undefined;

  constructor(status: number, message: string, body?: ApiErrorBody) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The human-readable half of any thrown value.
 *
 * `catch` binds `unknown`, so every call site that wants to show a failure has
 * to narrow it — and this exact ternary had been written out inline more than
 * twenty times across the app before it was given a name. Named here, next to
 * `ApiError`, because that is where a caller is already looking when it decides
 * what to say about a failed request (project rule: export once, import
 * everywhere). Existing inline copies are equivalent and can migrate as their
 * files are touched.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function messageFromBody(status: number, body: ApiErrorBody | undefined): string {
  if (!body) return `request failed (${status})`;
  if (body.message) return body.message;
  if (body.issues && body.issues.length > 0) {
    const joined = body.issues
      .map((issue) =>
        issue.path ? `${issue.path}: ${issue.message ?? ''}` : (issue.message ?? ''),
      )
      .join('; ');
    // If the server capped the list, name the remainder rather than presenting
    // the shown subset as the whole (#496). `message`-bearing errors (e.g.
    // `invalid_pipeline_doc`) never reach here — they return above — and carry
    // their own bounded summary, so this suffix is the ZodError join path only.
    if (body.truncated && typeof body.totalIssues === 'number') {
      const rest = body.totalIssues - body.issues.length;
      if (rest > 0) return `${joined}; …and ${rest} more`;
    }
    return joined;
  }
  if (body.error) return body.error;
  return `request failed (${status})`;
}

/**
 * Turn a non-2xx `Response` into a thrown `ApiError`. Always throws; the
 * `never` return lets a caller write `if (!res.ok) await throwApiError(res)`
 * and have TypeScript narrow the rest of the function.
 *
 * Extracted so `apiFetchText` reports failures identically to `apiFetch`.
 * It CONSUMES the body, which is why both callers must check `res.ok` and
 * delegate here BEFORE reading the body themselves — a `res.text()` first
 * would leave this with an already-consumed stream, and every error in the
 * app would silently degrade to `request failed (<status>)`.
 */
async function throwApiError(res: Response): Promise<never> {
  let parsed: ApiErrorBody | undefined;
  try {
    // Parse (not blind-cast) through the shared contract: a body that does
    // not match is treated as absent rather than trusted by type assertion.
    // `safeParse` — never `.parse()` — because we must not throw a SECOND
    // error while handling the first; a malformed error body just falls back
    // to `messageFromBody`'s generic `request failed (<status>)`.
    const result = ApiErrorBodySchema.safeParse(await res.json());
    parsed = result.success ? result.data : undefined;
  } catch {
    parsed = undefined;
  }
  throw new ApiError(res.status, messageFromBody(res.status, parsed), parsed);
}

export interface ApiRequest<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialised as the request body when present. */
  body?: unknown;
  /**
   * Zod schema the (JSON) response is parsed through. The server and client
   * share ONE schema per resource, so a response that fails here is a genuine
   * contract violation, surfaced as a thrown `ZodError` — never silently
   * coerced. Omit for `204 No Content` (returns `undefined`).
   */
  schema?: ZodType<T>;
  signal?: AbortSignal;
}

/**
 * The single typed gateway to the studio REST API. Every call:
 *  - sends JSON when a `body` is given,
 *  - throws `ApiError(status, message)` on any non-2xx (message extracted from
 *    the server's fixed-shape error body — never a raw exception leaks),
 *  - returns `undefined` for `204`,
 *  - otherwise parses the JSON response through the supplied shared Zod
 *    `schema` (a contract check, not a formality), returning the typed value.
 *
 * Auth: the MVP server stamps a fixed local principal on every request (no
 * token), so no credentials are attached here — the swap point is server-side.
 */
export async function apiFetch<T = unknown>(path: string, opts: ApiRequest<T> = {}): Promise<T> {
  const { method = 'GET', body, schema, signal } = opts;

  const init: RequestInit = { method, signal };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  const res = await fetch(path, init);

  if (!res.ok) await throwApiError(res);

  // 204 No Content (and 205) carry no body — nothing to parse.
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }

  const json: unknown = await res.json();
  return schema ? schema.parse(json) : (json as T);
}

/**
 * `apiFetch`'s sibling for a response whose BYTES are the payload: the same
 * failure mapping, but the 2xx body is returned as raw text and never parsed.
 *
 * This is the one response in the app that is not validated against a shared
 * Zod schema, and that is the deliberate point of it. The portability export
 * routes send canonical JSON (#3 G1 — sorted keys, stable bytes) and the
 * operator's artifact must be the server's exact bytes. Round-tripping it
 * through `ExportEnvelopeSchema.parse` + a re-serialize would make the client
 * a second authority on canonical form, and a lossy one: `z.object` STRIPS
 * unknown keys, so any field a client schema copy lagged behind the server on
 * would be quietly dropped from the file the operator keeps.
 */
export async function apiFetchText(
  path: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const res = await fetch(path, { method: 'GET', signal: opts.signal });
  if (!res.ok) await throwApiError(res);
  return res.text();
}
