import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MASTER_KEY_ENV_VARS } from '../../secrets/secrets.js';
import {
  applyHttpAuthEnv,
  buildGitEnv,
  CliGitProvider,
  githubTokenTransportAuth,
  GitOperationError,
  GitPushRejectedError,
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

describe('CliGitProvider — G10 non-fast-forward push conflict', () => {
  /** Clone a fresh seeded remote and lay a local commit on a `feature` branch
   * (off `origin/main`), returning the pieces the push tests share. */
  async function localFeatureCommit() {
    const { dir, remote, work } = seededRemote();
    const checkout = join(dir, 'checkout');
    const provider = new CliGitProvider();
    await provider.clone(remote, checkout);
    await provider.checkoutWorkingBranch(checkout, 'feature', 'origin/main');
    writeFileSync(join(checkout, 'ours.txt'), 'ours\n');
    await provider.add(checkout, ['ours.txt']);
    await provider.commit(checkout, 'ours', { name: 'local', email: 'local@studio.local' });
    return { provider, dir, remote, work, checkout };
  }

  it('push() rejects a non-fast-forward as GitPushRejectedError (a divergence, not a 502 op failure)', async () => {
    const { provider, work, checkout } = await localFeatureCommit();

    // Another clone advances the SAME branch on the remote with an unrelated
    // commit, so our commit can only land as a non-fast-forward.
    fixtureGit(work, ['checkout', '-b', 'feature']);
    pushNewCommit(work, 'theirs.txt', 'feature');

    const err = await provider.push(checkout, 'feature').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitPushRejectedError);
    // A SIBLING of GitOperationError, so the error handler maps it to a 409
    // conflict and NEVER falls into the 502 git_error branch.
    expect(err).not.toBeInstanceOf(GitOperationError);
    // Fixed, client-safe message: actionable, never the raw stderr or the
    // server-internal checkout path.
    const message = (err as Error).message;
    expect(message).toMatch(/re-commit/i);
    expect(message).not.toContain(checkout);
  });

  it('push() succeeds when the branch fast-forwards (creates the remote branch)', async () => {
    const { provider, checkout } = await localFeatureCommit();
    // `feature` does not exist on the remote yet → a create, i.e. a fast-forward.
    await expect(provider.push(checkout, 'feature')).resolves.toBeUndefined();
  });

  it('a push failure that is NOT a rejection stays a GitOperationError (the classifier does not over-match)', async () => {
    const { provider, remote, checkout } = await localFeatureCommit();
    // Remove the remote so the push fails for a TRANSPORT reason (not a
    // divergence): the classifier must leave this as the 502 op-failure class.
    rmSync(remote, { recursive: true, force: true });
    const err = await provider.push(checkout, 'feature').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitOperationError);
    expect(err).not.toBeInstanceOf(GitPushRejectedError);
  });
});

describe('CliGitProvider — G10 isAncestor (descendant guard history walk)', () => {
  /** A checkout of a seeded remote plus the pieces the ancestry tests share. */
  async function clonedCheckout() {
    const { dir, remote, work, headSha } = seededRemote();
    const checkout = join(dir, 'checkout');
    const provider = new CliGitProvider();
    await provider.clone(remote, checkout);
    return { provider, dir, remote, work, checkout, firstSha: headSha };
  }

  it('true: the earlier commit is an ancestor of a later one (a fast-forward)', async () => {
    const { provider, work, checkout, firstSha } = await clonedCheckout();
    const secondSha = pushNewCommit(work, 'second.txt', 'main');
    await provider.fetch(checkout);
    expect(await provider.isAncestor(checkout, firstSha, secondSha)).toBe(true);
  });

  it('true: a commit is its own ancestor (reflexive — the `current` boundary)', async () => {
    const { provider, checkout, firstSha } = await clonedCheckout();
    expect(await provider.isAncestor(checkout, firstSha, firstSha)).toBe(true);
  });

  it('false: the later commit is NOT an ancestor of the earlier one (order matters)', async () => {
    const { provider, work, checkout, firstSha } = await clonedCheckout();
    const secondSha = pushNewCommit(work, 'second.txt', 'main');
    await provider.fetch(checkout);
    expect(await provider.isAncestor(checkout, secondSha, firstSha)).toBe(false);
  });

  it('false: unrelated histories (a force-push rewrite → `diverged`)', async () => {
    const { provider, remote, work, checkout, firstSha } = await clonedCheckout();
    // Rewrite `main` on the remote to an unrelated root history, then fetch it —
    // the new head shares no ancestry with our import base.
    const orphan = join(work, '..', 'orphan');
    execFileSync('git', ['init', '-b', 'main', orphan], { encoding: 'utf8' });
    writeFileSync(join(orphan, 'other.txt'), 'other\n');
    fixtureGit(orphan, ['add', '.']);
    fixtureGit(orphan, ['commit', '-m', 'orphan root']);
    fixtureGit(orphan, ['remote', 'add', 'origin', remote]);
    fixtureGit(orphan, ['push', '--force', 'origin', 'main']);
    await provider.fetch(checkout);
    const rewrittenSha = fixtureGit(orphan, ['rev-parse', 'HEAD']).trim();
    expect(await provider.isAncestor(checkout, firstSha, rewrittenSha)).toBe(false);
  });

  it('throws a GitOperationError on a missing commit (never a manufactured false)', async () => {
    const { provider, checkout, firstSha } = await clonedCheckout();
    const err = await provider
      .isAncestor(checkout, 'f'.repeat(40), firstSha)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitOperationError);
    // Client-safe: never quotes the server-internal checkout path.
    expect((err as Error).message).not.toContain(checkout);
  });
});

describe('CliGitProvider — G4 read primitives', () => {
  /** A checkout with managed files committed on `main`; returns the head sha. */
  function withCommittedFiles() {
    const { remote, work } = seedRemote(tmp());
    mkdirSync(join(work, 'pipelines'));
    mkdirSync(join(work, 'connections'));
    writeFileSync(join(work, 'pipelines/a.json'), '{"a":1}');
    writeFileSync(join(work, 'connections/b.json'), '{"b":2}');
    writeFileSync(join(work, 'pipelines/keep.gitkeep'), ''); // a non-json file in a managed dir
    writeFileSync(join(work, 'README.md'), 'root file'); // outside any managed dir
    fixtureGit(work, ['add', '.']);
    fixtureGit(work, ['commit', '-m', 'seed managed files']);
    fixtureGit(work, ['push', 'origin', 'main']);
    const headSha = fixtureGit(work, ['rev-parse', 'HEAD']).trim();

    const checkout = join(tmp(), 'checkout');
    execFileSync('git', ['clone', '--quiet', '--origin', 'origin', remote, checkout], {
      encoding: 'utf8',
    });
    return { checkout, headSha };
  }

  it('lsTreeManaged lists only blobs under the given dirs at a ref (README excluded)', async () => {
    const provider = new CliGitProvider();
    const { checkout, headSha } = withCommittedFiles();

    const entries = await provider.lsTreeManaged(checkout, headSha, ['pipelines', 'connections']);
    expect(entries.map((e) => e.path).sort()).toEqual(
      ['connections/b.json', 'pipelines/a.json', 'pipelines/keep.gitkeep'].sort(),
    );
    // The root README is never under a managed dir.
    expect(entries.map((e) => e.path)).not.toContain('README.md');
  });

  it('#3 G6b — lsTreeManaged surfaces each entry git blob sha (matches rev-parse)', async () => {
    const provider = new CliGitProvider();
    const { checkout, headSha } = withCommittedFiles();

    const entries = await provider.lsTreeManaged(checkout, headSha, ['pipelines']);
    const byPath = new Map(entries.map((e) => [e.path, e.blobSha]));
    // The sha is git's real blob object id for the file at this ref — the exact
    // value the import stamps as a version's `source_blob_sha`.
    const expected = execFileSync(
      'git',
      ['-C', checkout, 'rev-parse', `${headSha}:pipelines/a.json`],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(byPath.get('pipelines/a.json')).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('lsTreeManaged returns no entries for a dir absent from the tree (not an error)', async () => {
    const provider = new CliGitProvider();
    const { checkout, headSha } = withCommittedFiles();
    await expect(provider.lsTreeManaged(checkout, headSha, ['triggers'])).resolves.toEqual([]);
  });

  it('showBlob returns the blob content verbatim (byte-identical)', async () => {
    const provider = new CliGitProvider();
    const { checkout, headSha } = withCommittedFiles();
    await expect(provider.showBlob(checkout, headSha, 'pipelines/a.json')).resolves.toBe('{"a":1}');
  });
});

describe('applyHttpAuthEnv', () => {
  const auth = { urlPrefix: 'https://github.com/', header: 'AUTHORIZATION: basic B64VALUE' };

  it('injects a url-matched extraHeader as a fresh GIT_CONFIG_* entry (index 0)', () => {
    const env = applyHttpAuthEnv({ PATH: '/usr/bin' }, auth);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe('AUTHORIZATION: basic B64VALUE');
    // The token is carried in the ENV, never on the process command line.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('APPENDS to a pre-existing GIT_CONFIG_COUNT rather than clobbering the operator’s own config', () => {
    const env = applyHttpAuthEnv(
      { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_KEY_1: 'c.d' },
      auth,
    );
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    // The operator's existing entries are untouched…
    expect(env.GIT_CONFIG_KEY_0).toBe('a.b');
    expect(env.GIT_CONFIG_KEY_1).toBe('c.d');
    // …and ours lands at the next free index.
    expect(env.GIT_CONFIG_KEY_2).toBe('http.https://github.com/.extraHeader');
    expect(env.GIT_CONFIG_VALUE_2).toBe('AUTHORIZATION: basic B64VALUE');
  });

  it('falls back to index 0 on a malformed pre-existing count (never a NaN key)', () => {
    const env = applyHttpAuthEnv({ GIT_CONFIG_COUNT: 'garbage' }, auth);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
  });
});

describe('githubTokenTransportAuth', () => {
  it('builds an x-access-token Basic header scoped to github.com, with token+base64 both in the redaction set', () => {
    const token = 'ghp_secretTOKEN';
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    const { httpAuth, secrets } = githubTokenTransportAuth(token);
    expect(httpAuth.urlPrefix).toBe('https://github.com/');
    expect(httpAuth.header).toBe(`AUTHORIZATION: basic ${b64}`);
    // Both the raw token AND its base64 credential are scrubbed (belt-and-braces:
    // the raw token can never resurface either).
    expect(secrets).toContain(token);
    expect(secrets).toContain(b64);
  });

  it('throws on an empty token (the exported seam never manufactures a bogus header)', () => {
    expect(() => githubTokenTransportAuth('')).toThrow(/non-empty token/);
  });

  it('the injected env actually resolves the extraHeader for a github.com URL — and NOT for another host', () => {
    // The POSITIVE direction of the scoping claim (the negative — inert on a
    // non-github remote — is covered by the real clone/fetch/push test below):
    // prove real git resolves our exact `http.<url>.extraHeader` key for a
    // github.com URL under the injected env, locking the key format against a
    // git-version behaviour change. `--get-urlmatch` reads the GIT_CONFIG_* env
    // even outside a repo.
    const { httpAuth } = githubTokenTransportAuth('ghp_x');
    const env = { ...process.env, ...applyHttpAuthEnv({}, httpAuth) };
    const matched = execFileSync(
      'git',
      ['config', '--get-urlmatch', 'http.extraHeader', 'https://github.com/o/r'],
      { env, encoding: 'utf8' },
    ).trim();
    expect(matched).toBe(httpAuth.header);
    // A non-github URL matches nothing → git exits 1 (no output).
    let nonMatchStatus: number | undefined;
    try {
      execFileSync(
        'git',
        ['config', '--get-urlmatch', 'http.extraHeader', 'https://gitlab.com/o/r'],
        { env, encoding: 'utf8' },
      );
    } catch (e) {
      nonMatchStatus = (e as { status?: number }).status;
    }
    expect(nonMatchStatus).toBe(1);
  });
});

describe('CliGitProvider — G10 operator-env token transport auth', () => {
  /**
   * A fake git that appends its argv + the GIT_CONFIG_* env it received to a log,
   * then exits 0. Lets a test prove the token is injected via ENV (never argv, so
   * never on the process command line) and only on the ops it should be.
   */
  function recordingShim(dir: string): { bin: string; log: string } {
    const log = join(dir, 'invocations.log');
    const bin = join(dir, 'recording-git.sh');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `LOG="${log}"`,
        '{',
        '  echo "ARGV: $*"',
        '  echo "COUNT=${GIT_CONFIG_COUNT-}"',
        '  echo "KEY0=${GIT_CONFIG_KEY_0-}"',
        '  echo "VALUE0=${GIT_CONFIG_VALUE_0-}"',
        '} >> "$LOG"',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  function readLog(log: string): string {
    return existsSync(log) ? execFileSync('cat', [log], { encoding: 'utf8' }) : '';
  }

  it('a network op (fetch) injects the auth via GIT_CONFIG_* env — NEVER on the argv', async () => {
    const dir = tmp();
    const { bin, log } = recordingShim(dir);
    const { httpAuth, secrets } = githubTokenTransportAuth('ghp_x');
    const b64 = httpAuth.header.replace('AUTHORIZATION: basic ', '');
    const provider = new CliGitProvider({ gitBinary: bin, httpAuth, secretsToRedact: secrets });
    await provider.fetch('/tmp/anything');
    const out = readLog(log);
    expect(out).toContain('COUNT=1');
    expect(out).toContain('KEY0=http.https://github.com/.extraHeader');
    expect(out).toContain(`VALUE0=AUTHORIZATION: basic ${b64}`);
    // The credential is in the env line, and the argv line must NOT carry it.
    const argvLine = out.split('\n').find((l) => l.startsWith('ARGV:')) ?? '';
    expect(argvLine).not.toContain(b64);
    expect(argvLine).not.toContain('extraHeader');
  });

  it('a local op (revParseRemoteBranch) carries NO auth config env', async () => {
    const dir = tmp();
    const { bin, log } = recordingShim(dir);
    const { httpAuth, secrets } = githubTokenTransportAuth('ghp_x');
    const provider = new CliGitProvider({ gitBinary: bin, httpAuth, secretsToRedact: secrets });
    // The shim exits 0 with empty stdout → revParse returns '' (a resolved head).
    await provider.revParseRemoteBranch('/tmp/anything', 'main');
    const out = readLog(log);
    expect(out).toContain('COUNT=');
    expect(out).not.toContain('COUNT=1');
    expect(out).not.toContain('extraHeader');
  });

  it('no httpAuth → no auth config env even on a network op', async () => {
    const dir = tmp();
    const { bin, log } = recordingShim(dir);
    const provider = new CliGitProvider({ gitBinary: bin });
    await provider.fetch('/tmp/anything');
    const out = readLog(log);
    expect(out).not.toContain('COUNT=1');
    expect(out).not.toContain('extraHeader');
  });

  it('with httpAuth set, real clone/fetch/push to a NON-github remote still SUCCEED (url-match keeps the header inert)', async () => {
    const { dir, remote, work } = seededRemote();
    const checkout = join(dir, 'checkout');
    const { httpAuth, secrets } = githubTokenTransportAuth('ghp_x');
    const provider = new CliGitProvider({ httpAuth, secretsToRedact: secrets });

    // clone (network) — a path remote never matches https://github.com/, so the
    // header is never sent and the op is unaffected.
    await provider.clone(remote, checkout);
    // fetch (network)
    pushNewCommit(work, 'second.md');
    await provider.fetch(checkout);
    // push (network) — a fast-forward create on a new branch.
    await provider.checkoutWorkingBranch(checkout, 'feature', 'origin/main');
    writeFileSync(join(checkout, 'ours.txt'), 'ours\n');
    await provider.add(checkout, ['ours.txt']);
    await provider.commit(checkout, 'ours', { name: 'local', email: 'local@studio.local' });
    await expect(provider.push(checkout, 'feature')).resolves.toBeUndefined();
  });

  it('the base64 credential is redacted out of a leaked error', async () => {
    const dir = tmp();
    const { httpAuth, secrets } = githubTokenTransportAuth('ghp_x');
    const b64 = httpAuth.header.replace('AUTHORIZATION: basic ', '');
    const shim = join(dir, 'leaky-git.sh');
    writeFileSync(shim, `#!/bin/sh\necho "fatal: bad credential ${b64}" >&2\nexit 128\n`);
    chmodSync(shim, 0o755);
    const provider = new CliGitProvider({ gitBinary: shim, httpAuth, secretsToRedact: secrets });
    const err = await provider.fetch('/tmp/anything').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitOperationError);
    expect((err as Error).message).not.toContain(b64);
    expect((err as Error).message).toContain('***');
  });
});
