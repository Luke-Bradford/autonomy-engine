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
 * Ops are ONLY what G2 consumes (version/clone/fetch/rev-parse). G3 adds
 * `status --porcelain` + `merge-base --is-ancestor` with their consumers —
 * the no-inert-surface rule.
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

/** The capability seam G3+ will widen (commit/push/status/is-ancestor land with their consumers). */
export type GitProvider = Pick<
  CliGitProvider,
  'version' | 'clone' | 'fetch' | 'revParseRemoteBranch'
>;
