import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MASTER_KEY_ENV_VARS } from '../../secrets/secrets.js';
import {
  buildGitEnv,
  CliGitProvider,
  GitOperationError,
  GitUnavailableError,
} from '../provider.js';
import { fixtureGit, pushNewCommit, seedRemote } from './fixtures.js';

/**
 * #3 G2 — GitProvider tests against REAL git repos (fixtures in
 * `fixtures.ts`, shared with the route tests). The only fake binaries are
 * the two shim scripts for the timeout/redaction paths, injected via the
 * `gitBinary` option.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'studio-git-provider-test-'));
}

/** A bare remote with one commit on `main`, plus the work clone that seeded it. */
function seededRemote() {
  const dir = tmp();
  return { dir, ...seedRemote(dir) };
}

describe('buildGitEnv', () => {
  it('strips the master-key env vars and ambient git redirections; pins the anti-hang vars', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      AUTONOMY_MASTER_KEY: 'sekret',
      AUTONOMY_MASTER_KEY_FILE: '/keys/master.key',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index',
    };
    const env = buildGitEnv(base);
    for (const name of MASTER_KEY_ENV_VARS) expect(env[name]).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('echo');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -oBatchMode=yes');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('respects an operator-set GIT_SSH_COMMAND', () => {
    const env = buildGitEnv({ GIT_SSH_COMMAND: 'ssh -i /custom/key' });
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /custom/key');
  });
});

describe('CliGitProvider', () => {
  it('version() reports a git version', async () => {
    const provider = new CliGitProvider();
    await expect(provider.version()).resolves.toMatch(/git version/);
  });

  it('clone + revParseRemoteBranch observe the remote head', async () => {
    const { dir, remote, headSha } = seededRemote();
    const checkout = join(dir, 'checkout');
    const provider = new CliGitProvider();
    await provider.clone(remote, checkout);
    expect(existsSync(join(checkout, '.git'))).toBe(true);
    await expect(provider.revParseRemoteBranch(checkout, 'main')).resolves.toBe(headSha);
  });

  it('revParseRemoteBranch returns null (not an error) for a branch the remote does not have', async () => {
    const { dir, remote } = seededRemote();
    const checkout = join(dir, 'checkout');
    const provider = new CliGitProvider();
    await provider.clone(remote, checkout);
    await expect(provider.revParseRemoteBranch(checkout, 'no-such-branch')).resolves.toBeNull();
  });

  it('fetch() observes a new remote commit', async () => {
    const { dir, remote, work } = seededRemote();
    const checkout = join(dir, 'checkout');
    const provider = new CliGitProvider();
    await provider.clone(remote, checkout);
    const newSha = pushNewCommit(work, 'second.md');
    await provider.fetch(checkout);
    await expect(provider.revParseRemoteBranch(checkout, 'main')).resolves.toBe(newSha);
  });

  it('fetch() PRUNES a remotely-deleted branch (stale head must not survive)', async () => {
    const { dir, remote, work } = seededRemote();
    const checkout = join(dir, 'checkout');
    const provider = new CliGitProvider();
    await provider.clone(remote, checkout);
    await expect(provider.revParseRemoteBranch(checkout, 'main')).resolves.not.toBeNull();
    fixtureGit(work, ['push', 'origin', '--delete', 'main']);
    await provider.fetch(checkout);
    // Without --prune the stale refs/remotes/origin/main would still resolve
    // here and the workspace would report a head for a branch that no longer
    // exists (verified empirically in the plan review).
    await expect(provider.revParseRemoteBranch(checkout, 'main')).resolves.toBeNull();
  });

  it('clone of an EMPTY remote succeeds; the collab head is simply unobserved', async () => {
    const dir = tmp();
    const remote = join(dir, 'empty.git');
    execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    const checkout = join(dir, 'checkout');
    const provider = new CliGitProvider();
    await provider.clone(remote, checkout);
    await expect(provider.revParseRemoteBranch(checkout, 'main')).resolves.toBeNull();
  });

  it('clone from a nonexistent remote is a GitOperationError', async () => {
    const dir = tmp();
    const provider = new CliGitProvider();
    await expect(
      provider.clone(join(dir, 'no-such-remote'), join(dir, 'checkout')),
    ).rejects.toBeInstanceOf(GitOperationError);
  });

  it('an op failure naming the checkout dir has the path REDACTED from the error message', async () => {
    // git stderr readily quotes the destination path (`fatal: destination
    // path '<dir>' already exists…`) — a server-internal absolute path that
    // must not reach a 502 body. The provider redacts the op's dir the same
    // way it redacts secrets, keeping GitOperationError client-safe BY
    // CONSTRUCTION.
    const { dir, remote } = seededRemote();
    const dest = join(dir, 'dest');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'occupied.txt'), 'x');
    const provider = new CliGitProvider();
    const err = await provider.clone(remote, dest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitOperationError);
    expect((err as Error).message).not.toContain(dest);
    expect((err as Error).message).toContain('<checkout>');
  });

  it('a missing git binary is GitUnavailableError (distinct from an op failure)', async () => {
    const provider = new CliGitProvider({ gitBinary: '/no/such/git-binary' });
    await expect(provider.version()).rejects.toBeInstanceOf(GitUnavailableError);
  });

  it('a hung command is killed at the timeout', async () => {
    const dir = tmp();
    const shim = join(dir, 'slow-git.sh');
    writeFileSync(shim, '#!/bin/sh\nsleep 5\n');
    chmodSync(shim, 0o755);
    const provider = new CliGitProvider({ gitBinary: shim, localTimeoutMs: 150 });
    await expect(provider.version()).rejects.toThrow(/timed out/);
  });

  it('stderr is redacted through the secretsToRedact seam before landing in an error', async () => {
    const dir = tmp();
    const shim = join(dir, 'leaky-git.sh');
    writeFileSync(
      shim,
      '#!/bin/sh\necho "fatal: auth failed for token s3cr3t-value" >&2\nexit 1\n',
    );
    chmodSync(shim, 0o755);
    const provider = new CliGitProvider({ gitBinary: shim, secretsToRedact: ['s3cr3t-value'] });
    const err = await provider.version().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitOperationError);
    expect((err as Error).message).not.toContain('s3cr3t-value');
    expect((err as Error).message).toContain('***');
  });
});

describe('CliGitProvider — G3a commit primitives', () => {
  /** A managed checkout: OUR clone of a bare remote (the G2 model). */
  function checkoutOf() {
    const { dir, remote } = seededRemote();
    const checkout = join(dir, 'checkout');
    execFileSync('git', ['clone', '--quiet', '--origin', 'origin', remote, checkout], {
      encoding: 'utf8',
    });
    return { dir, remote, checkout };
  }

  it('checkoutWorkingBranch(baseRef) resets the branch and hasStagedChanges tracks the index', async () => {
    const provider = new CliGitProvider();
    const { checkout } = checkoutOf();

    await provider.checkoutWorkingBranch(checkout, 'studio/local/work', 'origin/main');
    // A clean tree off the base has nothing staged.
    expect(await provider.hasStagedChanges(checkout)).toBe(false);

    mkdirSync(join(checkout, 'pipelines'));
    writeFileSync(join(checkout, 'pipelines/a.json'), '{"x":1}');
    await provider.add(checkout, ['pipelines/a.json']);
    expect(await provider.hasStagedChanges(checkout)).toBe(true);

    const sha = await provider.commit(checkout, 'add a', {
      name: 'local',
      email: 'local@studio.local',
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // The author identity is the one we passed, not the ambient gitconfig.
    const author = execFileSync('git', ['-C', checkout, 'log', '-1', '--format=%an <%ae>'], {
      encoding: 'utf8',
    }).trim();
    expect(author).toBe('local <local@studio.local>');
    expect(await provider.hasStagedChanges(checkout)).toBe(false);
  });

  it('checkoutWorkingBranch(null) starts an orphan branch with an empty index', async () => {
    const provider = new CliGitProvider();
    const { checkout } = checkoutOf();

    await provider.checkoutWorkingBranch(checkout, 'studio/local/work', null);
    // Orphan cleared the index: the base commit's README is no longer staged.
    expect(await provider.hasStagedChanges(checkout)).toBe(false);
    const tracked = execFileSync('git', ['-C', checkout, 'ls-files'], { encoding: 'utf8' }).trim();
    expect(tracked).toBe('');
  });

  it('rmCached stages deletions and tolerates never-tracked pathspecs', async () => {
    const provider = new CliGitProvider();
    const { checkout } = checkoutOf();
    await provider.checkoutWorkingBranch(checkout, 'studio/local/work', 'origin/main');
    mkdirSync(join(checkout, 'pipelines'));
    writeFileSync(join(checkout, 'pipelines/a.json'), '{"x":1}');
    await provider.add(checkout, ['pipelines/a.json']);
    await provider.commit(checkout, 'add a', { name: 'local', email: 'local@studio.local' });

    // rmCached on all three managed dirs — only `pipelines` is tracked; the
    // other two match nothing and must not error (--ignore-unmatch).
    await provider.rmCached(checkout, ['pipelines', 'connections', 'triggers']);
    expect(await provider.hasStagedChanges(checkout)).toBe(true); // the deletion is staged
  });
});
