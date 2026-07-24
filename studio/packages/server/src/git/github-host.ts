import type { GitHostRepo } from '@autonomy-studio/shared';
import { redactSecrets } from '../connectors/redact.js';

/**
 * #3 G9b — open (or observe an existing) pull request via the GitHub REST API,
 * using an operator-env token (`GH_TOKEN`/`GITHUB_TOKEN`). This is the `opened`
 * path that sits alongside G9a's guided-manual compare URL: the route auto-opens
 * ONLY for a `github.com` remote WITH a token present, and otherwise falls back
 * to guided-manual (see `routes/workspace-git.ts`).
 *
 * AUTH MODEL (v1, pinned by G2): the operator's own environment — the token is
 * read from `process.env` at wiring time, NEVER stored in the DB, NEVER
 * client-supplied, NEVER logged. It flows only into the outbound `Authorization`
 * header. Stored PATs / multi-remote are G10. The token is passed IN per call so
 * this client holds no secret state.
 *
 * NO-HANG RAIL (spec: "Nothing can ever HANG an unattended op"): every request
 * is bounded by an `AbortController` timeout. A `fetch`/`Headers` throw (network
 * error, abort, or a malformed token whose CR/LF makes `Headers` throw a
 * `TypeError` that quotes the value VERBATIM) is caught and its message run
 * through `redactSecrets(msg, [token])` before it can reach any durable surface —
 * the same never-leak posture the LLM adapters take (`connectors/redact.ts`).
 *
 * The `fetchImpl` seam lets tests inject a fake `fetch` (no network); the CLI-git
 * `GitProvider` seam it mirrors is injected into the route the same way.
 */

const GITHUB_API_BASE = 'https://api.github.com';
/** GitHub requires a User-Agent; the API version pins the 2022-11-28 media contract. */
const USER_AGENT = 'autonomy-studio';
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 20_000;

export interface OpenPullRequestParams {
  /** Parsed GitHub coords (from the connect-allowlisted repoUrl — never re-parsed here). */
  repo: GitHostRepo;
  /** The collaboration branch the PR merges INTO. */
  base: string;
  /** The working branch the PR merges FROM (same-repo, so a bare branch name). */
  head: string;
  title: string;
  body: string;
  /** Operator-env token; already trimmed + non-empty by the route. */
  token: string;
}

/** A pull request studio opened or observed: its number + web URL. */
export interface OpenedPullRequest {
  number: number;
  htmlUrl: string;
}

export interface GitHostClient {
  openPullRequest(params: OpenPullRequestParams): Promise<OpenedPullRequest>;
}

/**
 * The host API could not fulfil the request through no fault of the request's
 * SHAPE: a network error, a timeout, an auth/permission refusal (401/403), a 5xx,
 * a malformed response, or an "already exists" the observe could not then find.
 * Mapped to 502 `git_error` (the same upstream-failure surface a `GitOperationError`
 * gets) — see `errors.ts`. Message is client-safe: built only from a status +
 * GitHub's own `message`, token-redacted.
 */
export class GitHostApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHostApiError';
  }
}

/**
 * The request was well-formed but SEMANTICALLY rejected by GitHub (a 422
 * "Validation Failed" that is NOT "already exists") — most commonly "No commits
 * between base and head" (the working branch has nothing ahead of collab, so
 * there is nothing to PR). That is a legitimate request-STATE refusal, not an
 * upstream outage, so it is mapped to 409 `conflict` (the `PublishRefusedError`
 * surface), NOT a 502. Message is GitHub-authored + token-redacted.
 */
export class GitHostRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHostRequestError';
  }
}

export interface GitHubHostClientOptions {
  /** Test seam: a fake `fetch` (no network). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Request-timeout override (ms); defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  /** Parsed JSON body, or `undefined` when the body was absent / not JSON. */
  json: unknown;
}

/** Collect GitHub's error strings: the top-level `message` plus every `errors[].message`. */
function collectGitHubMessages(json: unknown): string[] {
  const out: string[] = [];
  if (json !== null && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    if (typeof obj.message === 'string') out.push(obj.message);
    if (Array.isArray(obj.errors)) {
      for (const entry of obj.errors) {
        if (
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).message === 'string'
        ) {
          out.push((entry as Record<string, unknown>).message as string);
        }
      }
    }
  }
  return out;
}

/** A 422 whose messages say a PR already exists → observe the existing one (idempotent). */
function isAlreadyExists(json: unknown): boolean {
  return collectGitHubMessages(json).some((m) => /already exists/i.test(m));
}

/** GitHub's own error text for a body, or a fixed fallback — never our request payload. */
function describeGitHubError(json: unknown): string {
  const messages = collectGitHubMessages(json);
  return messages.length > 0 ? messages.join('; ') : 'no detail provided';
}

export class GitHubHostClient implements GitHostClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GitHubHostClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async openPullRequest(params: OpenPullRequestParams): Promise<OpenedPullRequest> {
    const { repo, base, head, title, body, token } = params;
    const owner = encodeURIComponent(repo.owner);
    const name = encodeURIComponent(repo.repo);

    const created = await this.request(
      'POST',
      `${GITHUB_API_BASE}/repos/${owner}/${name}/pulls`,
      token,
      { title, head, base, body },
    );

    if (created.status === 201) return this.parsePr(created.json, 'create', token);

    // A PR already exists for this head/base → OBSERVE it (make open idempotent).
    if (created.status === 422 && isAlreadyExists(created.json)) {
      return this.observe(repo, base, head, token, owner, name);
    }

    // A 422 that isn't "already exists" (e.g. "No commits between …") is a
    // request-STATE refusal, not an upstream failure → 409, not 502.
    if (created.status === 422) {
      throw new GitHostRequestError(
        redactSecrets(`GitHub refused the pull request: ${describeGitHubError(created.json)}`, [
          token,
        ]),
      );
    }

    throw new GitHostApiError(
      redactSecrets(
        `GitHub pull-request create failed (HTTP ${created.status}): ${describeGitHubError(
          created.json,
        )}`,
        [token],
      ),
    );
  }

  /** GET the single open PR matching this head/base after a 422 already-exists. */
  private async observe(
    repo: GitHostRepo,
    base: string,
    head: string,
    token: string,
    owner: string,
    name: string,
  ): Promise<OpenedPullRequest> {
    // The `head` filter is `<owner>:<branch>`; both query values are encoded —
    // a working branch is `studio/<owner>/work`, so the `/` (and any URL-
    // significant char) must not break the filter (or it silently matches
    // nothing → the empty-result guard below).
    const headFilter = encodeURIComponent(`${repo.owner}:${head}`);
    const baseFilter = encodeURIComponent(base);
    const listed = await this.request(
      'GET',
      `${GITHUB_API_BASE}/repos/${owner}/${name}/pulls?state=open&head=${headFilter}&base=${baseFilter}`,
      token,
      undefined,
    );

    if (listed.status !== 200 || !Array.isArray(listed.json)) {
      throw new GitHostApiError(
        redactSecrets(
          `GitHub pull-request observe failed (HTTP ${listed.status}): ${describeGitHubError(
            listed.json,
          )}`,
          [token],
        ),
      );
    }

    const first = listed.json[0];
    if (first === undefined) {
      // The create said one exists, but the open-PR filter found none — it was
      // closed/merged in the race, or the filter mismatched. Fail HONESTLY
      // (#473 shape): never crash on `[0]`, never manufacture a null-url result.
      throw new GitHostApiError(
        'GitHub reported an existing pull request but none was found open for the branch pair',
      );
    }
    return this.parsePr(first, 'observe', token);
  }

  /** Validate + extract `{ number, htmlUrl }` — a malformed payload fails loudly, never manufactured. */
  private parsePr(json: unknown, context: string, token: string): OpenedPullRequest {
    if (json !== null && typeof json === 'object') {
      const obj = json as Record<string, unknown>;
      const number = obj.number;
      const htmlUrl = obj.html_url;
      if (
        typeof number === 'number' &&
        Number.isInteger(number) &&
        number > 0 &&
        typeof htmlUrl === 'string' &&
        htmlUrl.length > 0
      ) {
        return { number, htmlUrl };
      }
    }
    throw new GitHostApiError(
      redactSecrets(`GitHub ${context} returned a malformed pull-request payload`, [token]),
    );
  }

  /**
   * One bounded GitHub request. Resolves with the status + parsed JSON (callers
   * interpret the status); throws `GitHostApiError` only for "the request itself
   * could not complete": a network error, a timeout (abort), or a malformed token
   * that makes `Headers`/`fetch` throw. The token is redacted from any thrown
   * message before it escapes.
   */
  private async request(
    method: 'GET' | 'POST',
    url: string,
    token: string,
    jsonBody: Record<string, unknown> | undefined,
  ): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // The timer stays armed until BOTH the fetch AND the body read complete: the
    // no-hang rail covers a response whose headers arrive but whose body then
    // stalls/trickles (undici ties the body stream to `signal`, so the abort
    // aborts the `res.json()` read too). Clearing it before the body read — the
    // obvious mistake — would leave a slow body unbounded.
    try {
      let res: Response;
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': USER_AGENT,
        };
        if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        throw this.requestFailure(err, controller.signal.aborted, token);
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        // A body read aborted by the timeout is a HANG we cut short — surface it
        // as a timeout, not a benign no-body. Otherwise the body was simply
        // absent / not JSON (e.g. an HTML 5xx): callers treat an undefined body
        // as "no GitHub detail", never as a valid PR payload.
        if (controller.signal.aborted) throw this.requestFailure(err, true, token);
        json = undefined;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A `fetch`/body-read throw → a token-redacted `GitHostApiError` (timeout vs failure). */
  private requestFailure(err: unknown, aborted: boolean, token: string): GitHostApiError {
    const detail = err instanceof Error ? err.message : String(err);
    return new GitHostApiError(
      redactSecrets(
        aborted
          ? `GitHub request timed out after ${this.timeoutMs}ms`
          : `GitHub request failed: ${detail}`,
        [token],
      ),
    );
  }
}
