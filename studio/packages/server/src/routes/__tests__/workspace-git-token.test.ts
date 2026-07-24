import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceGit, getWorkspaceGitToken } from '../../repo/index.js';
import type { GitHostClient, OpenPullRequestParams } from '../../git/github-host.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G10 — the STORED per-workspace git token: set/clear routes, the
 * `hasStoredToken` status signal, the no-leak invariant (the ciphertext never
 * appears in any response), and the precedence the shared `resolveEffectiveToken`
 * enforces (a stored token WINS over the operator-env token). Precedence is
 * proven end-to-end through the PR-open path's `GitHostClient` seam, which
 * records the token the route resolved — the same token that feeds git transport
 * (they share one resolver). Rows are seeded directly (a github.com URL is not
 * clonable in a test; the token routes never touch the checkout).
 */

/** A fake host client that records the token the pull-request route resolved. */
class FakeHostClient implements GitHostClient {
  calls: OpenPullRequestParams[] = [];
  async openPullRequest(
    params: OpenPullRequestParams,
  ): Promise<{ number: number; htmlUrl: string }> {
    this.calls.push(params);
    return { number: 7, htmlUrl: 'https://github.com/acme/widgets/pull/7' };
  }
}

describe('workspace-git token routes (#3 G10)', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.app.close();
    testApp = undefined;
  });

  async function makeApp(overrides?: {
    githubToken?: string | null;
    hostClient?: GitHostClient;
  }): Promise<FastifyInstance> {
    testApp = await buildTestAppWithContext({
      githubToken: overrides?.githubToken,
      workspaceGitHostClient: overrides?.hostClient,
    });
    return testApp.app;
  }

  function seedGitHub(app: FastifyInstance): void {
    createWorkspaceGit(app.db, {
      ownerId: 'local',
      repoUrl: 'https://github.com/acme/widgets.git',
      collabBranch: 'main',
      workingBranch: 'studio/local/work',
      observedCollabHead: 'deadbeef',
      lastFetchAt: Date.now(),
      lastFetchError: null,
    });
  }

  const putToken = (app: FastifyInstance, token: unknown) =>
    app.inject({ method: 'PUT', url: '/api/workspace/git/token', payload: { token } });
  const deleteToken = (app: FastifyInstance) =>
    app.inject({ method: 'DELETE', url: '/api/workspace/git/token' });
  const getStatus = (app: FastifyInstance) =>
    app.inject({ method: 'GET', url: '/api/workspace/git' });
  const openPr = (app: FastifyInstance) =>
    app.inject({ method: 'POST', url: '/api/workspace/git/pull-request', payload: {} });

  it('a connected workspace starts with hasStoredToken:false', async () => {
    const app = await makeApp();
    seedGitHub(app);
    const res = await getStatus(app);
    expect(res.json().git.hasStoredToken).toBe(false);
  });

  it('PUT stores the token (hasStoredToken:true) and NEVER returns the plaintext', async () => {
    const app = await makeApp();
    seedGitHub(app);
    const res = await putToken(app, 'ghp_secretTOKEN123');
    expect(res.statusCode).toBe(200);
    expect(res.json().git.hasStoredToken).toBe(true);
    // The raw response body must not quote the token anywhere.
    expect(res.body).not.toContain('ghp_secretTOKEN123');
    // Nor may GET.
    const got = await getStatus(app);
    expect(got.json().git.hasStoredToken).toBe(true);
    expect(got.body).not.toContain('ghp_secretTOKEN123');
  });

  it('the stored value on disk is ENCRYPTED, not the plaintext', async () => {
    const app = await makeApp();
    seedGitHub(app);
    await putToken(app, 'ghp_secretTOKEN123');
    const stored = getWorkspaceGitToken(app.db, 'local');
    expect(stored).not.toBeNull();
    expect(stored).not.toBe('ghp_secretTOKEN123');
  });

  it('DELETE clears the token (hasStoredToken:false)', async () => {
    const app = await makeApp();
    seedGitHub(app);
    await putToken(app, 'ghp_secretTOKEN123');
    const res = await deleteToken(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().git.hasStoredToken).toBe(false);
    expect(getWorkspaceGitToken(app.db, 'local')).toBeNull();
  });

  it('PUT with no connection → 404', async () => {
    const app = await makeApp();
    const res = await putToken(app, 'ghp_secretTOKEN123');
    expect(res.statusCode).toBe(404);
  });

  it('DELETE with no connection → 404', async () => {
    const app = await makeApp();
    const res = await deleteToken(app);
    expect(res.statusCode).toBe(404);
  });

  it('PUT rejects an empty token (400) and a control-char token (400)', async () => {
    const app = await makeApp();
    seedGitHub(app);
    expect((await putToken(app, '')).statusCode).toBe(400);
    expect((await putToken(app, 'ghp_a\r\nX-Injected: 1')).statusCode).toBe(400);
    // An unknown key is refused by the strict body.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/git/token',
      payload: { token: 'ghp_ok', extra: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PRECEDENCE: a stored token WINS over the operator-env token', async () => {
    const hostClient = new FakeHostClient();
    const app = await makeApp({ githubToken: 'ghp_ENV', hostClient });
    seedGitHub(app);
    await putToken(app, 'ghp_STORED');

    const res = await openPr(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().pullRequest.mode).toBe('opened');
    expect(hostClient.calls).toHaveLength(1);
    expect(hostClient.calls[0]!.token).toBe('ghp_STORED');
  });

  it('PRECEDENCE: with no stored token, the operator-env token is used', async () => {
    const hostClient = new FakeHostClient();
    const app = await makeApp({ githubToken: 'ghp_ENV', hostClient });
    seedGitHub(app);

    const res = await openPr(app);
    expect(res.statusCode).toBe(200);
    expect(hostClient.calls[0]!.token).toBe('ghp_ENV');
  });

  it('PRECEDENCE: clearing a stored token reverts to the env token', async () => {
    const hostClient = new FakeHostClient();
    const app = await makeApp({ githubToken: 'ghp_ENV', hostClient });
    seedGitHub(app);
    await putToken(app, 'ghp_STORED');
    await deleteToken(app);

    await openPr(app);
    expect(hostClient.calls[0]!.token).toBe('ghp_ENV');
  });

  it('with NEITHER a stored nor an env token, PR-open falls back to guided-manual', async () => {
    const hostClient = new FakeHostClient();
    const app = await makeApp({ githubToken: null, hostClient });
    seedGitHub(app);

    const res = await openPr(app);
    expect(res.json().pullRequest.mode).toBe('guided_manual');
    expect(hostClient.calls).toHaveLength(0);
  });
});
