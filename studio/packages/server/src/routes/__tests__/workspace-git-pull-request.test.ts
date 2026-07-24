import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceGit } from '../../repo/index.js';
import {
  GitHostApiError,
  GitHostRequestError,
  type GitHostClient,
  type OpenPullRequestParams,
} from '../../git/github-host.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G9b — the pull-request route's AUTO-OPEN path: when the remote is GitHub and
 * an operator-env token is present, studio opens the PR via the host API
 * (`mode:'opened'`); otherwise it falls back to G9a's guided-manual. The host API
 * itself is faked (a `GitHostClient` seam — the real fetch client is unit-tested
 * separately), so these prove the route's WIRING: token gating, host gating,
 * result shape, and error mapping.
 *
 * The row is seeded directly (a github.com URL is not clonable in a test — the
 * same pattern the guided-manual route test uses); the pull-request route never
 * touches the checkout, so no clone is needed.
 */

/** A fake host client: records the params it was called with, replays a scripted outcome. */
class FakeHostClient implements GitHostClient {
  calls: OpenPullRequestParams[] = [];
  constructor(
    private readonly outcome:
      { kind: 'opened'; number: number; htmlUrl: string } | { kind: 'throw'; error: Error },
  ) {}
  async openPullRequest(
    params: OpenPullRequestParams,
  ): Promise<{ number: number; htmlUrl: string }> {
    this.calls.push(params);
    if (this.outcome.kind === 'throw') throw this.outcome.error;
    return { number: this.outcome.number, htmlUrl: this.outcome.htmlUrl };
  }
}

describe('workspace-git pull-request route — auto-open (G9b)', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.app.close();
    testApp = undefined;
  });

  async function makeApp(overrides: {
    githubToken?: string | null;
    hostClient?: GitHostClient;
  }): Promise<FastifyInstance> {
    testApp = await buildTestAppWithContext({
      githubToken: overrides.githubToken,
      workspaceGitHostClient: overrides.hostClient,
    });
    return testApp.app;
  }

  function seedGitHub(app: FastifyInstance, workingBranch = 'studio/local/work'): void {
    createWorkspaceGit(app.db, {
      ownerId: 'local',
      repoUrl: 'https://github.com/acme/widgets.git',
      collabBranch: 'main',
      workingBranch,
      observedCollabHead: 'deadbeef',
      lastFetchAt: Date.now(),
      lastFetchError: null,
    });
  }

  function seedLocal(app: FastifyInstance): void {
    createWorkspaceGit(app.db, {
      ownerId: 'local',
      repoUrl: '/tmp/some/local/repo',
      collabBranch: 'main',
      workingBranch: 'studio/local/work',
      observedCollabHead: 'deadbeef',
      lastFetchAt: Date.now(),
      lastFetchError: null,
    });
  }

  function openPr(app: FastifyInstance) {
    return app.inject({ method: 'POST', url: '/api/workspace/git/pull-request', payload: {} });
  }

  it('GitHub remote + token → opens the PR via the host API (mode:opened, url+number)', async () => {
    const hostClient = new FakeHostClient({
      kind: 'opened',
      number: 42,
      htmlUrl: 'https://github.com/acme/widgets/pull/42',
    });
    const app = await makeApp({ githubToken: 'ghp_token', hostClient });
    seedGitHub(app);

    const res = await openPr(app);
    expect(res.statusCode).toBe(200);
    const { pullRequest } = res.json();
    expect(pullRequest).toEqual({
      mode: 'opened',
      provider: 'github',
      url: 'https://github.com/acme/widgets/pull/42',
      number: 42,
      workingBranch: 'studio/local/work',
      collabBranch: 'main',
    });

    // The route passed the branch pair + repo coords + token to the host client.
    expect(hostClient.calls).toHaveLength(1);
    const call = hostClient.calls[0]!;
    expect(call.repo).toEqual({ host: 'github.com', owner: 'acme', repo: 'widgets' });
    expect(call.base).toBe('main');
    expect(call.head).toBe('studio/local/work');
    expect(call.token).toBe('ghp_token');
    expect(call.title).toContain('studio/local/work');
    expect(call.body).toContain('studio/local/work');
  });

  it('GitHub remote but NO token → guided-manual (compare URL), host API NOT called', async () => {
    const hostClient = new FakeHostClient({ kind: 'opened', number: 1, htmlUrl: 'x' });
    const app = await makeApp({ githubToken: null, hostClient });
    seedGitHub(app);

    const res = await openPr(app);
    const { pullRequest } = res.json();
    expect(pullRequest.mode).toBe('guided_manual');
    expect(pullRequest.provider).toBe('github');
    expect(pullRequest.url).toBe(
      'https://github.com/acme/widgets/compare/main...studio/local/work?expand=1',
    );
    expect(pullRequest.number).toBeNull();
    expect(hostClient.calls).toHaveLength(0);
  });

  it('a whitespace-only token counts as absent → guided-manual (never an empty-Bearer attempt)', async () => {
    const hostClient = new FakeHostClient({ kind: 'opened', number: 1, htmlUrl: 'x' });
    const app = await makeApp({ githubToken: '   ', hostClient });
    seedGitHub(app);

    const res = await openPr(app);
    expect(res.json().pullRequest.mode).toBe('guided_manual');
    expect(hostClient.calls).toHaveLength(0);
  });

  it('a non-GitHub (local) remote + token → guided-manual unknown, host API NOT called', async () => {
    const hostClient = new FakeHostClient({ kind: 'opened', number: 1, htmlUrl: 'x' });
    const app = await makeApp({ githubToken: 'ghp_token', hostClient });
    seedLocal(app);

    const res = await openPr(app);
    const { pullRequest } = res.json();
    expect(pullRequest.mode).toBe('guided_manual');
    expect(pullRequest.provider).toBe('unknown');
    expect(pullRequest.url).toBeNull();
    expect(pullRequest.number).toBeNull();
    expect(hostClient.calls).toHaveLength(0);
  });

  it('a host-API failure (GitHostApiError) → 502 git_error', async () => {
    const hostClient = new FakeHostClient({
      kind: 'throw',
      error: new GitHostApiError('GitHub pull-request create failed (HTTP 500)'),
    });
    const app = await makeApp({ githubToken: 'ghp_token', hostClient });
    seedGitHub(app);

    const res = await openPr(app);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('git_error');
  });

  it('a validation refusal (GitHostRequestError, e.g. no commits) → 409 conflict', async () => {
    const hostClient = new FakeHostClient({
      kind: 'throw',
      error: new GitHostRequestError(
        'GitHub refused the pull request: No commits between main and studio/local/work',
      ),
    });
    const app = await makeApp({ githubToken: 'ghp_token', hostClient });
    seedGitHub(app);

    const res = await openPr(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
  });

  it('404s when no repo is connected (token present)', async () => {
    const app = await makeApp({ githubToken: 'ghp_token' });
    const res = await openPr(app);
    expect(res.statusCode).toBe(404);
  });
});
