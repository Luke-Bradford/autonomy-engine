import { describe, expect, it } from 'vitest';
import {
  buildGuidedManualPullRequest,
  ConnectWorkspaceGitBodySchema,
  deriveDefaultWorkingBranch,
  deriveWorkspaceGitState,
  parseGitHostRepo,
  PullRequestResultSchema,
  SetWorkingBranchBodySchema,
  WorkspaceGitBranchSchema,
  WorkspaceGitRepoUrlSchema,
  WorkspaceGitSchema,
  WorkspaceGitStatusSchema,
} from './workspace-git.js';

describe('WorkspaceGitRepoUrlSchema', () => {
  // The five sanctioned forms (#3 G2 — scheme allowlist, never a free string
  // handed to `git clone`).
  it.each([
    'https://github.com/acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
    'git@github.com:acme/widgets.git',
    'file:///Users/dev/repos/widgets',
    '/Users/dev/repos/widgets',
  ])('accepts %s', (url) => {
    expect(WorkspaceGitRepoUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    // Embedded credential — would land in the DB row + every error message.
    'https://user:s3cr3t@github.com/acme/widgets.git',
    'ssh://user:s3cr3t@github.com/acme/widgets.git',
    // git's remote-ext transport executes an arbitrary command.
    'ext::sh -c whoami',
    // Option injection into the git argv (also not an allowlisted form).
    '--upload-pack=evil',
    // Relative path — ambiguous against the server cwd; require absolute.
    'repos/widgets',
    // Non-TLS http is not sanctioned (use https, ssh, file, or a path).
    'http://github.com/acme/widgets.git',
    // Option-shaped host/user — git blocks "strange hostnames" itself, but
    // the boundary defence is self-contained.
    'ssh://-oProxyCommand=evil/x',
    'git@-oBatchMode:path',
    '-o@localhost:path',
    '',
  ])('refuses %s', (url) => {
    expect(WorkspaceGitRepoUrlSchema.safeParse(url).success).toBe(false);
  });

  it('accepts a passwordless userinfo (a username alone is not a secret)', () => {
    expect(
      WorkspaceGitRepoUrlSchema.safeParse('https://token-user@github.com/a/b.git').success,
    ).toBe(true);
  });
});

describe('WorkspaceGitBranchSchema', () => {
  it.each(['main', 'develop', 'feature/g2-workspace-git', 'release-1.2'])(
    'accepts %s',
    (branch) => {
      expect(WorkspaceGitBranchSchema.safeParse(branch).success).toBe(true);
    },
  );

  // check-ref-format-shaped refusals: `refs/remotes/origin/<branch>` is built
  // by string interpolation in the provider, so a hostile/typo'd branch must
  // never escape the ref namespace or produce garbage git errors.
  it.each([
    'a..b',
    'a@{b',
    'has space',
    'star*',
    'quest?on',
    'brack[et',
    'back\\slash',
    'colon:name',
    'tilde~1',
    'caret^2',
    '/leading-slash',
    'trailing-slash/',
    'double//slash',
    '.leading-dot',
    'trailing-dot.',
    'ends.lock',
    '@',
    'ctrlchar',
    '',
  ])('refuses %j', (branch) => {
    expect(WorkspaceGitBranchSchema.safeParse(branch).success).toBe(false);
  });
});

describe('ConnectWorkspaceGitBodySchema', () => {
  it('defaults collabBranch to main', () => {
    const parsed = ConnectWorkspaceGitBodySchema.parse({ repoUrl: '/repos/widgets' });
    expect(parsed.collabBranch).toBe('main');
  });

  it('is strict (unknown keys are a 400 at the boundary)', () => {
    expect(
      ConnectWorkspaceGitBodySchema.safeParse({ repoUrl: '/repos/widgets', ownerId: 'evil' })
        .success,
    ).toBe(false);
  });
});

const row = {
  id: 'wsgit_abc',
  ownerId: 'local',
  repoUrl: '/repos/widgets',
  collabBranch: 'main',
  workingBranch: 'studio/local/work',
  observedCollabHead: 'a'.repeat(40),
  lastFetchAt: 1_700_000_000_000,
  lastFetchError: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe('WorkspaceGitSchema', () => {
  it('parses a full row', () => {
    expect(WorkspaceGitSchema.parse(row)).toEqual(row);
  });

  it('requires the nullable tracking fields to be present (no manufactured defaults — #473)', () => {
    const missing: Partial<typeof row> = { ...row };
    delete missing.observedCollabHead;
    expect(WorkspaceGitSchema.safeParse(missing).success).toBe(false);
  });
});

describe('deriveWorkspaceGitState', () => {
  it('error wins over a stale prior head (fetch failed AFTER an earlier success)', () => {
    expect(
      deriveWorkspaceGitState({ lastFetchError: 'fetch failed', observedCollabHead: 'abc' }),
    ).toBe('fetch_error');
  });

  it('missing head (no error) is collab_branch_missing', () => {
    expect(deriveWorkspaceGitState({ lastFetchError: null, observedCollabHead: null })).toBe(
      'collab_branch_missing',
    );
  });

  it('head present, no error, is ready', () => {
    expect(deriveWorkspaceGitState({ lastFetchError: null, observedCollabHead: 'abc' })).toBe(
      'ready',
    );
  });
});

describe('WorkspaceGitStatusSchema', () => {
  it('is the row plus the derived state', () => {
    const status = WorkspaceGitStatusSchema.parse({ ...row, state: 'ready' });
    expect(status.state).toBe('ready');
  });

  it('carries the persisted working branch', () => {
    const status = WorkspaceGitStatusSchema.parse({ ...row, state: 'ready' });
    expect(status.workingBranch).toBe('studio/local/work');
  });
});

describe('deriveDefaultWorkingBranch', () => {
  it('is the studio-owned convention for the owner', () => {
    expect(deriveDefaultWorkingBranch('local')).toBe('studio/local/work');
  });

  it('a null owner renders "null" — matching the SQL COALESCE backfill', () => {
    // JS `${null}` -> "null"; the 0031 migration COALESCEs owner_id to 'null'.
    expect(deriveDefaultWorkingBranch(null)).toBe('studio/null/work');
  });

  it('the default passes the branch policy validator', () => {
    expect(WorkspaceGitBranchSchema.safeParse(deriveDefaultWorkingBranch('local')).success).toBe(
      true,
    );
  });
});

describe('SetWorkingBranchBodySchema', () => {
  it('accepts a valid feature branch', () => {
    expect(
      SetWorkingBranchBodySchema.parse({ workingBranch: 'studio/luke/feature-x' }).workingBranch,
    ).toBe('studio/luke/feature-x');
  });

  it('enforces the check-ref-format policy at the boundary', () => {
    expect(SetWorkingBranchBodySchema.safeParse({ workingBranch: 'has space' }).success).toBe(
      false,
    );
  });

  it('is strict (unknown keys are a 400)', () => {
    expect(SetWorkingBranchBodySchema.safeParse({ workingBranch: 'ok', extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('parseGitHostRepo', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['https://github.com/acme/widgets', 'github.com', 'acme', 'widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['ssh://git@github.com:22/acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['git@github.com:acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['git@github.com:acme/widgets', 'github.com', 'acme', 'widgets'],
    // A deeper (GitLab-style) group path degrades to its final group/repo pair.
    ['https://gitlab.com/group/sub/widgets.git', 'gitlab.com', 'sub', 'widgets'],
  ])('parses %s', (url, host, owner, repo) => {
    expect(parseGitHostRepo(url)).toEqual({ host, owner, repo });
  });

  it.each([
    // Local remotes have no web host.
    'file:///Users/dev/repos/widgets',
    '/Users/dev/repos/widgets',
    // No owner/repo tail.
    'https://github.com/widgets',
    'https://github.com/',
  ])('returns null for %s', (url) => {
    expect(parseGitHostRepo(url)).toBeNull();
  });
});

describe('buildGuidedManualPullRequest', () => {
  it('builds a GitHub compare URL (base...head = collab...working) with expand=1', () => {
    const result = buildGuidedManualPullRequest(
      'https://github.com/acme/widgets.git',
      'main',
      'studio/local/work',
    );
    expect(result.provider).toBe('github');
    // The working branch slashes stay literal in the URL path.
    expect(result.url).toBe(
      'https://github.com/acme/widgets/compare/main...studio/local/work?expand=1',
    );
  });

  it('recognises the scp-like GitHub form', () => {
    expect(
      buildGuidedManualPullRequest('git@github.com:acme/widgets.git', 'main', 'studio/local/work')
        .provider,
    ).toBe('github');
  });

  it('percent-encodes a URL-significant char in owner/repo (repoUrl path charset is unrestricted)', () => {
    // WorkspaceGitRepoUrlSchema checks only scheme/credential shape, not the
    // path charset, so a `#` in owner/repo must not produce a malformed link.
    const result = buildGuidedManualPullRequest(
      'https://github.com/ac#me/wid#gets.git',
      'main',
      'studio/local/work',
    );
    expect(result.url).toBe(
      'https://github.com/ac%23me/wid%23gets/compare/main...studio/local/work?expand=1',
    );
  });

  it('percent-encodes a URL-significant char in a branch while preserving "/"', () => {
    const result = buildGuidedManualPullRequest(
      'https://github.com/acme/widgets.git',
      'main',
      'studio/luke/fix#42',
    );
    expect(result.url).toBe(
      'https://github.com/acme/widgets/compare/main...studio/luke/fix%2342?expand=1',
    );
  });

  it('a local remote has no host → provider:unknown, url:null (guided by branch pair)', () => {
    const result = buildGuidedManualPullRequest('/repos/widgets', 'main', 'studio/local/work');
    expect(result).toEqual({ provider: 'unknown', url: null });
  });

  it('a non-GitHub host → provider:unknown, url:null (GitHub-first; other hosts later)', () => {
    const result = buildGuidedManualPullRequest(
      'https://gitlab.com/group/widgets.git',
      'main',
      'studio/local/work',
    );
    expect(result).toEqual({ provider: 'unknown', url: null });
  });

  it('the guided-manual result parses through PullRequestResultSchema', () => {
    const built = buildGuidedManualPullRequest(
      'https://github.com/acme/widgets.git',
      'main',
      'studio/local/work',
    );
    const parsed = PullRequestResultSchema.parse({
      mode: 'guided_manual',
      ...built,
      workingBranch: 'studio/local/work',
      collabBranch: 'main',
    });
    expect(parsed.mode).toBe('guided_manual');
    expect(parsed.provider).toBe('github');
  });
});
