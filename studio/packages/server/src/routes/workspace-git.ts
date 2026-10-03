import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import {
  CommitWorkspaceGitBodySchema,
  ConnectWorkspaceGitBodySchema,
  deriveDefaultWorkingBranch,
  MANAGED_DIRS,
  PullRequestResultSchema,
  resolvePullRequestTarget,
  SetWorkingBranchBodySchema,
  SetWorkspaceGitTokenBodySchema,
  WorkspaceGitBranchSchema,
  WorkspaceGitCommitResultSchema,
  WorkspaceGitApplyResultSchema,
  WorkspaceGitDivergenceSchema,
  WorkspaceGitDriftSchema,
  WorkspaceGitSyncSchema,
  WorkspaceGitImportPreviewSchema,
  WorkspaceGitPullRequestReadingSchema,
  deriveWorkspaceGitState,
  precheckDivergence,
  WorkspaceGitStatusSchema,
  type WorkspaceGit,
  type WorkspaceGitDivergence,
  type WorkspaceGitDivergenceState,
  type WorkspaceGitDrift,
  type WorkspaceGitPipelineDrift,
  type WorkspaceGitPullRequestReading,
} from '@autonomy-studio/shared';
import {
  appendWorkspaceEvent,
  createWorkspaceGit,
  deleteWorkspaceGit,
  getWorkspaceGit,
  getWorkspaceGitToken,
  listPipelines,
  listVersionResourceIds,
  setWorkspaceGitToken,
  updateWorkspaceGitImportedCommit,
  updateWorkspaceGitSync,
  updateWorkspaceGitWorkingBranch,
  workspaceGitTokenPresent,
  WorkspaceGitAlreadyConnectedError,
} from '../repo/index.js';
import {
  applyWorkspace,
  buildImportAppliedEvent,
  classifyWorkspace,
  computeDrift,
  latestVersion,
  ownedVersionForms,
  parseWorkspaceFiles,
  serializeWorkspace,
  serializeWorkspaceTolerant,
  unserializableDiagnostic,
  withoutResources,
  type UnserializableResource,
} from '../portability/index.js';
import { checkoutDirFor, removeCheckoutDir } from '../git/checkout.js';
import { readWorkspaceFilesAtRef } from '../git/workspace-read.js';
import {
  CliGitProvider,
  githubTokenTransportAuth,
  GitOperationError,
  GitUnavailableError,
  type GitProvider,
} from '../git/provider.js';
import { GitHostApiError, GitHubHostClient, type GitHostClient } from '../git/github-host.js';
import { redactSecrets } from '../connectors/redact.js';
import { sha256Hex } from '../util/hash.js';
import { decrypt, encrypt } from '../secrets/secrets.js';
import { KeyedQueue } from '../util/keyed-queue.js';
import { readyVersionResourceIds } from '../run/connection-readiness.js';
import { NotFoundError } from '../errors.js';
import type { Db } from '../repo/types.js';

/**
 * #3 G2 + G3a — connect/status/fetch/disconnect + Commit for the workspace↔git
 * association.
 *
 * Every git-touching handler runs inside the per-owner `KeyedQueue`, so a
 * concurrent connect/fetch/commit/disconnect can never interleave filesystem
 * work on the same managed checkout. The checkout is DERIVED state throughout:
 * connect clears any orphaned dir before cloning (no row ⇒ the dir is a
 * crash-mid-clone leftover by definition), fetch/commit re-clone a wiped
 * checkout, disconnect removes it — every divergence between row and disk
 * self-heals.
 *
 * Security model: `repoUrl`/`collabBranch`/`message` are user input validated by
 * the shared boundary schemas (scheme allowlist, no embedded credentials,
 * check-ref-format branch shape, non-empty message) BEFORE reaching a git argv;
 * ownerId comes from `request.principal`, never the client; git runs with the
 * master-key env vars stripped and can never prompt (see `git/provider.ts`).
 * The working branch is now the PERSISTED, per-workspace `working_branch` (#3
 * G9a — defaulted to `studio/<ownerId>/work` on connect, re-pointed by the
 * working-branch route; re-parsed through the branch validator at the commit
 * argv boundary), and the Commit only ever writes/stages the three
 * studio-managed dirs, never the user's own repo files.
 *
 * The `MANAGED_DIRS` a Commit owns and an import-preview reads come from the
 * shared G1 path policy (single source of truth) — never re-hardcoded here.
 */

export interface WorkspaceGitRoutesOptions {
  workspaceGitRoot: string;
  /** Test seam; defaults to a real `CliGitProvider`. */
  provider?: GitProvider;
  /**
   * #3 G9b — the operator-env GitHub token (`GH_TOKEN`/`GITHUB_TOKEN`, resolved at
   * wiring time in `index.ts`), or `null`/absent when none is set. When present
   * AND the remote is a GitHub host, the pull-request route auto-opens the PR via
   * the host API; otherwise it falls back to G9a's guided-manual compare URL.
   * Trimmed at the boundary — a whitespace-only value counts as absent.
   *
   * #3 G10 — when set, this token ALSO authenticates git HTTPS transport
   * (clone/fetch/push) for a github.com remote (see `githubTokenTransportAuth`);
   * a non-github remote is unaffected. Ignored when a test injects `provider`.
   */
  githubToken?: string | null;
  /** #3 G9b — test seam for the GitHub host API; defaults to a real `GitHubHostClient`. */
  hostClient?: GitHostClient;
  /**
   * #1476 OR28 — how old the managed checkout's last fetch may be before
   * `POST /api/workspace/git/sync` fetches again (ms). `0` fetches on every call.
   * Resolved from `GIT_FETCH_MAX_AGE_SECONDS` at wiring time.
   */
  fetchMaxAgeMs: number;
}

function statusOf(db: Db, row: WorkspaceGit) {
  return WorkspaceGitStatusSchema.parse({
    ...row,
    state: deriveWorkspaceGitState(row),
    // #3 G10 — the only client-facing signal about the stored token: whether one
    // exists, NEVER the ciphertext. Guard the null-owner case (a null `ownerId`
    // never matches the token query) so it reports `false`, not a throw.
    hasStoredToken: row.ownerId !== null && workspaceGitTokenPresent(db, row.ownerId),
  });
}

/**
 * Ensure the owner's managed checkout is present and freshly fetched, recording
 * the sync outcome on the row EXACTLY as the fetch route does — the single
 * source of the "is the checkout present + up to date" behaviour, shared by the
 * fetch and commit handlers so their fetch-state semantics can't diverge. The
 * checkout is derived state: a wiped one is re-cloned rather than failing
 * forever. On a git failure the (client-safe, redacted) message is stored in
 * `lastFetchError` (state → `fetch_error`) AND rethrown; any non-git error gets
 * a fixed string (GET surfaces this field, so it must never quote a
 * server-internal absolute path). Returns the updated row (non-null — the
 * caller checked it exists inside the same queue slot).
 */
async function ensureCheckoutFetched(
  db: Db,
  provider: GitProvider,
  workspaceGitRoot: string,
  ownerId: string,
  row: WorkspaceGit,
): Promise<WorkspaceGit> {
  const checkout = checkoutDirFor(workspaceGitRoot, ownerId);
  try {
    if (!existsSync(join(checkout, '.git'))) {
      await removeCheckoutDir(workspaceGitRoot, ownerId);
      await mkdir(dirname(checkout), { recursive: true });
      await provider.clone(row.repoUrl, checkout);
    } else {
      await provider.fetch(checkout);
    }
    const head = await provider.revParseRemoteBranch(checkout, row.collabBranch);
    return updateWorkspaceGitSync(db, ownerId, {
      observedCollabHead: head,
      lastFetchAt: Date.now(),
      lastFetchError: null,
    })!;
  } catch (err) {
    const clientSafe = err instanceof GitOperationError || err instanceof GitUnavailableError;
    updateWorkspaceGitSync(db, ownerId, {
      observedCollabHead: row.observedCollabHead,
      lastFetchAt: Date.now(),
      lastFetchError: clientSafe ? (err as Error).message : 'internal error during fetch',
    });
    throw err;
  }
}

/**
 * Is a reading taken at `at` too old to reuse? `null` (never taken) is. So is a
 * negative age — a clock that went back: stale, never "fresh until the clock
 * catches up". Shared by `/sync`'s fetch and the pull-request read, so the two
 * windows cannot disagree on what "older than `GIT_FETCH_MAX_AGE_SECONDS`" means.
 */
function isStale(at: number | null, maxAgeMs: number): boolean {
  if (at === null) return true;
  const age = Date.now() - at;
  return age < 0 || age >= maxAgeMs;
}

/**
 * Resolve a repo-relative serialized path to an absolute path, asserting it
 * stays inside the checkout. Belt-and-braces (the G1 slug already neutralizes
 * `.`/`/` in a resource name, so a serialized path can't traverse) — the same
 * containment posture `git/checkout.ts` takes on its own destructive paths.
 */
function resolveInCheckout(checkout: string, relPath: string): string {
  const abs = resolve(checkout, relPath);
  if (abs !== checkout && !abs.startsWith(checkout + sep)) {
    throw new Error(`serialized path "${relPath}" escapes the managed checkout`);
  }
  return abs;
}

export const workspaceGitRoutes: FastifyPluginAsync<WorkspaceGitRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { db, masterKey } = fastify;
  const { workspaceGitRoot } = opts;
  const hostClient = opts.hostClient ?? new GitHubHostClient();
  // #3 G9b — normalize the operator-env token ONCE: a whitespace-only value (or
  // an empty/unset `GH_TOKEN`) counts as absent, so it falls back to guided-manual
  // rather than attempting an auth that would 401. `null` = no token.
  const githubToken = (opts.githubToken ?? '').trim() || null;
  const queue = new KeyedQueue();
  /**
   * #1476 OR28 — the last pull-request lookup per owner, for
   * `GET /api/workspace/git/pull-request`. One entry per owner: `key` is the
   * question asked (repo, working branch, credential), so a new one is a miss,
   * not a second entry. The PROMISE is held, so concurrent reads share one host
   * call. A host failure resolves as `lookup_failed` and is kept for the
   * window; any other fault rejects and is evicted at once.
   */
  const pullRequestLookups = new Map<
    string,
    { key: string; at: number; reading: Promise<WorkspaceGitPullRequestReading> }
  >();

  /**
   * #3 G10 — resolve the EFFECTIVE git token for an owner, the SINGLE source of
   * precedence shared by git transport auth (`resolveProvider`) AND the REST
   * PR-open path — so the two can never disagree on which credential a workspace
   * uses (a stored token that authenticated `git push` but left PR-open on the
   * env token would fall to guided-manual, an incoherent asymmetry).
   *
   * PRECEDENCE: a per-workspace STORED token (decrypted under the boot master
   * key) WINS over the process-global operator-env token — most-specific scope
   * wins; the env token is the fallback. `null` = neither, so no auth (the G2
   * SSH-agent / credential-helper model).
   *
   * A decrypt failure HARD-FAILS (propagates `SecretDecryptionError` → 500),
   * NEVER silently falling back to the env token: a stored credential that can't
   * be read is a real misconfiguration, and manufacturing a different (env)
   * credential in its place is exactly the fail-open the #473 / merge-gate
   * posture forbids. `SecretDecryptionError` carries no plaintext/key material.
   */
  async function resolveEffectiveToken(ownerId: string): Promise<string | null> {
    const stored = getWorkspaceGitToken(db, ownerId);
    if (stored !== null) return decrypt(stored, masterKey);
    return githubToken;
  }

  /**
   * #3 G10 — build the per-owner `GitProvider` for a NETWORK op. The injected
   * test seam (`opts.provider`) short-circuits token resolution entirely (its
   * auth is the test's concern). Otherwise the effective token (stored ▸ env)
   * becomes a github.com-scoped HTTPS transport header (env-not-argv, redacted
   * via `secretsToRedact`); inert on a non-github remote (url-match) and on the
   * LOCAL plumbing ops that never see it. Resolved INSIDE each per-owner queue
   * slot so a concurrent token set/clear (also queued) can't race it.
   */
  async function resolveProvider(ownerId: string): Promise<GitProvider> {
    if (opts.provider) return opts.provider;
    const token = await resolveEffectiveToken(ownerId);
    const auth = token !== null ? githubTokenTransportAuth(token) : null;
    return new CliGitProvider({
      httpAuth: auth?.httpAuth,
      secretsToRedact: auth?.secrets ?? [],
    });
  }

  /**
   * The drift report's body, run AFTER the caller's fetch decision: the POST
   * /drift route always fetches first, `/sync` only when its copy is stale. Both
   * then compare the DB against the refs as last fetched, so the two can never
   * disagree on what "uncommitted" means. `row` is the post-fetch row (its
   * `observedCollabHead` is the base fallback). Also returns the resources the
   * tolerant serialize could not put in resourceId-space, which `/sync` maps to
   * pipelines.
   */
  async function driftReport(
    provider: GitProvider,
    ownerId: string,
    updated: WorkspaceGit,
  ): Promise<{
    drift: WorkspaceGitDrift;
    baseBranch: string | null;
    uncomparable: UnserializableResource[];
  }> {
    const workingBranch = WorkspaceGitBranchSchema.parse(updated.workingBranch);
    const checkout = checkoutDirFor(workspaceGitRoot, ownerId);

    // Base = what the next Commit would base on: the working-branch tip if it
    // exists (a resolved sha), else the just-fetched collaboration head, else
    // null (empty repo — nothing committed yet).
    const workingHead = await provider.revParseRemoteBranch(checkout, workingBranch);
    const base = workingHead ?? updated.observedCollabHead;

    // The DB working copy through the SAME serialize+parse path import-preview
    // uses, so both sides get identical volatile treatment (#666 archived
    // omission included). #1043 — TOLERANT: a resource whose head cannot be put
    // in resourceId-space has no comparable content form, so it is reported
    // rather than 500ing this whole read-only report.
    const serialized = serializeWorkspaceTolerant(db, ownerId);
    const dbSnapshot = parseWorkspaceFiles(serialized.files);
    const uncomparable = new Set(serialized.unserializable.map((o) => `${o.kind}:${o.resourceId}`));

    // The committed snapshot at the base (empty when nothing is committed yet).
    // An unreadable committed blob (#664) becomes a per-file `diagnostic`, not
    // a 502 and not a silent `clean`.
    const committedFiles =
      base === null
        ? { files: [], unreadable: [] }
        : await readWorkspaceFilesAtRef(provider, checkout, base, MANAGED_DIRS);
    const committed = parseWorkspaceFiles(committedFiles.files, committedFiles.unreadable);

    // #1043 — the tolerant serialize already left the offenders out of the DB
    // side; drop them from the COMMITTED side too, so an uncomparable resource
    // is absent from BOTH. Leaving the committed file in would classify it
    // `removed` — a claim the next Commit contradicts, since it refuses
    // outright rather than dropping the resource from the branch.
    const changes = computeDrift(dbSnapshot, withoutResources(committed, uncomparable));

    // A committed file that would not parse yields no `change` (its content is
    // uncomparable), but the next Commit's managed-dir reconcile WOULD drop it
    // — so a diagnostic is itself uncommitted drift. Fold it into the flag
    // (fail-safe: an uncomparable committed file is never a silent `clean`).
    // #1043 — the DB-side diagnostics fold in for the SAME reason and it is
    // load-bearing: an offender alone yields no `change` and no committed
    // diagnostic, so reading the flag off those two would answer "no
    // uncommitted changes" while the next Commit refuses. Fail-safe means the
    // flag is computed over everything reported, never over a subset of it.
    const diagnostics = [
      ...committed.diagnostics,
      ...serialized.unserializable.map(unserializableDiagnostic),
    ];
    const drift = WorkspaceGitDriftSchema.parse({
      base,
      hasUncommittedChanges: changes.length > 0 || diagnostics.length > 0,
      changes,
      diagnostics,
    });
    const baseBranch =
      workingHead !== null ? workingBranch : base !== null ? updated.collabBranch : null;
    return { drift, baseBranch, uncomparable: serialized.unserializable };
  }

  /** The divergence verdict's body, run after the caller's fetch decision (see `driftReport`). */
  async function divergenceReport(
    provider: GitProvider,
    ownerId: string,
    updated: WorkspaceGit,
  ): Promise<WorkspaceGitDivergence> {
    const checkout = checkoutDirFor(workspaceGitRoot, ownerId);

    const importBase = updated.importedFromCommit;
    const collabHead = updated.observedCollabHead;
    const precheck = precheckDivergence(importBase, collabHead);

    let state: WorkspaceGitDivergenceState;
    if (precheck === 'needs-history') {
      // Both shas are non-null here (precheck returned needs-history), so the
      // non-null assertions are sound; the walk splits fast-forward from rewrite.
      state = (await provider.isAncestor(checkout, importBase!, collabHead!))
        ? 'behind'
        : 'diverged';
    } else {
      // 'unknown' | 'current' map straight through.
      state = precheck;
    }

    return WorkspaceGitDivergenceSchema.parse({ state, importBase, collabHead });
  }

  fastify.get('/api/workspace/git', async (request) => {
    const row = getWorkspaceGit(db, request.principal.ownerId);
    return { git: row ? statusOf(db, row) : null };
  });

  fastify.post('/api/workspace/git', async (request, reply) => {
    const body = ConnectWorkspaceGitBodySchema.parse(request.body);
    const ownerId = request.principal.ownerId;

    const row = await queue.run(ownerId, async () => {
      // The row check lives INSIDE the queue so two racing connects serialize
      // (the DB unique index remains the last-line authority regardless).
      if (getWorkspaceGit(db, ownerId)) throw new WorkspaceGitAlreadyConnectedError();

      // #3 G10 — resolve the per-owner provider inside the queue slot (no stored
      // token can exist yet at connect — no row — so this is the env token / no
      // auth; kept here for uniformity with the other network handlers).
      const provider = await resolveProvider(ownerId);
      // Probe git FIRST — a clear 503 beats a confusing clone failure.
      await provider.version();

      const checkout = checkoutDirFor(workspaceGitRoot, ownerId);
      // No row ⇒ anything at the checkout path is a crash-mid-clone orphan;
      // clear it or `git clone` refuses ("destination path already exists").
      await removeCheckoutDir(workspaceGitRoot, ownerId);
      await mkdir(dirname(checkout), { recursive: true });
      try {
        await provider.clone(body.repoUrl, checkout);
      } catch (err) {
        // A failed clone can leave a partial dir — tidy so the NEXT connect
        // starts clean even without the orphan-recovery path.
        await removeCheckoutDir(workspaceGitRoot, ownerId).catch(() => undefined);
        throw err;
      }
      const head = await provider.revParseRemoteBranch(checkout, body.collabBranch);
      // Connect + the `repo.connected` audit fact land in ONE transaction, so
      // the workspace history cannot record a connect that did not persist (or
      // miss one that did). `repoUrl` is credential-free by construction — the
      // connect body schema refuses an embedded `user:password@` — so it is
      // safe to store verbatim in the event.
      return db.transaction(() => {
        const created = createWorkspaceGit(db, {
          ownerId,
          repoUrl: body.repoUrl,
          collabBranch: body.collabBranch,
          // #3 G9a — seed the working branch with the studio-owned default; the
          // working-branch route re-points it for feature-branch selection.
          // Validated at the SEED point (not just the commit boundary) so a
          // branch-illegal owner id fails loudly here at connect, never storing
          // a value the commit route would later throw on.
          workingBranch: WorkspaceGitBranchSchema.parse(deriveDefaultWorkingBranch(ownerId)),
          observedCollabHead: head,
          lastFetchAt: Date.now(),
          lastFetchError: null,
        });
        appendWorkspaceEvent(db, ownerId, {
          type: 'repo.connected',
          repoUrl: body.repoUrl,
          collabBranch: body.collabBranch,
          by: request.principal.id,
        });
        return created;
      });
    });

    reply.status(201).send({ git: statusOf(db, row) });
  });

  fastify.post('/api/workspace/git/fetch', async (request) => {
    const ownerId = request.principal.ownerId;

    const updated = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      const provider = await resolveProvider(ownerId);
      return ensureCheckoutFetched(db, provider, workspaceGitRoot, ownerId, row);
    });

    return { git: statusOf(db, updated) };
  });

  fastify.post('/api/workspace/git/commit', async (request) => {
    const body = CommitWorkspaceGitBodySchema.parse(request.body);
    const ownerId = request.principal.ownerId;
    const principalId = request.principal.id;

    const result = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      // The PERSISTED working branch (#3 G9a). Re-parsed through the same
      // check-ref-format validator every branch crosses before it reaches a git
      // argv / `refs/…/<branch>` interpolation — the row schema stores it as a
      // structural string, so the input-policy check happens here at the boundary.
      const workingBranch = WorkspaceGitBranchSchema.parse(row.workingBranch);
      const provider = await resolveProvider(ownerId);

      // Fetch first (shared with the fetch route) so the base refs below are
      // current; a fetch failure records + rethrows before any commit work.
      await ensureCheckoutFetched(db, provider, workspaceGitRoot, ownerId, row);
      const checkout = checkoutDirFor(workspaceGitRoot, ownerId);

      // Base the working branch on its own remote tip if it exists (so the push
      // fast-forwards), else the collaboration branch, else orphan (empty repo).
      const workingHead = await provider.revParseRemoteBranch(checkout, workingBranch);
      let baseRef: string | null;
      if (workingHead !== null) {
        baseRef = `origin/${workingBranch}`;
      } else {
        const collabHead = await provider.revParseRemoteBranch(checkout, row.collabBranch);
        baseRef = collabHead !== null ? `origin/${row.collabBranch}` : null;
      }
      await provider.checkoutWorkingBranch(checkout, workingBranch, baseRef);

      // Serialize the DB working copy (latest version of each resource), then
      // reconcile the managed dirs: stage the removal of every previously
      // committed managed file, clear them on disk, write the fresh set, and
      // stage exactly those files. An unchanged file's re-add nets back to
      // zero; a removed resource stays a staged deletion.
      const files = serializeWorkspace(db, ownerId);
      await provider.rmCached(checkout, MANAGED_DIRS);
      for (const managedDir of MANAGED_DIRS) {
        await rm(resolveInCheckout(checkout, managedDir), { recursive: true, force: true });
      }
      const writtenPaths: string[] = [];
      for (const file of files) {
        const abs = resolveInCheckout(checkout, file.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, file.contents);
        writtenPaths.push(file.path);
      }
      await provider.add(checkout, writtenPaths);

      if (!(await provider.hasStagedChanges(checkout))) {
        return WorkspaceGitCommitResultSchema.parse({
          committed: false,
          branch: workingBranch,
          commitSha: null,
          files: writtenPaths,
        });
      }

      const commitSha = await provider.commit(checkout, body.message, {
        name: principalId,
        email: `${principalId}@studio.local`,
      });
      // Never `--force`: a non-fast-forward rejection is the advisory drift gate.
      // #3 G10 — `push` classifies that rejection as `GitPushRejectedError` → 409
      // `conflict` ("fetch/import and re-commit"), not the opaque 502 it once was.
      await provider.push(checkout, workingBranch);
      return WorkspaceGitCommitResultSchema.parse({
        committed: true,
        branch: workingBranch,
        commitSha,
        files: writtenPaths,
      });
    });

    return { commit: result };
  });

  /**
   * #3 G10 — the ADVISORY DRIFT report: which resources have UNCOMMITTED changes
   * vs the studio working branch (the read-only, commit-direction dual of
   * import-preview). Drift is advisory (settled #662): the real serialization
   * point is push non-fast-forward / PR-merge, so this never blocks anything —
   * it answers "what would my next Commit change".
   *
   * BASE selection MIRRORS the Commit route exactly (working-branch tip if it
   * exists, else the collaboration-branch tip, else `null` — nothing committed
   * yet, so every DB resource is `added`), so drift is measured against precisely
   * what the next Commit would base on. Fetch-first (shared `ensureCheckoutFetched`)
   * so the base refs are current; the read runs entirely from the git OBJECT
   * store (`lsTreeManaged` + `showBlob` inside `readWorkspaceFilesAtRef`), never
   * touching the HEAD/index the Commit path owns, so it is safe in the same
   * per-owner `KeyedQueue` slot.
   *
   * Equality is the canonical CONTENT FORM (`computeDrift` → `content-form.ts`),
   * NOT byte/blob equality: a re-mint that only bumps a volatile field (a new
   * immutable version id/number, a `node.position` drag) is NOT drift. A git
   * failure surfaces as the existing `git_error` 502 (fail-safe — never a silent
   * `clean`). A committed file that would not parse becomes a VISIBLE
   * `diagnostic` (never dropped, never manufactured as a match — #473/#664
   * shape), and #1043 gave a DB reference that cannot be put in resourceId-space
   * the SAME treatment: a live pipeline's head can name a hard-deleted
   * connection after two ordinary acts (versions are immutable; the delete has
   * no FK to stop it), which used to throw out of `serializeWorkspace` and 500
   * this whole read-only report. Refusing is the right polarity for a COMMIT and
   * wrong for a read, so the read reports what it could not compare and stays
   * fail-safe on the flag.
   */
  fastify.post('/api/workspace/git/drift', async (request) => {
    const ownerId = request.principal.ownerId;

    const drift = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      const provider = await resolveProvider(ownerId);

      // Fetch first (records the same tracking the fetch route does) so the base
      // refs are current; a fetch failure records + rethrows before any drift work.
      const updated = await ensureCheckoutFetched(db, provider, workspaceGitRoot, ownerId, row);
      return (await driftReport(provider, ownerId, updated)).drift;
    });

    return { drift };
  });

  /**
   * #3 G10 — the PROACTIVE descendant guard (settled #662): has the
   * COLLABORATION branch moved relative to the commit the DB was last imported
   * from? ADVISORY, the commit-source-side complement to slice-2's REACTIVE
   * push-conflict classification — it never blocks (the real serialization point
   * is push non-fast-forward / PR-merge), it answers "is my imported base stale".
   *
   * BASE = the persisted `importedFromCommit` (the collab commit the last
   * non-refused import read from), DELIBERATELY not collab-HEAD: guarding against
   * the current head would flag every feature branch as diverged the moment
   * collab advanced (#662 — "NOT collab-HEAD, that defeats feature branches").
   *
   * The git-independent cases (no base, no head, equal heads) are decided by the
   * pure `precheckDivergence`; only a genuine head DIFFERENCE runs the one
   * `merge-base --is-ancestor` OBJECT-STORE read that splits `behind` (the base
   * is an ancestor of the head — a fast-forward) from `diverged` (a rewrite). A
   * `null` collab head folds into `unknown` — it is the empty-repo state AND the
   * deleted-since-import state, indistinguishable from a null and already
   * surfaced by the main status' `collab_branch_missing`. A missing/pruned base
   * makes `isAncestor` THROW → the existing `git_error` 502 (fail-safe — never a
   * manufactured `current`/`behind`, the #473 / merge-gate posture). Fetch-first
   * so the head is current; the read never touches HEAD/the index the Commit path
   * owns, so it is safe in the same per-owner `KeyedQueue` slot.
   */
  fastify.post('/api/workspace/git/divergence', async (request) => {
    const ownerId = request.principal.ownerId;

    const divergence = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      const provider = await resolveProvider(ownerId);

      // Fetch first (records the same tracking the fetch route does) so the
      // collab head is current; a fetch failure records + rethrows before any
      // divergence work.
      const updated = await ensureCheckoutFetched(db, provider, workspaceGitRoot, ownerId, row);
      return divergenceReport(provider, ownerId, updated);
    });

    return { divergence };
  });

  /**
   * #1476 OR28 — the editor badge's git reading: drift (which pipelines differ
   * from the working branch) and divergence (has the collaboration branch moved
   * since the last import), in one read.
   *
   * The REFRESH POLICY is the point of this route. `/drift` and `/divergence`
   * fetch the remote on every call, which is right for an explicit "Check" and
   * wrong for a badge read on every open, focus and save. Here the fetch runs
   * only when the checkout's copy is older than `fetchMaxAgeMs` (hoster config,
   * `GIT_FETCH_MAX_AGE_SECONDS`), or the checkout is missing (a wiped checkout
   * must re-clone, not 502 until the window passes). The comparison itself is
   * local and runs every call, so a save shows as uncommitted at once. The
   * answer carries `fetchedAt` so it says how old its view of the remote is.
   *
   * A failed fetch — now, or recorded within the window — answers `sync: null`:
   * comparing against refs a fetch could not refresh would claim a state nobody
   * read. The failure itself is on the row (`lastFetchError`), where the status
   * read already reports it. An error state waits out the window like any
   * other, so a remote that is down is not re-fetched on every focus while each
   * attempt holds the owner's queue.
   *
   * POST, like `/drift`: it may fetch, which writes the row's fetch tracking.
   */
  fastify.post('/api/workspace/git/sync', async (request) => {
    const ownerId = request.principal.ownerId;

    const sync = await queue.run(ownerId, async () => {
      let row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      const provider = await resolveProvider(ownerId);

      const checkoutPresent = existsSync(join(checkoutDirFor(workspaceGitRoot, ownerId), '.git'));
      const stale = isStale(row.lastFetchAt, opts.fetchMaxAgeMs);
      // A missing checkout re-clones at once — unless it is missing because the
      // last clone FAILED, which waits out the window like any failed fetch.
      const fetched = stale || (!checkoutPresent && row.lastFetchError === null);
      if (fetched) {
        try {
          row = await ensureCheckoutFetched(db, provider, workspaceGitRoot, ownerId, row);
        } catch (err) {
          // Recorded on the row by `ensureCheckoutFetched`; anything else is a
          // real fault and keeps its status code.
          if (err instanceof GitOperationError || err instanceof GitUnavailableError) return null;
          throw err;
        }
      }
      if (row.lastFetchError !== null || row.lastFetchAt === null) return null;

      const { drift, baseBranch, uncomparable } = await driftReport(provider, ownerId, row);
      const divergence = await divergenceReport(provider, ownerId, row);

      // Drift names resources by their stable `resourceId`; the editor knows its
      // pipeline by row id. Archived rows are included: an archived pipeline is
      // left out of the serialized workspace, so one still on the branch is
      // `removed`, and its editor should say so.
      const pipelineIdByResource = new Map(
        listPipelines(db, ownerId).map((p) => [p.resourceId, p.id] as const),
      );
      const pipelines: WorkspaceGitPipelineDrift[] = [];
      for (const c of drift.changes) {
        const pipelineId =
          c.kind === 'pipeline' && c.resourceId !== null
            ? pipelineIdByResource.get(c.resourceId)
            : undefined;
        if (pipelineId !== undefined) pipelines.push({ pipelineId, change: c.change });
      }
      for (const u of uncomparable) {
        const pipelineId =
          u.kind === 'pipeline' ? pipelineIdByResource.get(u.resourceId) : undefined;
        if (pipelineId !== undefined) pipelines.push({ pipelineId, change: 'uncomparable' });
      }

      return WorkspaceGitSyncSchema.parse({
        fetchedAt: row.lastFetchAt,
        fetched,
        workingBranch: row.workingBranch,
        base: drift.base,
        baseBranch,
        hasUncommittedChanges: drift.hasUncommittedChanges,
        pipelines,
        divergence,
      });
    });

    return { sync };
  });

  /**
   * #3 G9a — feature-branch SELECTION: set which working branch the workspace
   * commits to and opens PRs from. Runs inside the per-owner queue so it can't
   * interleave with a concurrent commit that reads `working_branch` mid-flight.
   * The branch value is policy-validated at the boundary (`SetWorkingBranchBody`)
   * and the repo setter is the ONLY post-connect field mutation.
   */
  fastify.post('/api/workspace/git/working-branch', async (request) => {
    const body = SetWorkingBranchBodySchema.parse(request.body);
    const ownerId = request.principal.ownerId;

    const updated = await queue.run(ownerId, async () => {
      const row = updateWorkspaceGitWorkingBranch(db, ownerId, body.workingBranch);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      return row;
    });

    return { git: statusOf(db, updated) };
  });

  /**
   * #3 G10 — STORE (or replace) the per-workspace git token. The token is
   * ENCRYPTED AT REST under the boot master key (`secrets/secrets.ts`, the SAME
   * crypto connection secrets use) and is NEVER returned to the client: the
   * response is the normal status shape, whose `hasStoredToken:true` is the only
   * acknowledgement. Once stored it takes PRECEDENCE over the operator-env token
   * for both git transport and REST PR-open (see `resolveEffectiveToken`).
   *
   * Security model: the token is set only by the authenticated principal (route
   * auth), validated at the boundary (`WorkspaceGitTokenSchema` — non-empty,
   * length-capped, no control chars, the last blocking a CR/LF header-injection
   * on the REST path). It is stored on the owner's `workspace_git` row, so a
   * disconnect (`DELETE /api/workspace/git`) drops it with the row — no orphaned
   * ciphertext (why a column, not the name-addressable secret store). Requires a
   * connected workspace (404 otherwise). Runs in the per-owner queue so it
   * serializes against a concurrent network op resolving the provider.
   */
  fastify.put('/api/workspace/git/token', async (request) => {
    const body = SetWorkspaceGitTokenBodySchema.parse(request.body);
    const ownerId = request.principal.ownerId;

    const updated = await queue.run(ownerId, async () => {
      if (!getWorkspaceGit(db, ownerId)) {
        throw new NotFoundError('workspace git connection', ownerId);
      }
      const ciphertext = await encrypt(body.token, masterKey);
      const row = setWorkspaceGitToken(db, ownerId, ciphertext);
      // A new credential may answer what the old one could not.
      pullRequestLookups.delete(ownerId);
      // Non-null: the existence check above ran in the SAME queue slot, so no
      // concurrent disconnect could have removed the row between the two.
      return row!;
    });

    return { git: statusOf(db, updated) };
  });

  /**
   * #3 G10 — CLEAR the stored git token (revert to the operator-env token, or no
   * auth). Idempotent: clearing when none is stored is a no-op that still returns
   * the status. 404 when no workspace is connected.
   */
  fastify.delete('/api/workspace/git/token', async (request) => {
    const ownerId = request.principal.ownerId;

    const updated = await queue.run(ownerId, async () => {
      const row = setWorkspaceGitToken(db, ownerId, null);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      pullRequestLookups.delete(ownerId);
      return row;
    });

    return { git: statusOf(db, updated) };
  });

  /**
   * #3 G9 — open a pull request (working → collab).
   *
   * G9b: when the remote is a GitHub host AND an effective token is present,
   * studio auto-opens (or observes an already-open) PR via the GitHub REST API
   * and returns `mode:'opened'` with the PR's `url`/`number`. Otherwise it falls
   * back to G9a's GUIDED-MANUAL result: a GitHub compare `url` for a GitHub
   * remote (`provider:'github'`), else `url:null` + the branch pair
   * (`provider:'unknown'`) — the user opens the PR by hand.
   *
   * NOT in the per-owner `KeyedQueue`: this touches no checkout/index (a pure DB
   * read + an outbound host call), and the host call is bounded (~20s) —
   * borrowing the queue slot would needlessly block a concurrent commit/fetch for
   * the whole network round-trip. The branch pair is a point-in-time snapshot; a
   * concurrent working-branch change simply targets the next PR. 404s when no
   * repo is connected, matching the fetch/commit routes.
   *
   * Security model: the effective token is the per-workspace STORED token
   * (#3 G10 — encrypted at rest, decrypted in-process here) if set, else the
   * operator-env token (`resolveEffectiveToken`, stored ▸ env). Whichever it is,
   * it is used only in-process, never returned to the client, and redacted on
   * every host-API error path (`git/github-host.ts`). `owner`/`repo` come from
   * the connect-allowlisted `repoUrl` (parsed once in `resolvePullRequestTarget`)
   * and are URL-encoded into the host request; all host-API failures surface as
   * token-redacted 502/409 errors.
   */
  fastify.post('/api/workspace/git/pull-request', async (request) => {
    const ownerId = request.principal.ownerId;
    const row = getWorkspaceGit(db, ownerId);
    if (!row) throw new NotFoundError('workspace git connection', ownerId);

    const target = resolvePullRequestTarget(row.repoUrl, row.collabBranch, row.workingBranch);
    // #3 G10 — the SAME effective token (stored ▸ env) that authenticates git
    // transport also opens the PR, via the shared resolver — so a stored-token-
    // only operator auto-opens rather than silently dropping to guided-manual.
    // Out-of-queue (this handler is deliberately unqueued, a point-in-time
    // snapshot); a decrypt failure hard-fails here too (never a silent fallback).
    const effectiveToken = await resolveEffectiveToken(ownerId);

    // Auto-open via the host API only for a GitHub remote WITH a token.
    if (target.provider === 'github' && target.githubRepo !== null && effectiveToken !== null) {
      const opened = await hostClient.openPullRequest({
        repo: target.githubRepo,
        base: row.collabBranch,
        head: row.workingBranch,
        title: `Studio changes: ${row.workingBranch}`,
        body: `Opened by Autonomy Studio from working branch \`${row.workingBranch}\` into \`${row.collabBranch}\`.`,
        token: effectiveToken,
      });
      // The badge's cached "none" is now wrong: ask again on the next read.
      pullRequestLookups.delete(ownerId);
      const pullRequest = PullRequestResultSchema.parse({
        mode: 'opened',
        provider: 'github',
        url: opened.htmlUrl,
        number: opened.number,
        workingBranch: row.workingBranch,
        collabBranch: row.collabBranch,
      });
      return { pullRequest };
    }

    // Guided-manual fallback (no token, or a non-GitHub / local remote).
    const pullRequest = PullRequestResultSchema.parse({
      mode: 'guided_manual',
      provider: target.provider,
      url: target.compareUrl,
      number: null,
      workingBranch: row.workingBranch,
      collabBranch: row.collabBranch,
    });
    return { pullRequest };
  });

  /**
   * #1476 OR28 — the editor badge's `PR #n`: is a pull request open from the
   * working branch? Into ANY base, not only the collaboration branch: the
   * question is "does this branch have a PR", and a PR into another branch is
   * still one.
   *
   * ABSENT RATHER THAN WRONG. Only a host answer is ever `none`. A local or
   * non-GitHub remote is `unsupported_host` and a GitHub remote with no token
   * is `no_token` — neither asks the host. A failed host call is
   * `lookup_failed` with its (token-redacted) message, at 200: the badge reads
   * this on every focus, and a host outage is a state to show, not a fault.
   *
   * The PROVIDER is the workspace's own repo URL, as for the POST below:
   * `resolvePullRequestTarget` reads the host from it and `GitHostClient` is
   * the seam another host plugs into. There is no separate per-workspace
   * provider setting to drift from the URL.
   *
   * REFRESH POLICY: one host call per owner per `fetchMaxAgeMs`
   * (`GIT_FETCH_MAX_AGE_SECONDS`, the hoster's "how often the server contacts
   * the remote" — the same window `/sync` fetches on), shared by concurrent
   * reads, and a failure waits out the window too so a host that is down is
   * not asked on every focus. Opening a PR here, changing the stored token or
   * disconnecting drops the cached answer; a new working branch or repo is a
   * different question and misses the cache by its key.
   *
   * NOT queued, like the POST: no checkout is touched and the host call is
   * bounded. Owner-scoped: the row, the token and the cache entry are all the
   * principal's own.
   */
  fastify.get('/api/workspace/git/pull-request', async (request) => {
    const ownerId = request.principal.ownerId;
    const row = getWorkspaceGit(db, ownerId);
    if (!row) throw new NotFoundError('workspace git connection', ownerId);

    const { repoUrl, workingBranch } = row;
    const answer = (reading: WorkspaceGitPullRequestReading) => ({
      pullRequest: WorkspaceGitPullRequestReadingSchema.parse(reading),
    });

    const target = resolvePullRequestTarget(row.repoUrl, row.collabBranch, workingBranch);
    if (target.provider !== 'github' || target.githubRepo === null) {
      return answer({
        state: 'unknown',
        repoUrl,
        workingBranch,
        reason: 'unsupported_host',
        detail: null,
      });
    }
    // Before the cache: a stored token that will not decrypt hard-fails (500)
    // on every read, as on the POST, rather than serving an older answer.
    const token = await resolveEffectiveToken(ownerId);
    if (token === null) {
      return answer({ state: 'unknown', repoUrl, workingBranch, reason: 'no_token', detail: null });
    }

    // The token is in the key (hashed — the key is never sent anywhere), so an
    // answer got with another credential is a miss even when a lookup started
    // before a token change lands after it.
    const key = `${repoUrl}\n${workingBranch}\n${sha256Hex(token)}`;
    const cached = pullRequestLookups.get(ownerId);
    if (cached !== undefined && cached.key === key && !isStale(cached.at, opts.fetchMaxAgeMs)) {
      return answer(await cached.reading);
    }

    const reading = hostClient
      .findOpenPullRequest({ repo: target.githubRepo, head: workingBranch, token })
      .then(
        (pr): WorkspaceGitPullRequestReading =>
          pr === null
            ? { state: 'none', repoUrl, workingBranch, checkedAt: Date.now() }
            : {
                state: 'open',
                repoUrl,
                workingBranch,
                number: pr.number,
                url: pr.htmlUrl,
                checkedAt: Date.now(),
              },
        (err: unknown): WorkspaceGitPullRequestReading => {
          if (err instanceof GitHostApiError) {
            return {
              state: 'unknown',
              repoUrl,
              workingBranch,
              reason: 'lookup_failed',
              // The client already redacts; this is the route's own guard, as
              // the detail is the one host-authored string sent to the browser.
              detail: redactSecrets(err.message, [token]),
            };
          }
          throw err;
        },
      );
    const entry = { key, at: Date.now(), reading };
    pullRequestLookups.set(ownerId, entry);
    try {
      return answer(await reading);
    } catch (err) {
      // A fault that is not the host's answer is evicted, never kept: the next
      // read asks again (a read already sharing this promise fails with it).
      if (pullRequestLookups.get(ownerId) === entry) pullRequestLookups.delete(ownerId);
      throw err;
    }
  });

  fastify.post('/api/workspace/git/import-preview', async (request) => {
    const ownerId = request.principal.ownerId;

    const preview = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      const provider = await resolveProvider(ownerId);

      // Fetch first (shared with the fetch/commit routes) so the preview reflects
      // the current collaboration branch; the returned row carries the RESOLVED
      // collab head we read the snapshot at. The classify READS DB rows (via
      // `serializeWorkspace`) but WRITES nothing — the transactional apply of the
      // dispositions is G5c.
      const updated = await ensureCheckoutFetched(db, provider, workspaceGitRoot, ownerId, row);
      const head = updated.observedCollabHead;
      if (head === null) {
        // No collaboration branch yet (empty repo / pre-first-push) — nothing to
        // preview, not an error.
        return WorkspaceGitImportPreviewSchema.parse({
          head: null,
          resources: [],
          archive: [],
          diagnostics: [],
        });
      }

      const checkout = checkoutDirFor(workspaceGitRoot, ownerId);
      const { files, unreadable } = await readWorkspaceFilesAtRef(
        provider,
        checkout,
        head,
        MANAGED_DIRS,
      );
      // An unreadable managed file (#664) becomes a per-file `unreadable`
      // diagnostic here rather than 502ing the whole preview.
      const incoming = parseWorkspaceFiles(files, unreadable);

      // Diff against the DB working copy run through the IDENTICAL serialize+parse
      // path, so both sides get the same volatile treatment and #666's
      // archived-omission flows into the baseline for free.
      // #1043 — TOLERANT, and the offenders are dropped from `incoming` too.
      // Excluding them from the DB side alone would classify the branch's file
      // for such a pipeline as `create`, for a resource that plainly exists. The
      // ARCHIVE proposals need no equivalent care: they iterate the DB side,
      // which the tolerant serialize has already emptied of offenders — so an
      // offender absent from the branch is not proposed for archive here, and
      // the apply does not archive it either (same reason, same snapshot). That
      // parity is the point; see the apply for why neither of them refuses.
      const serialized = serializeWorkspaceTolerant(db, ownerId);
      const dbSnapshot = parseWorkspaceFiles(serialized.files);
      const uncomparable = new Set(
        serialized.unserializable.map((o) => `${o.kind}:${o.resourceId}`),
      );
      // #3 G7 — the trigger-binding resolution domain (all owned versions incl.
      // archived; not derivable from the latest-only serialized snapshot), so the
      // preview normalizes a dangling binding identically to the apply. #3 G8b-3 —
      // plus the readiness domain (owned versions whose connections are all ready),
      // so the preview folds a bound-but-unready trigger's `enabled`→false exactly
      // as the apply's forward gate would. #983 — plus the stored form of the
      // versions the branch NAMES, so a pipeline pinned to a version this
      // workspace has authored past previews as `superseded` rather than as an
      // `update` that will not happen.
      //
      // These three keep the preview in step with the apply on the domains they
      // cover; they do not make the two identical, and the exceptions are worth
      // naming rather than leaving a flat parity claim to be believed:
      //   - an ARCHIVED pipeline whose file is on the branch previews as `create`
      //     (the serialize baseline omits archived rows, #666) where the apply
      //     reports `restored`. Superseded is likewise unreachable for one.
      //   - the two version-id contradictions the apply REFUSES (an id owned by
      //     another pipeline; an owned id whose content was hand-edited) preview
      //     as `update` — see `supersedes` in `workspace-reconcile.ts`.
      const branchVersionRids = new Set<string>();
      for (const pipeline of incoming.pipelines) {
        const rid = latestVersion(pipeline)?.resourceId;
        if (rid != null) branchVersionRids.add(rid);
      }
      const plan = classifyWorkspace(
        // Only `incoming` is filtered: `dbSnapshot` is built from the tolerant
        // serialize's own files, which never contained the offenders — filtering
        // it too would be a no-op that reads as if it might not be.
        dbSnapshot,
        withoutResources(incoming, uncomparable),
        listVersionResourceIds(db, ownerId),
        readyVersionResourceIds(db, ownerId),
        ownedVersionForms(db, ownerId, branchVersionRids),
      );

      return WorkspaceGitImportPreviewSchema.parse({
        head,
        resources: plan.resources,
        archive: plan.archive,
        // #1043 — appended to the RESPONSE, deliberately not folded into
        // `incoming.diagnostics`: that array is the branch-corrupt signal the
        // apply refuses on (`workspace-apply.ts`), and this is not that. A
        // DB-side gap under-reports (one resource is not compared and not
        // archived); it never destroys anything, so it must not acquire a
        // branch-corrupt refusal's teeth by sharing its channel.
        diagnostics: [
          ...incoming.diagnostics,
          ...serialized.unserializable.map(unserializableDiagnostic),
          // #844 GL6 — the branch globals the apply will not write (type conflict).
          ...plan.diagnostics,
        ],
      });
    });

    return { preview };
  });

  /**
   * #3 G5c — APPLY the branch into the DB working copy (the transactional
   * write-path the preview describes). Fetch first (shared with fetch/preview),
   * read the collab-branch snapshot, then `applyWorkspace` reconciles it inside
   * ONE `db.transaction`: connections + pipelines (create/restore/update/rename)
   * + archive, and — as of G5c-2 (#670) — TRIGGERS (create/update/rename, with
   * binding remap + mode-consistency forcing). A parse diagnostic REFUSES the
   * whole import (fail-closed). The `scheduler.sync()` below both drops the
   * wakeups of triggers an archive disabled AND registers the wakeups of any
   * enabled schedule/tumbling trigger this import just applied (the idempotent
   * composite reconciler; same contract the pipeline archive + trigger routes
   * use) — run OUTSIDE the queue's tx, as the alarm clock owns its own db handle.
   */
  fastify.post('/api/workspace/git/import', async (request) => {
    const ownerId = request.principal.ownerId;

    const result = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      const provider = await resolveProvider(ownerId);

      const updated = await ensureCheckoutFetched(db, provider, workspaceGitRoot, ownerId, row);
      const head = updated.observedCollabHead;
      if (head === null) {
        // No collaboration branch yet (empty repo) — nothing to import.
        return WorkspaceGitApplyResultSchema.parse({
          head: null,
          refused: false,
          applied: [],
          deferred: [],
          archived: [],
          diagnostics: [],
        });
      }

      const checkout = checkoutDirFor(workspaceGitRoot, ownerId);
      const { files, unreadable } = await readWorkspaceFilesAtRef(
        provider,
        checkout,
        head,
        MANAGED_DIRS,
      );
      // An unreadable managed file (#664) is a diagnostic, so `applyWorkspace`
      // REFUSES the whole import fail-closed (an incomplete snapshot must not
      // archive a pipeline whose file merely failed to read) — never a 502.
      const incoming = parseWorkspaceFiles(files, unreadable);
      // Apply + the `import.applied` audit fact land in ONE transaction:
      // `applyWorkspace`'s own tx nests as a SAVEPOINT inside this outer one, so
      // the audit event (appended after it) commits or rolls back ATOMICALLY
      // with the writes — never a committed import with a lost audit fact (the
      // fail-safe direction). The event is emitted only for an EFFECTFUL import
      // (see `buildImportAppliedEvent`); a refused/empty/no-op import records
      // nothing.
      return db.transaction(() => {
        const applyResult = WorkspaceGitApplyResultSchema.parse(
          // #3 G6b — `row.collabBranch` rides in so every minted version records
          // its git provenance (source commit `head` + branch + file path/blob).
          applyWorkspace(db, ownerId, incoming, head, row.collabBranch),
        );
        const event = buildImportAppliedEvent(applyResult, {
          branch: row.collabBranch,
          by: request.principal.id,
        });
        if (event) appendWorkspaceEvent(db, ownerId, event);
        // #3 G10 — stamp the descendant-guard base atomically with the apply. On
        // every NON-refused import (effectful OR no-op), because both mean the
        // DB was reconciled FROM collab@head, so `head` is a valid ancestry base
        // — advancing it suppresses a false `behind`. This is broader than the
        // effectful-only `import.applied` audit event (which stays quiet on a
        // no-op by design); a refused import applied nothing, so it must not move
        // the base. `head` is non-null here (the empty-repo path early-returned).
        if (!applyResult.refused) updateWorkspaceGitImportedCommit(db, ownerId, head);
        return applyResult;
      });
    });

    // Reconcile the scheduler AFTER the tx commits: an archive disabled its
    // dependent triggers (drop their pending wakeups) AND — as of G5c-2 — this
    // import may have APPLIED an enabled schedule/tumbling trigger whose wakeup
    // must now be seeded. `sync()` is a full drop+seed reconcile, so it does
    // both; idempotent, so calling it on a no-op import is harmless.
    if (!result.refused) fastify.scheduler.sync();

    return { import: result };
  });

  fastify.delete('/api/workspace/git', async (request, reply) => {
    const ownerId = request.principal.ownerId;

    await queue.run(ownerId, async () => {
      if (!deleteWorkspaceGit(db, ownerId)) {
        throw new NotFoundError('workspace git connection', ownerId);
      }
      pullRequestLookups.delete(ownerId);
      // Row first, then dir: if the rm fails midway the leftover dir is an
      // orphan the next connect clears (the reverse order would leave a LIVE
      // row pointing at a missing checkout — also healed, by fetch's
      // re-clone, but an orphan dir is the cheaper debris). A cleanup failure
      // is therefore logged, NOT surfaced: the connection IS gone at this
      // point, and a 500 here would be a lie whose retry then 404s.
      try {
        await removeCheckoutDir(workspaceGitRoot, ownerId);
      } catch (err) {
        request.log.warn(
          { err },
          'workspace git checkout cleanup failed after disconnect; orphan dir left for the next connect to clear',
        );
      }
    });

    reply.status(204).send();
  });
};
