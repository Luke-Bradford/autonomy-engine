import { execFile } from 'node:child_process';
import { redactSecrets } from '../connectors/redact.js';
import { MASTER_KEY_ENV_VARS } from '../secrets/secrets.js';

/**
 * #3 G2 — the `GitProvider`: CLI git via `execFile` (spec: "CLI git first;
 * isomorphic-git only a future fallback if bundle demands"). Deliberately NOT
 * built on `workers/process-supervisor.ts` — that abstraction is a detached,
 * line-streaming, kill-tree supervisor for long-lived agent workers; git ops
 * are short foreground commands wanting collected output, which is exactly
 * `execFile` (arg ARRAYS, never a shell — user-controlled values can't
 * inject; `--` separates positionals where git accepts it).
 *
 * Ops are added per consumer (the no-inert-surface rule): G2 —
 * version/clone/fetch/rev-parse; G3a — checkout/rm-cached/add/diff-cached/
 * commit/push (the Commit path). `merge-base --is-ancestor` still waits for
 * its consumer, the descendant guard (a later G3 slice).
 *
 * AUTH MODEL (pinned, G2): the operator's own environment — SSH agent +
 * credential helper of the user running the server. Nothing interactive can
 * ever hang an op: `buildGitEnv` pins `GIT_TERMINAL_PROMPT=0` (no terminal
 * prompt), `GIT_ASKPASS=echo` (an askpass that returns empty — auth FAILS
 * fast instead of prompting), and `ssh -oBatchMode=yes` (unless the operator
 * set their own `GIT_SSH_COMMAND`). Stored PATs are G10's; when they land,
 * `secretsToRedact` is the seam their values flow through so no error/stderr
 * ever quotes one.
 */

/** Timeouts per op class: remote ops get minutes, local plumbing gets seconds. */
const DEFAULT_CLONE_TIMEOUT_MS = 120_000;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_PUSH_TIMEOUT_MS = 60_000;
const DEFAULT_LOCAL_TIMEOUT_MS = 10_000;
/** Collected-output cap — git porcelain output here is tiny; a megabyte means something is wrong. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Ambient git redirections that would point a child at a DIFFERENT repo than the `-C` dir. */
const GIT_REDIRECTION_ENV_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;

/**
 * The child env for every git invocation: the operator's environment (that IS
 * the G2 auth model — SSH agent socket, credential helper, HOME for
 * `.gitconfig`) minus the master-key vars (a child must never read the key
 * that decrypts all connection secrets) and minus ambient git redirections,
 * plus the anti-hang pins documented on the module.
 */
export function buildGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of MASTER_KEY_ENV_VARS) delete env[name];
  for (const name of GIT_REDIRECTION_ENV_VARS) delete env[name];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = 'echo';
  if (env.GIT_SSH_COMMAND === undefined) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  return env;
}

/**
 * The server host has no usable `git` binary (spawn ENOENT). Distinct from
 * `GitOperationError` — "install git" is a different remedy than "the fetch
 * failed" — and mapped to 503 `git_unavailable` (local precondition), not
 * 502 (upstream failure).
 */
export class GitUnavailableError extends Error {
  constructor(gitBinary: string) {
    super(`git is not available on this server (spawn "${gitBinary}" failed)`);
    this.name = 'GitUnavailableError';
  }
}

/**
 * A git operation ran and failed (non-zero exit, or killed at the timeout).
 * `message` is client-safe BY CONSTRUCTION: stderr passes through
 * `redactSecrets` with the provider's `secretsToRedact`, AND the op's
 * checkout dir is replaced with `<checkout>` (git stderr readily quotes the
 * destination path — a server-internal absolute path that must not reach a
 * 502 body), before it lands here. G2 stores no git credentials at all
 * (embedded-credential URLs are refused at the Zod boundary), so what
 * remains can only quote what the caller already supplied.
 */
export class GitOperationError extends Error {
  constructor(op: string, detail: string) {
    super(`git ${op} failed: ${detail}`);
    this.name = 'GitOperationError';
  }
}

/** #3 G6b — one `ls-tree -r` entry: a managed file's repo-relative path and the
 * git blob SHA of its content at the read ref. The blob sha stamps the imported
 * version's `source_blob_sha` provenance. */
export interface ManagedTreeEntry {
  path: string;
  blobSha: string;
}

export interface CliGitProviderOptions {
  /** Binary to invoke (default `git`, resolved via PATH). A test seam (shim scripts) — not exposed to clients. */
  gitBinary?: string;
  /** Values to scrub from stderr/error text — EMPTY in G2 (no stored git credentials exist); the G10 PAT hook. */
  secretsToRedact?: readonly string[];
  /** Local-op timeout override — exercised by the hung-command test. Remote-op timeouts are the module constants (no consumer overrides them; no inert options). */
  localTimeoutMs?: number;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CliGitProvider {
  private readonly gitBinary: string;
  private readonly secretsToRedact: readonly string[];
  private readonly localTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CliGitProviderOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.secretsToRedact = options.secretsToRedact ?? [];
    this.localTimeoutMs = options.localTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
    this.env = buildGitEnv(process.env);
  }

  /** Probe that git exists and runs; throws `GitUnavailableError` when it doesn't. */
  async version(): Promise<string> {
    const { stdout } = await this.execOk('version', ['version'], this.localTimeoutMs);
    return stdout.trim();
  }

  /**
   * Clone `src` into `dir` (creating it). `--` guards against an
   * option-shaped src/dir; an EMPTY remote clones fine (git warns only) —
   * that is the connect-a-new-repo onboarding state. `--origin origin` PINS
   * the remote name: the child inherits the operator's gitconfig (that IS the
   * auth model), and a `clone.defaultRemoteName` there would otherwise name
   * the remote something else — permanently breaking every `origin`-addressed
   * fetch/rev-parse on this checkout (verified empirically in review).
   */
  async clone(src: string, dir: string): Promise<void> {
    await this.execOk(
      'clone',
      ['clone', '--origin', 'origin', '--', src, dir],
      DEFAULT_CLONE_TIMEOUT_MS,
      dir,
    );
  }

  /**
   * Fetch from origin, PRUNING deleted remote branches — without `--prune` a
   * remotely-deleted collaboration branch would keep resolving to its stale
   * head forever and the workspace would report "ready" against a branch that
   * no longer exists (verified empirically in the plan review).
   */
  async fetch(dir: string): Promise<void> {
    await this.execOk(
      'fetch',
      ['-C', dir, 'fetch', '--prune', 'origin'],
      DEFAULT_FETCH_TIMEOUT_MS,
      dir,
    );
  }

  /**
   * The observed head of `refs/remotes/origin/<branch>`, or `null` when the
   * remote does not have that branch (a real, expected state — empty repo,
   * pre-first-push, or a deleted branch after a pruning fetch). `--verify
   * --quiet` makes "missing" a silent exit-1, distinguishable from a genuine
   * failure (exit 128 + stderr). The branch name is Zod-validated to
   * check-ref-format shape at the boundary before it reaches this
   * interpolation.
   */
  async revParseRemoteBranch(dir: string, branch: string): Promise<string | null> {
    const result = await this.exec(
      'rev-parse',
      ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      this.localTimeoutMs,
      dir,
    );
    if (result.code === 0) return result.stdout.trim();
    if (result.code === 1 && result.stderr.trim() === '') return null;
    throw new GitOperationError(
      'rev-parse',
      this.redact(result.stderr.trim() || `exit ${result.code}`, dir),
    );
  }

  /**
   * #3 G3a — put the working tree on `branch`, creating or resetting it.
   *
   * With a `baseRef` (e.g. `origin/studio/local/work` to continue the branch,
   * or `origin/main` to start it): `checkout -f -B` — the managed checkout is
   * DERIVED/disposable, so `-f` force-discards any dirt a crash between a prior
   * serialize and commit may have left, guaranteeing the tree matches
   * `baseRef` before the caller rewrites the managed dirs.
   *
   * With `baseRef === null` (the empty-repo onboarding case — no collaboration
   * branch to base on): `checkout --orphan` starts a parentless branch, then
   * the index is cleared (`rm -r --cached`, `--ignore-unmatch` tolerating an
   * already-empty index) so ONLY the caller's scoped `add` decides the first
   * commit — never carrying over a default branch's tree.
   */
  async checkoutWorkingBranch(dir: string, branch: string, baseRef: string | null): Promise<void> {
    if (baseRef !== null) {
      await this.execOk(
        'checkout',
        ['-C', dir, 'checkout', '-f', '-B', branch, baseRef],
        this.localTimeoutMs,
        dir,
      );
      return;
    }
    await this.execOk(
      'checkout',
      ['-C', dir, 'checkout', '--orphan', branch],
      this.localTimeoutMs,
      dir,
    );
    await this.execOk(
      'rm',
      ['-C', dir, 'rm', '-r', '--cached', '--ignore-unmatch', '--quiet', '.'],
      this.localTimeoutMs,
      dir,
    );
  }

  /**
   * #3 G3a — remove the given pathspecs from the INDEX only (`--cached`, worktree
   * untouched), tolerating pathspecs that match nothing (`--ignore-unmatch`).
   * The Commit route calls this on the three studio-managed dirs before
   * re-adding the freshly-serialized files: every previously-tracked managed
   * file is staged as a deletion, so a removed resource's file disappears and
   * an unchanged file's re-add nets back to zero (no-op detection stays
   * precise). Scoped to the managed dirs — never `.` at the root — so nothing
   * outside them is ever touched. Local op.
   */
  async rmCached(dir: string, pathspecs: readonly string[]): Promise<void> {
    await this.execOk(
      'rm',
      ['-C', dir, 'rm', '-r', '--cached', '--ignore-unmatch', '--quiet', '--', ...pathspecs],
      this.localTimeoutMs,
      dir,
    );
  }

  /**
   * #3 G3a — force-stage the given file paths (`add -f -- <paths>`). The Commit
   * route passes the EXACT set of serialized files it just wrote (all of which
   * exist, so no "pathspec did not match" abort) — never a bare `add -A` at the
   * checkout root, so a stray untracked file (crash debris, an operator's local
   * edit) can never enter studio's commit. Deletions are handled by the
   * preceding `rmCached`.
   *
   * `-f` is load-bearing: studio OWNS the three managed dirs on its working
   * branch, but a base branch may carry a `.gitignore` matching one of them (or
   * a broad `*.json`), and `git add` of an explicitly-named IGNORED path EXITS
   * NON-ZERO (not a silent skip) — which would make every Commit a permanent
   * 502 for such a repo. Forcing is safe here precisely because the path set is
   * the exact, containment-checked serialized set, never a wildcard. Local op;
   * a no-op when `paths` is empty.
   */
  async add(dir: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.execOk('add', ['-C', dir, 'add', '-f', '--', ...paths], this.localTimeoutMs, dir);
  }

  /**
   * #3 G3a — whether the index differs from `HEAD` (`diff --cached --quiet`:
   * exit 0 = nothing staged, exit 1 = staged changes). The Commit route reads
   * this AFTER staging to decide a no-op Commit — precise where a whole-tree
   * `status --porcelain` is not: an untracked file OUTSIDE the managed dirs
   * (which the scoped staging never touches) must not be mistaken for a change
   * to commit. Local op.
   */
  async hasStagedChanges(dir: string): Promise<boolean> {
    const result = await this.exec(
      'diff',
      ['-C', dir, 'diff', '--cached', '--quiet'],
      this.localTimeoutMs,
      dir,
    );
    if (result.code === 0) return false;
    if (result.code === 1) return true;
    throw new GitOperationError(
      'diff',
      this.redact(result.stderr.trim() || `exit ${result.code}`, dir),
    );
  }

  /**
   * #3 G3a — commit the staged tree with an explicit author/committer identity
   * (`-c user.name`/`user.email`), returning the new commit sha. The identity
   * is passed per-invocation rather than read from ambient gitconfig: a
   * headless server has no `user.name`/`user.email` set, and the author is the
   * request principal (#1 audit), not the OS user. Returns the resolved
   * `HEAD`. Local op.
   */
  async commit(
    dir: string,
    message: string,
    author: { name: string; email: string },
  ): Promise<string> {
    await this.execOk(
      'commit',
      [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        '-C',
        dir,
        'commit',
        '-m',
        message,
      ],
      this.localTimeoutMs,
      dir,
    );
    const { stdout } = await this.execOk(
      'rev-parse',
      ['-C', dir, 'rev-parse', 'HEAD'],
      this.localTimeoutMs,
      dir,
    );
    return stdout.trim();
  }

  /**
   * #3 G3a — push `branch` to origin. NEVER `--force`: a non-fast-forward is a
   * REAL rejection (the working branch moved underneath — another session, a
   * manual push) and is surfaced as a `GitOperationError` (502). That rejection
   * IS the advisory drift gate until the descendant guard lands (spec #3: "the
   * real serialization point is the push non-fast-forward"). Remote op.
   */
  async push(dir: string, branch: string): Promise<void> {
    await this.execOk('push', ['-C', dir, 'push', 'origin', branch], DEFAULT_PUSH_TIMEOUT_MS, dir);
  }

  /**
   * #3 G4 — every blob under `pathspecs` at `ref` as `{ path, blobSha }`, read
   * STRAIGHT FROM THE OBJECT STORE (`ls-tree -r`), so it never touches the
   * working tree / index the Commit path owns — a read at any ref is safe to run
   * inside the same `KeyedQueue` slot without disturbing HEAD. `-z` NUL-delimits
   * the records (git would otherwise quote/escape a name with special bytes), `--`
   * separates the pathspecs. `ref` is a resolved sha (the caller passes the
   * observed collab head), so the read is a single immutable snapshot. A pathspec
   * absent from the tree simply contributes no entries (no error). Local op.
   *
   * #3 G6b — the blob sha is now surfaced (the `--name-only` filter is dropped)
   * so the workspace-git import can stamp each minted version's git provenance
   * (`pipeline_versions.source_blob_sha`) WITHOUT a second `cat-file` per path.
   * Each `-r -z` record is `<mode> <type> <sha>\t<path>` (verified against real
   * git): the sha is the third space-delimited token before the TAB, the path is
   * everything after it. `-r` recurses, so entries are only blobs (or submodule
   * `commit`s); callers filter to the `.json` blobs they manage.
   */
  async lsTreeManaged(
    dir: string,
    ref: string,
    pathspecs: readonly string[],
  ): Promise<ManagedTreeEntry[]> {
    const { stdout } = await this.execOk(
      'ls-tree',
      ['-C', dir, 'ls-tree', '-r', '-z', ref, '--', ...pathspecs],
      this.localTimeoutMs,
      dir,
    );
    return stdout
      .split('\0')
      .filter((record) => record.length > 0)
      .map((record) => {
        const tab = record.indexOf('\t');
        // `<mode> <type> <sha>` before the TAB, the repo-relative path after it.
        const meta = record.slice(0, tab);
        const path = record.slice(tab + 1);
        const blobSha = meta.split(' ')[2] ?? '';
        return { path, blobSha };
      });
  }

  /**
   * #3 G4 — the contents of the blob at `ref:path`, read from the object store
   * (`git show`). `path` is a repo-relative path that came from `lsTreeManaged`
   * (git's own tree output, never raw client input); `ref` is a resolved sha.
   * The blob is emitted verbatim (no trailing newline added), so a file written
   * by the Commit path re-reads byte-identical. A blob exceeding the 1 MiB
   * collected-output cap surfaces as a `GitOperationError` (a studio-serialized
   * config is tiny — a megabyte means the committed file is not one of ours).
   * Local op.
   */
  async showBlob(dir: string, ref: string, path: string): Promise<string> {
    const { stdout } = await this.execOk(
      'show',
      ['-C', dir, 'show', `${ref}:${path}`],
      this.localTimeoutMs,
      dir,
    );
    return stdout;
  }

  /**
   * Secrets out (the `secretsToRedact` seam), then the op's checkout dir →
   * `<checkout>` — subpaths under it become `<checkout>/…`, so no error text
   * ever quotes the server-internal absolute checkout path.
   */
  private redact(text: string, dir?: string): string {
    const scrubbed = redactSecrets(text, this.secretsToRedact);
    return dir === undefined ? scrubbed : scrubbed.split(dir).join('<checkout>');
  }

  /** Like `exec`, but a non-zero exit is already an error. */
  private async execOk(
    op: string,
    args: string[],
    timeoutMs: number,
    dir?: string,
  ): Promise<ExecResult> {
    const result = await this.exec(op, args, timeoutMs, dir);
    if (result.code !== 0) {
      throw new GitOperationError(
        op,
        this.redact(result.stderr.trim() || `exit ${result.code}`, dir),
      );
    }
    return result;
  }

  /**
   * Runs git, resolving with the exit code (callers interpret non-zero);
   * rejects only for "git itself couldn't run": spawn ENOENT →
   * `GitUnavailableError`, killed at the timeout → `GitOperationError`.
   */
  private exec(op: string, args: string[], timeoutMs: number, dir?: string): Promise<ExecResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(
        this.gitBinary,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: this.env,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolvePromise({ code: 0, stdout, stderr });
            return;
          }
          const errno = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          if (errno.code === 'ENOENT') {
            rejectPromise(new GitUnavailableError(this.gitBinary));
            return;
          }
          if (errno.killed === true) {
            rejectPromise(new GitOperationError(op, `timed out after ${timeoutMs}ms`));
            return;
          }
          if (typeof errno.code === 'number') {
            resolvePromise({ code: errno.code, stdout, stderr });
            return;
          }
          // Anything else (maxBuffer overflow, unexpected signal): surface as
          // an op failure with the (redacted) library message — which can
          // embed the full argv, so the dir redaction applies here too.
          rejectPromise(new GitOperationError(op, this.redact(errno.message, dir)));
        },
      );
    });
  }
}

/** The capability seam (widened per consumer; `merge-base --is-ancestor` lands
 * with the descendant guard, a later G3 slice). */
export type GitProvider = Pick<
  CliGitProvider,
  | 'version'
  | 'clone'
  | 'fetch'
  | 'revParseRemoteBranch'
  | 'checkoutWorkingBranch'
  | 'rmCached'
  | 'add'
  | 'hasStagedChanges'
  | 'commit'
  | 'push'
  | 'lsTreeManaged'
  | 'showBlob'
>;
