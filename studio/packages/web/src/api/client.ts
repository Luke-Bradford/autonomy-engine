import type { ZodType } from 'zod';

/**
 * The shape every server error handler branch returns (see
 * `packages/server/src/errors.ts`): a stable `error` code, an optional
 * client-safe `message`, and (for `validation_error`) a list of Zod issues.
 * Nothing else is ever forwarded to the client, so this is the whole contract.
 */
interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ path?: string; message?: string }>;
  /**
   * Present (and `true`) only when the server capped `issues[]` — its absence
   * means the list is complete (#496). `totalIssues` is the pre-cap count, so
   * a client can state "showing N of totalIssues" rather than silently
   * rendering a truncated tail as the whole story.
   */
  truncated?: boolean;
  totalIssues?: number;
}

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

export interface ApiRequest<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

  if (!res.ok) {
    let parsed: ApiErrorBody | undefined;
    try {
      parsed = (await res.json()) as ApiErrorBody;
    } catch {
      parsed = undefined;
    }
    throw new ApiError(res.status, messageFromBody(res.status, parsed), parsed);
  }

  // 204 No Content (and 205) carry no body — nothing to parse.
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }

  const json: unknown = await res.json();
  return schema ? schema.parse(json) : (json as T);
}
