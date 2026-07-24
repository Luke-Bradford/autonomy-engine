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
 * commit/push (the Commit path); G10 — `merge-base --is-ancestor`
 * (`isAncestor`), the proactive descendant guard's history walk.
 *
 * AUTH MODEL (pinned, G2): the operator's own environment — SSH agent +
 * credential helper of the user running the server. Nothing interactive can
 * ever hang an op: `buildGitEnv` pins `GIT_TERMINAL_PROMPT=0` (no terminal
 * prompt), `GIT_ASKPASS=echo` (an askpass that returns empty — auth FAILS
 * fast instead of prompting), and `ssh -oBatchMode=yes` (unless the operator
 * set their own `GIT_SSH_COMMAND`).
 *
 * G10 (transport auth): an OPERATOR-ENV GitHub token (the same `GH_TOKEN`/
 * `GITHUB_TOKEN` G9b resolves for the REST PR-open) can now ALSO authenticate
 * HTTPS transport — closing the gap where G9b opens a PR via REST but the
 * `git push` that must precede it has no credential on a headless host with no
 * credential helper. It is injected via `githubTokenTransportAuth` →
 * `applyHttpAuthEnv` as a github.com-scoped `http.extraHeader` in the NETWORK
 * ops' child ENV (never the argv; url-scoped so a non-github remote is
 * unaffected). Its value flows through `secretsToRedact` so no error/stderr ever
 * quotes it. A DB-STORED PAT (with its own encryption/UI/per-remote decisions)
 * and non-github hosts + multi-remote remain later G10 slices.
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
 * #3 G10 — a URL-scoped HTTP auth header for git transport. `header` is applied
 * as git's `http.<urlPrefix>.extraHeader`, so git sends it ONLY on HTTP(S)
 * requests whose URL matches `urlPrefix` (verified empirically:
 * `config --get-urlmatch` returns it for a matching host and nothing for any
 * other). That URL scoping is what makes it safe to attach to EVERY network op
 * regardless of the actual remote — a non-matching remote (SSH, a different
 * host, a local path) simply never receives it.
 */
export interface GitHttpAuth {
  /** The git-config URL prefix the header is scoped to (e.g. `https://github.com/`). */
  urlPrefix: string;
  /** The full header line, e.g. `AUTHORIZATION: basic <base64>`. */
  header: string;
}

/**
 * #3 G10 — overlay a `GitHttpAuth` onto a git child env as a count-based
 * `GIT_CONFIG_*` entry. This is deliberately NOT `-c http.<url>.extraHeader=…`
 * on the ARGV: the argv of a running process is readable by other local
 * processes (`ps`), so a base64'd token there would be a defense-in-depth leak
 * that the `secretsToRedact` seam (which only scrubs error TEXT) cannot cover.
 * The `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env form
 * (git ≥ 2.31) injects the same config with the value in the child ENV instead.
 *
 * It APPENDS at the next free index rather than clobbering any `GIT_CONFIG_COUNT`
 * the operator's own environment already carries (their injected config must
 * survive). A malformed/absent pre-existing count degrades to index 0 — never a
 * `NaN` key that git would reject.
 */
export function applyHttpAuthEnv(
  base: NodeJS.ProcessEnv,
  httpAuth: GitHttpAuth,
): NodeJS.ProcessEnv {
  const parsed = Number.parseInt(base.GIT_CONFIG_COUNT ?? '', 10);
  const n = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  return {
    ...base,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${httpAuth.urlPrefix}.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: httpAuth.header,
  };
}

/**
 * #3 G10 — build the transport auth for a GitHub HTTPS remote from an operator's
 * token (`GH_TOKEN`/`GITHUB_TOKEN`, the SAME env token G9b resolves for the REST
 * PR-open). The header is `AUTHORIZATION: basic base64("x-access-token:<token>")`
 * — the canonical git-over-HTTPS token form (GitHub accepts basic auth with any
 * username and the token as the password; `x-access-token` is the conventional
 * username, matching `actions/checkout`). NOTE the deliberate asymmetry with the
 * REST client (`github-host.ts`, which uses `Authorization: Bearer <token>`):
 * git TRANSPORT wants Basic, the REST API wants Bearer — do not "unify" them.
 * Scoped to `https://github.com/` (the only host this env token belongs to, per
 * G9b); a non-github remote never matches and is unaffected. The value is never
 * stored, never logged, and both the raw token and its base64 credential go into
 * the `secretsToRedact` seam so no error/stderr can ever quote either.
 */
export function githubTokenTransportAuth(token: string): {
  httpAuth: GitHttpAuth;
  secrets: readonly string[];
} {
  // Fail loudly on an empty token rather than manufacture a bogus
  // `x-access-token:`-with-no-password header (an auth attempt guaranteed to
  // 401) and seed `secretsToRedact` with a useless empty needle. The live call
  // site already guards this (`githubToken !== null`, itself `… || null` of a
  // trimmed value), so this only protects a future reuse of the exported seam.
  if (token.length === 0) {
    throw new Error('githubTokenTransportAuth requires a non-empty token');
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    httpAuth: { urlPrefix: 'https://github.com/', header: `AUTHORIZATION: basic ${basic}` },
    secrets: [token, basic],
  };
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

/**
 * #3 G10 — a `git push` was REJECTED as a non-fast-forward: the working branch
 * moved on the remote (a concurrent push, a collaborator's direct edit) so the
 * never-`--force` push cannot land. This is a request-STATE conflict — the
 * caller must fetch/import the latest and re-commit — NOT an upstream outage,
 * so it is a DELIBERATE SIBLING of `GitOperationError` (not a subclass): the
 * error handler maps it to 409 `conflict`, distinct from the 502 `git_error` a
 * transport/auth failure gets, with no `instanceof`-ordering fragility between
 * the two branches (this is the transport-level dual of `GitHostRequestError`,
 * GitHub's 422-refusal → 409). The message is fixed and client-safe BY
 * CONSTRUCTION — it quotes no stderr, no checkout path, no branch value.
 */
export class GitPushRejectedError extends Error {
  constructor() {
    super(
      'git push was rejected: the working branch moved on the remote since it was last fetched — fetch/import the latest changes and re-commit',
    );
    this.name = 'GitPushRejectedError';
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
  /**
   * #3 G10 — URL-scoped HTTP transport auth (an operator-env GitHub token, via
   * `githubTokenTransportAuth`). When set, it is overlaid onto the child env of
   * the NETWORK ops only (clone/fetch/push) via `GIT_CONFIG_*` — never the argv,
   * never the local plumbing ops. Absent = the G2 auth model (SSH agent +
   * credential helper) alone.
   */
  httpAuth?: GitHttpAuth;
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
  /** The base child env — all LOCAL/plumbing ops run with exactly this. */
  private readonly env: NodeJS.ProcessEnv;
  /**
   * The child env for the NETWORK ops (clone/fetch/push): `env` plus the
   * `httpAuth` overlay when one is configured, else `env` unchanged. Keeping it
   * off the local-op env means the transport token is never even present in the
   * child that runs a `merge-base`/`rev-parse`/`commit`.
   */
  private readonly networkEnv: NodeJS.ProcessEnv;

  constructor(options: CliGitProviderOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.secretsToRedact = options.secretsToRedact ?? [];
    this.localTimeoutMs = options.localTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
    this.env = buildGitEnv(process.env);
    this.networkEnv =
      options.httpAuth !== undefined ? applyHttpAuthEnv(this.env, options.httpAuth) : this.env;
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
      this.networkEnv,
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
      this.networkEnv,
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
   * #3 G3a/G10 — push `branch` to origin. NEVER `--force`: a non-fast-forward is
   * a REAL rejection (the working branch moved underneath — another session, a
   * collaborator's direct edit). That rejection IS the advisory drift gate until
   * the proactive descendant guard lands (spec #3: "the real serialization point
   * is the push non-fast-forward"). Remote op.
   *
   * #3 G10 — the rejection is CLASSIFIED (not the opaque 502 it once was): git's
   * transport status strings `(non-fast-forward)` / `(fetch first)` (emitted with
   * or without a prior fetch respectively — verified empirically) are NOT
   * gettext-localized, unlike the `hint:`/`error:` lines, so matching them is
   * locale-robust. A match → `GitPushRejectedError` (→ 409 `conflict`, "fetch and
   * re-commit"); any OTHER non-zero exit (transport/auth outage, a
   * `[remote rejected]` server-hook/policy refusal — neither carries a marker)
   * stays a `GitOperationError` (→ 502 `git_error`). Uses `exec` rather than
   * `execOk` precisely so the non-zero result can be inspected; timeout/output-cap
   * behaviour is unchanged (`execOk` is only `exec` + throw-on-nonzero).
   */
  async push(dir: string, branch: string): Promise<void> {
    const result = await this.exec(
      'push',
      ['-C', dir, 'push', 'origin', branch],
      DEFAULT_PUSH_TIMEOUT_MS,
      dir,
      this.networkEnv,
    );
    if (result.code === 0) return;
    if (/non-fast-forward|fetch first/i.test(result.stderr)) {
      throw new GitPushRejectedError();
    }
    throw new GitOperationError(
      'push',
      this.redact(result.stderr.trim() || `exit ${result.code}`, dir),
    );
  }

  /**
   * #3 G10 — is `ancestor` an ancestor of (or equal to) `descendant`? The
   * history walk the PROACTIVE descendant guard uses to split `behind` (the
   * import base is an ancestor of the current collab head — a fast-forward)
   * from `diverged` (it is not — collab was rewritten). `merge-base
   * --is-ancestor A B` is a pure OBJECT-STORE read (never touches HEAD/the
   * index the Commit path owns), so it is safe in the same per-owner
   * `KeyedQueue` slot as a drift/status read.
   *
   * Exit-code discipline mirrors `revParseRemoteBranch`: exit 0 = A IS an
   * ancestor (true); exit 1 WITH empty stderr = A is NOT an ancestor (a real,
   * expected answer, false); anything else (exit 128 + stderr — a bad or
   * MISSING commit, e.g. a base force-pushed away and pruned locally) is a
   * genuine FAILURE and throws, never manufactured as a benign `false`/`current`
   * (the #473 / merge-gate "a `gh` failure is never CI-green" fail-safe posture).
   * Both args are server-RESOLVED shas (the persisted import base + the just-
   * fetched collab head), never raw client input. Uses `exec` (not `execOk`) so
   * exit 1 can be interpreted rather than thrown. Local op.
   */
  async isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.exec(
      'merge-base',
      ['-C', dir, 'merge-base', '--is-ancestor', ancestor, descendant],
      this.localTimeoutMs,
      dir,
    );
    if (result.code === 0) return true;
    if (result.code === 1 && result.stderr.trim() === '') return false;
    throw new GitOperationError(
      'merge-base',
      this.redact(result.stderr.trim() || `exit ${result.code}`, dir),
    );
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
        // The `-r -z` format is stable, but FAIL LOUDLY rather than manufacture an
        // empty sha: an empty `source_blob_sha` would violate the schema's
        // `.min(1)` and brick the version on every subsequent read (a latent
        // fail-closed). A malformed listing is systemic, so reject the whole read.
        // Guard BEFORE slicing so a malformed record never wastes a slice/split.
        if (tab < 0) {
          throw new GitOperationError('ls-tree', 'unexpected ls-tree record format');
        }
        // `<mode> <type> <sha>` before the TAB, the repo-relative path after it.
        const meta = record.slice(0, tab);
        const path = record.slice(tab + 1);
        const blobSha = meta.split(' ')[2];
        if (blobSha === undefined || blobSha.length === 0) {
          throw new GitOperationError('ls-tree', 'unexpected ls-tree record format');
        }
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
    env: NodeJS.ProcessEnv = this.env,
  ): Promise<ExecResult> {
    const result = await this.exec(op, args, timeoutMs, dir, env);
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
   * `GitUnavailableError`, killed at the timeout → `GitOperationError`. `env`
   * defaults to the base env; the network ops pass `this.networkEnv` so the
   * transport auth overlay reaches only them.
   */
  private exec(
    op: string,
    args: string[],
    timeoutMs: number,
    dir?: string,
    env: NodeJS.ProcessEnv = this.env,
  ): Promise<ExecResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(
        this.gitBinary,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          env,
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

/** The capability seam (widened per consumer). */
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
  | 'isAncestor'
>;
