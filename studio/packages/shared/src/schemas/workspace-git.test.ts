import { describe, expect, it } from 'vitest';
import {
  ConnectWorkspaceGitBodySchema,
  deriveWorkspaceGitState,
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
});
