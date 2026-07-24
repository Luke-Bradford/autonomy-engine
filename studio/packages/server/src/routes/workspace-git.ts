import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import {
  CommitWorkspaceGitBodySchema,
  ConnectWorkspaceGitBodySchema,
  MANAGED_DIRS,
  WorkspaceGitBranchSchema,
  WorkspaceGitCommitResultSchema,
  WorkspaceGitApplyResultSchema,
  WorkspaceGitImportPreviewSchema,
  deriveWorkspaceGitState,
  WorkspaceGitStatusSchema,
  type WorkspaceGit,
} from '@autonomy-studio/shared';
import {
  appendWorkspaceEvent,
  createWorkspaceGit,
  deleteWorkspaceGit,
  getWorkspaceGit,
  updateWorkspaceGitSync,
  WorkspaceGitAlreadyConnectedError,
} from '../repo/index.js';
import {
  applyWorkspace,
  buildImportAppliedEvent,
  classifyWorkspace,
  parseWorkspaceFiles,
  serializeWorkspace,
} from '../portability/index.js';
import { checkoutDirFor, removeCheckoutDir } from '../git/checkout.js';
import { readWorkspaceFilesAtRef } from '../git/workspace-read.js';
import {
  CliGitProvider,
  GitOperationError,
  GitUnavailableError,
  type GitProvider,
} from '../git/provider.js';
import { KeyedQueue } from '../git/queue.js';
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
 * The working branch is DERIVED `studio/<ownerId>/work` (G3a) — no client
 * override — and the Commit only ever writes/stages the three studio-managed
 * dirs, never the user's own repo files.
 *
 * The `MANAGED_DIRS` a Commit owns and an import-preview reads come from the
 * shared G1 path policy (single source of truth) — never re-hardcoded here.
 */

export interface WorkspaceGitRoutesOptions {
  workspaceGitRoot: string;
  /** Test seam; defaults to a real `CliGitProvider`. */
  provider?: GitProvider;
}

function statusOf(row: WorkspaceGit) {
  return WorkspaceGitStatusSchema.parse({ ...row, state: deriveWorkspaceGitState(row) });
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
  const { db } = fastify;
  const { workspaceGitRoot } = opts;
  const provider = opts.provider ?? new CliGitProvider();
  const queue = new KeyedQueue();

  fastify.get('/api/workspace/git', async (request) => {
    const row = getWorkspaceGit(db, request.principal.ownerId);
    return { git: row ? statusOf(row) : null };
  });

  fastify.post('/api/workspace/git', async (request, reply) => {
    const body = ConnectWorkspaceGitBodySchema.parse(request.body);
    const ownerId = request.principal.ownerId;

    const row = await queue.run(ownerId, async () => {
      // The row check lives INSIDE the queue so two racing connects serialize
      // (the DB unique index remains the last-line authority regardless).
      if (getWorkspaceGit(db, ownerId)) throw new WorkspaceGitAlreadyConnectedError();

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

    reply.status(201).send({ git: statusOf(row) });
  });

  fastify.post('/api/workspace/git/fetch', async (request) => {
    const ownerId = request.principal.ownerId;

    const updated = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);
      return ensureCheckoutFetched(db, provider, workspaceGitRoot, ownerId, row);
    });

    return { git: statusOf(updated) };
  });

  fastify.post('/api/workspace/git/commit', async (request) => {
    const body = CommitWorkspaceGitBodySchema.parse(request.body);
    const ownerId = request.principal.ownerId;
    const principalId = request.principal.id;
    // DERIVED working branch (G3a) — validated through the same check-ref-format
    // schema every branch crosses, defensively (ownerId is principal-derived).
    const workingBranch = WorkspaceGitBranchSchema.parse(`studio/${ownerId}/work`);

    const result = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);

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

  fastify.post('/api/workspace/git/import-preview', async (request) => {
    const ownerId = request.principal.ownerId;

    const preview = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);

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
      const dbSnapshot = parseWorkspaceFiles(serializeWorkspace(db, ownerId));
      const plan = classifyWorkspace(dbSnapshot, incoming);

      return WorkspaceGitImportPreviewSchema.parse({
        head,
        resources: plan.resources,
        archive: plan.archive,
        diagnostics: incoming.diagnostics,
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
          applyWorkspace(db, ownerId, incoming, head),
        );
        const event = buildImportAppliedEvent(applyResult, {
          branch: row.collabBranch,
          by: request.principal.id,
        });
        if (event) appendWorkspaceEvent(db, ownerId, event);
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
