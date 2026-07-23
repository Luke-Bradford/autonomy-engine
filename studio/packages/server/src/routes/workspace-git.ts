import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import {
  ConnectWorkspaceGitBodySchema,
  deriveWorkspaceGitState,
  WorkspaceGitStatusSchema,
  type WorkspaceGit,
} from '@autonomy-studio/shared';
import {
  createWorkspaceGit,
  deleteWorkspaceGit,
  getWorkspaceGit,
  updateWorkspaceGitSync,
  WorkspaceGitAlreadyConnectedError,
} from '../repo/index.js';
import { checkoutDirFor, removeCheckoutDir } from '../git/checkout.js';
import {
  CliGitProvider,
  GitOperationError,
  GitUnavailableError,
  type GitProvider,
} from '../git/provider.js';
import { KeyedQueue } from '../git/queue.js';
import { NotFoundError } from '../errors.js';

/**
 * #3 G2 — connect/status/fetch/disconnect for the workspace↔git association.
 *
 * Every git-touching handler runs inside the per-owner `KeyedQueue`, so a
 * concurrent connect/fetch/disconnect can never interleave filesystem work on
 * the same managed checkout. The checkout is DERIVED state throughout:
 * connect clears any orphaned dir before cloning (no row ⇒ the dir is a
 * crash-mid-clone leftover by definition), fetch re-clones a wiped checkout,
 * disconnect removes it — every divergence between row and disk self-heals.
 *
 * Security model: `repoUrl`/`collabBranch` are user input validated by the
 * shared allowlist schemas (scheme allowlist, no embedded credentials,
 * check-ref-format branch shape) BEFORE reaching a git argv; ownerId comes
 * from `request.principal`, never the client; git runs with the master-key
 * env vars stripped and can never prompt (see `git/provider.ts`).
 */

export interface WorkspaceGitRoutesOptions {
  workspaceGitRoot: string;
  /** Test seam; defaults to a real `CliGitProvider`. */
  provider?: GitProvider;
}

function statusOf(row: WorkspaceGit) {
  return WorkspaceGitStatusSchema.parse({ ...row, state: deriveWorkspaceGitState(row) });
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
      return createWorkspaceGit(db, {
        ownerId,
        repoUrl: body.repoUrl,
        collabBranch: body.collabBranch,
        observedCollabHead: head,
        lastFetchAt: Date.now(),
        lastFetchError: null,
      });
    });

    reply.status(201).send({ git: statusOf(row) });
  });

  fastify.post('/api/workspace/git/fetch', async (request) => {
    const ownerId = request.principal.ownerId;

    const updated = await queue.run(ownerId, async () => {
      const row = getWorkspaceGit(db, ownerId);
      if (!row) throw new NotFoundError('workspace git connection', ownerId);

      const checkout = checkoutDirFor(workspaceGitRoot, ownerId);
      try {
        // The checkout is derived state: if it was wiped (operator cleanup,
        // disk recovery), re-clone rather than failing forever.
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
        });
      } catch (err) {
        // Record the failure on the row (state → fetch_error) AND rethrow —
        // the caller gets the honest 502, the row remembers it for the next
        // GET. ONLY provider-error messages are recorded verbatim: they are
        // client-safe by construction (redacted at the provider). Anything
        // else (an fs errno from the recovery path, say) would quote
        // server-internal absolute paths — GET surfaces this field, so those
        // get a fixed string, mirroring errors.ts's no-raw-message rule.
        const clientSafe = err instanceof GitOperationError || err instanceof GitUnavailableError;
        updateWorkspaceGitSync(db, ownerId, {
          observedCollabHead: row.observedCollabHead,
          lastFetchAt: Date.now(),
          lastFetchError: clientSafe ? (err as Error).message : 'internal error during fetch',
        });
        throw err;
      }
    });

    // `updated` is non-null here: the row existed inside the same queue slot,
    // and only this route's queue serializes deletes for this owner.
    return { git: statusOf(updated!) };
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
