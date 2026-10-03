import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceGit } from '../../repo/index.js';
import {
  GitHostApiError,
  type FindOpenPullRequestParams,
  type GitHostClient,
  type OpenedPullRequest,
} from '../../git/github-host.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #1476 OR28 — `GET /api/workspace/git/pull-request`, the editor badge's
 * `PR #n`: which pull request is open from the working branch into the
 * collaboration branch. The host API is faked (the real client is unit-tested
 * in `git/__tests__/github-host.test.ts`); these prove the route's gating, its
 * fail-safe polarity (only a host answer is ever `none`) and its refresh policy
 * (one host call per `GIT_FETCH_MAX_AGE_SECONDS` window, shared by concurrent
 * reads). Rows are seeded directly: the route never touches the checkout.
 */

type Outcome = { kind: 'found'; pr: OpenedPullRequest | null } | { kind: 'throw'; error: Error };

class FakeHostClient implements GitHostClient {
  finds: FindOpenPullRequestParams[] = [];
  /** Resolves the pending finds when `hold` is set, so a test can overlap two reads. */
  private release: (() => void) | null = null;
  constructor(
    public outcome: Outcome,
    private readonly hold = false,
  ) {}
  async openPullRequest(): Promise<OpenedPullRequest> {
    return { number: 12, htmlUrl: 'https://github.com/acme/widgets/pull/12' };
  }
  async findOpenPullRequest(params: FindOpenPullRequestParams): Promise<OpenedPullRequest | null> {
    this.finds.push(params);
    if (this.hold) await new Promise<void>((r) => (this.release = r));
    if (this.outcome.kind === 'throw') throw this.outcome.error;
    return this.outcome.pr;
  }
  releaseAll(): void {
    this.release?.();
  }
}

const PR_7 = { number: 7, htmlUrl: 'https://github.com/acme/widgets/pull/7' };

describe('GET /api/workspace/git/pull-request (#1476 OR28)', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.app.close();
    testApp = undefined;
  });

  async function boot(opts: {
    hostClient: GitHostClient;
    githubToken?: string | null;
    gitFetchMaxAgeMs?: number;
  }): Promise<FastifyInstance> {
    testApp = await buildTestAppWithContext({
      githubToken: opts.githubToken === undefined ? 'ghp_token' : opts.githubToken,
      workspaceGitHostClient: opts.hostClient,
      gitFetchMaxAgeMs: opts.gitFetchMaxAgeMs ?? 60_000,
    });
    return testApp.app;
  }

  function seed(app: FastifyInstance, repoUrl = 'https://github.com/acme/widgets.git'): void {
    createWorkspaceGit(app.db, {
      ownerId: 'local',
      repoUrl,
      collabBranch: 'main',
      workingBranch: 'studio/local/work',
      observedCollabHead: 'deadbeef',
      lastFetchAt: Date.now(),
      lastFetchError: null,
    });
  }

  async function read(app: FastifyInstance) {
    const res = await app.inject({ method: 'GET', url: '/api/workspace/git/pull-request' });
    return { status: res.statusCode, body: res.json() as { pullRequest: Record<string, unknown> } };
  }

  it('an open PR from the working branch, into any base → open, with its number and page', async () => {
    const host = new FakeHostClient({ kind: 'found', pr: PR_7 });
    const app = await boot({ hostClient: host });
    seed(app);
    const { status, body } = await read(app);
    expect(status).toBe(200);
    expect(body.pullRequest).toMatchObject({
      state: 'open',
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
    });
    expect(body.pullRequest.checkedAt).toEqual(expect.any(Number));
    expect(host.finds).toEqual([
      {
        repo: { host: 'github.com', owner: 'acme', repo: 'widgets' },
        head: 'studio/local/work',
        token: 'ghp_token',
      },
    ]);
  });

  it('the host answered with none → none', async () => {
    const app = await boot({ hostClient: new FakeHostClient({ kind: 'found', pr: null }) });
    seed(app);
    expect((await read(app)).body.pullRequest).toMatchObject({ state: 'none' });
  });

  it('a failed lookup is unknown, never none — with the redacted message, and 200 not 502', async () => {
    const host = new FakeHostClient({
      kind: 'throw',
      error: new GitHostApiError('GitHub pull-request lookup failed (HTTP 401): Bad credentials'),
    });
    const app = await boot({ hostClient: host });
    seed(app);
    const { status, body } = await read(app);
    expect(status).toBe(200);
    expect(body.pullRequest).toEqual({
      state: 'unknown',
      reason: 'lookup_failed',
      detail: 'GitHub pull-request lookup failed (HTTP 401): Bad credentials',
    });
  });

  it('the lookup_failed detail never carries the token, even if a host message quoted it', async () => {
    const host = new FakeHostClient({
      kind: 'throw',
      error: new GitHostApiError('GitHub request failed: bad header Bearer ghp_token'),
    });
    const app = await boot({ hostClient: host });
    seed(app);
    const detail = (await read(app)).body.pullRequest.detail as string;
    expect(detail).toMatch(/^GitHub request failed/);
    expect(detail).not.toContain('ghp_token');
  });

  it('a non-git fault in the lookup is not swallowed into unknown', async () => {
    const app = await boot({
      hostClient: new FakeHostClient({ kind: 'throw', error: new Error('boom') }),
    });
    seed(app);
    expect((await read(app)).status).toBe(500);
  });

  it('no token → unknown/no_token, and the host is never asked', async () => {
    const host = new FakeHostClient({ kind: 'found', pr: PR_7 });
    const app = await boot({ hostClient: host, githubToken: null });
    seed(app);
    expect((await read(app)).body.pullRequest).toEqual({
      state: 'unknown',
      reason: 'no_token',
      detail: null,
    });
    expect(host.finds).toHaveLength(0);
  });

  it('a local or non-GitHub remote → unknown/unsupported_host, host never asked', async () => {
    const host = new FakeHostClient({ kind: 'found', pr: PR_7 });
    const app = await boot({ hostClient: host });
    seed(app, '/tmp/some/local/repo');
    expect((await read(app)).body.pullRequest).toEqual({
      state: 'unknown',
      reason: 'unsupported_host',
      detail: null,
    });
    expect(host.finds).toHaveLength(0);
  });

  it('404 when no repo is connected', async () => {
    const app = await boot({ hostClient: new FakeHostClient({ kind: 'found', pr: null }) });
    expect((await read(app)).status).toBe(404);
  });

  it('reuses one answer for the window, then asks again', async () => {
    const host = new FakeHostClient({ kind: 'found', pr: null });
    const app = await boot({ hostClient: host, gitFetchMaxAgeMs: 60_000 });
    seed(app);
    await read(app);
    host.outcome = { kind: 'found', pr: PR_7 };
    expect((await read(app)).body.pullRequest).toMatchObject({ state: 'none' });
    expect(host.finds).toHaveLength(1);

    const fresh = new FakeHostClient({ kind: 'found', pr: null });
    const every = await boot({ hostClient: fresh, gitFetchMaxAgeMs: 0 });
    seed(every);
    await read(every);
    fresh.outcome = { kind: 'found', pr: PR_7 };
    expect((await read(every)).body.pullRequest).toMatchObject({ state: 'open', number: 7 });
    expect(fresh.finds).toHaveLength(2);
  });

  it('a failed lookup waits out the window too, so a down host is not asked on every focus', async () => {
    const host = new FakeHostClient({ kind: 'throw', error: new GitHostApiError('timed out') });
    const app = await boot({ hostClient: host });
    seed(app);
    await read(app);
    await read(app);
    expect(host.finds).toHaveLength(1);
  });

  it('concurrent reads share one host call', async () => {
    const host = new FakeHostClient({ kind: 'found', pr: PR_7 }, true);
    const app = await boot({ hostClient: host });
    seed(app);
    const a = read(app);
    const b = read(app);
    await new Promise((r) => setTimeout(r, 20));
    host.releaseAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect(host.finds).toHaveLength(1);
    expect(ra.body.pullRequest).toMatchObject({ state: 'open', number: 7 });
    expect(rb.body.pullRequest).toMatchObject({ state: 'open', number: 7 });
  });

  it('opening a PR here is seen at once, without waiting out the window', async () => {
    const host = new FakeHostClient({ kind: 'found', pr: null });
    const app = await boot({ hostClient: host });
    seed(app);
    expect((await read(app)).body.pullRequest).toMatchObject({ state: 'none' });
    const opened = await app.inject({
      method: 'POST',
      url: '/api/workspace/git/pull-request',
      payload: {},
    });
    expect(opened.statusCode).toBe(200);
    host.outcome = {
      kind: 'found',
      pr: { number: 12, htmlUrl: 'https://github.com/acme/widgets/pull/12' },
    };
    expect((await read(app)).body.pullRequest).toMatchObject({ state: 'open', number: 12 });
    expect(host.finds).toHaveLength(2);
  });

  it('a different working branch is a different question, not the cached answer', async () => {
    const host = new FakeHostClient({ kind: 'found', pr: PR_7 });
    const app = await boot({ hostClient: host });
    seed(app);
    await read(app);
    const moved = await app.inject({
      method: 'POST',
      url: '/api/workspace/git/working-branch',
      payload: { workingBranch: 'feature/other' },
    });
    expect(moved.statusCode).toBe(200);
    host.outcome = { kind: 'found', pr: null };
    expect((await read(app)).body.pullRequest).toMatchObject({ state: 'none' });
    expect(host.finds.map((f) => f.head)).toEqual(['studio/local/work', 'feature/other']);
  });

  it('setting or clearing the stored token drops the cached answer', async () => {
    const host = new FakeHostClient({
      kind: 'throw',
      error: new GitHostApiError('Bad credentials'),
    });
    const app = await boot({ hostClient: host });
    seed(app);
    expect((await read(app)).body.pullRequest).toMatchObject({ state: 'unknown' });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/workspace/git/token',
      payload: { token: 'ghp_better' },
    });
    expect(put.statusCode).toBe(200);
    host.outcome = { kind: 'found', pr: PR_7 };
    expect((await read(app)).body.pullRequest).toMatchObject({ state: 'open', number: 7 });
    expect(host.finds.at(-1)?.token).toBe('ghp_better');
  });
});
