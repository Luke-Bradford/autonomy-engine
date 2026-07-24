import { describe, expect, it } from 'vitest';
import type { GitHostRepo } from '@autonomy-studio/shared';
import {
  GitHostApiError,
  GitHostRequestError,
  GitHubHostClient,
  type OpenPullRequestParams,
} from '../github-host.js';

/**
 * #3 G9b — the GitHub PR host client, exercised with a FAKE `fetch` (no network):
 * create → 201, already-exists → observe, and every failure/leak edge (auth,
 * validation-refusal, empty observe, malformed payload, timeout, malformed token).
 */

const REPO: GitHostRepo = { host: 'github.com', owner: 'acme', repo: 'widgets' };
const TOKEN = 'ghp_sup3rsecret_token_value';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fake `fetch` that records calls and replays a scripted queue of responses. */
function scriptedFetch(responses: Array<{ status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    const next = responses[i];
    i += 1;
    if (next === undefined) throw new Error('scriptedFetch: no more responses queued');
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function params(overrides: Partial<OpenPullRequestParams> = {}): OpenPullRequestParams {
  return {
    repo: REPO,
    base: 'main',
    head: 'studio/local/work',
    title: 'Studio changes: studio/local/work',
    body: 'opened by studio',
    token: TOKEN,
    ...overrides,
  };
}

describe('GitHubHostClient.openPullRequest', () => {
  it('opens a PR (201) and returns its number + html_url', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 201, body: { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' } },
    ]);
    const client = new GitHubHostClient({ fetchImpl });

    const result = await client.openPullRequest(params());

    expect(result).toEqual({ number: 42, htmlUrl: 'https://github.com/acme/widgets/pull/42' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/widgets/pulls');
    // The token rides ONLY in the Authorization header.
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(calls[0]?.headers.Accept).toBe('application/vnd.github+json');
    expect(calls[0]?.headers['User-Agent']).toBeTruthy();
    const sent = JSON.parse(calls[0]?.body ?? '{}');
    expect(sent).toEqual({
      title: 'Studio changes: studio/local/work',
      head: 'studio/local/work',
      base: 'main',
      body: 'opened by studio',
    });
  });

  it('a 422 "already exists" → observes the existing open PR (idempotent)', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ message: 'A pull request already exists for acme:studio/local/work.' }],
        },
      },
      { status: 200, body: [{ number: 7, html_url: 'https://github.com/acme/widgets/pull/7' }] },
    ]);
    const client = new GitHubHostClient({ fetchImpl });

    const result = await client.openPullRequest(params());

    expect(result).toEqual({ number: 7, htmlUrl: 'https://github.com/acme/widgets/pull/7' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe('GET');
    // The observe GET encodes the head (owner:branch, "/" and ":" percent-encoded) + base.
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/acme/widgets/pulls?state=open&head=acme%3Astudio%2Flocal%2Fwork&base=main',
    );
  });

  it('a 422 "already exists" but the observe finds NO open PR → GitHostApiError (never crashes on [0])', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 422, body: { errors: [{ message: 'A pull request already exists for acme:x.' }] } },
      { status: 200, body: [] },
    ]);
    const client = new GitHubHostClient({ fetchImpl });

    await expect(client.openPullRequest(params())).rejects.toBeInstanceOf(GitHostApiError);
  });

  it('a 422 that is NOT already-exists (no commits between) → GitHostRequestError (409-mapped), with GitHub text', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ message: 'No commits between main and studio/local/work' }],
        },
      },
    ]);
    const client = new GitHubHostClient({ fetchImpl });

    const err = await client.openPullRequest(params()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHostRequestError);
    expect((err as Error).message).toContain('No commits between');
  });

  it('a 401 auth refusal → GitHostApiError (502-mapped)', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    const client = new GitHubHostClient({ fetchImpl });

    const err = await client.openPullRequest(params()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHostApiError);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).toContain('Bad credentials');
  });

  it('a 5xx → GitHostApiError (even with a non-JSON body)', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 503, body: undefined }]);
    const client = new GitHubHostClient({ fetchImpl });

    await expect(client.openPullRequest(params())).rejects.toBeInstanceOf(GitHostApiError);
  });

  it('a malformed 201 payload (missing html_url) → GitHostApiError, never a manufactured result', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 201, body: { number: 42 } }]);
    const client = new GitHubHostClient({ fetchImpl });

    await expect(client.openPullRequest(params())).rejects.toBeInstanceOf(GitHostApiError);
  });

  it('a timeout aborts the request and surfaces "timed out" — never hangs', async () => {
    // A fetch that never resolves except by the abort signal.
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const client = new GitHubHostClient({ fetchImpl: hangingFetch, timeoutMs: 5 });

    const err = await client.openPullRequest(params()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHostApiError);
    expect((err as Error).message).toContain('timed out');
  });

  it('a fetch throw quoting a malformed token is REDACTED before it escapes (never leaks the token)', async () => {
    // Node header validation throws a TypeError quoting the header value verbatim.
    const throwingFetch = (() => {
      throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
    }) as unknown as typeof fetch;
    const client = new GitHubHostClient({ fetchImpl: throwingFetch });

    const err = await client.openPullRequest(params()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHostApiError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain('***');
  });

  it('encodes URL-significant chars in owner/repo into the request path', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 201, body: { number: 1, html_url: 'https://x/pull/1' } },
    ]);
    const client = new GitHubHostClient({ fetchImpl });

    await client.openPullRequest(
      params({ repo: { host: 'github.com', owner: 'ac me', repo: 'wid#g' } }),
    );
    expect(calls[0]?.url).toBe('https://api.github.com/repos/ac%20me/wid%23g/pulls');
  });
});
