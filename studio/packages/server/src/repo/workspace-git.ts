import { eq } from 'drizzle-orm';
import { WorkspaceGitSchema, type WorkspaceGit } from '@autonomy-studio/shared';
import { workspaceGit } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

/**
 * #3 G2 — the `workspace_git` row (ONE per owner; the DB unique index is the
 * authority, see the 0025 migration). Reads re-parse through
 * `WorkspaceGitSchema` — the boundary check that catches a corrupt row
 * instead of trusting whatever Drizzle handed back (same discipline as every
 * other repo module).
 *
 * Thrown by the connect route when a row already exists — a workspace is
 * never silently re-pointed at a different repo; disconnect explicitly first.
 */
export class WorkspaceGitAlreadyConnectedError extends Error {
  constructor() {
    super('a git repo is already connected to this workspace — disconnect it first');
    this.name = 'WorkspaceGitAlreadyConnectedError';
  }
}

export interface NewWorkspaceGit {
  ownerId: string;
  repoUrl: string;
  collabBranch: string;
  /** #3 G9a — the initial working branch (connect seeds `deriveDefaultWorkingBranch`). */
  workingBranch: string;
  observedCollabHead: string | null;
  lastFetchAt: number | null;
  lastFetchError: string | null;
}

export function createWorkspaceGit(db: Db, input: NewWorkspaceGit): WorkspaceGit {
  const now = Date.now();
  const row: WorkspaceGit = {
    id: newId('wsgit'),
    ...input,
    // #3 G10 — a fresh connection has never imported: the descendant-guard base
    // is stated null (not derived from the fetch head — that would fabricate an
    // import that never happened), advanced only by the import route. #473.
    importedFromCommit: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workspaceGit).values(row).run();
  return WorkspaceGitSchema.parse(row);
}

export function getWorkspaceGit(db: Db, ownerId: string): WorkspaceGit | null {
  const row = db.select().from(workspaceGit).where(eq(workspaceGit.ownerId, ownerId)).get();
  return row ? WorkspaceGitSchema.parse(row) : null;
}

/**
 * Updates ONLY the sync-tracking fields. `repoUrl`/`collabBranch` are fixed at
 * connect (re-pointing = disconnect + connect, never a mutation); the sole
 * post-connect-mutable field is `working_branch` (#3 G9a), which has its OWN
 * narrow setter (`updateWorkspaceGitWorkingBranch`) — so no generic patch
 * surface exists for any field to drift through.
 */
export function updateWorkspaceGitSync(
  db: Db,
  ownerId: string,
  sync: {
    observedCollabHead: string | null;
    lastFetchAt: number | null;
    lastFetchError: string | null;
  },
): WorkspaceGit | null {
  const existing = getWorkspaceGit(db, ownerId);
  if (!existing) return null;
  const updated = WorkspaceGitSchema.parse({ ...existing, ...sync, updatedAt: Date.now() });
  db.update(workspaceGit).set(updated).where(eq(workspaceGit.ownerId, ownerId)).run();
  return updated;
}

/**
 * #3 G9a — set the working branch (feature-branch selection). The ONLY
 * post-connect field mutation; the branch value is policy-validated at the route
 * boundary (`SetWorkingBranchBodySchema`) before it reaches here. Returns the
 * updated row, or `null` when no connection exists for the owner.
 */
export function updateWorkspaceGitWorkingBranch(
  db: Db,
  ownerId: string,
  workingBranch: string,
): WorkspaceGit | null {
  const existing = getWorkspaceGit(db, ownerId);
  if (!existing) return null;
  const updated = WorkspaceGitSchema.parse({ ...existing, workingBranch, updatedAt: Date.now() });
  db.update(workspaceGit).set(updated).where(eq(workspaceGit.ownerId, ownerId)).run();
  return updated;
}

/**
 * #3 G10 — record the collab commit the most recent non-refused import read
 * from (the proactive descendant-guard base, #662). Called INSIDE the import
 * route's transaction so the stamp is atomic with the apply — never a committed
 * import with a stale/lost base. This narrow single-field setter carries every
 * OTHER field forward from the read snapshot via the `{...existing}` spread
 * (touching only the base + `updatedAt`); no-clobber against a concurrent
 * fetch/commit is guaranteed by the per-owner `KeyedQueue` serializing all
 * writes for an owner (the same posture as `updateWorkspaceGitSync`/
 * `...WorkingBranch`), not by the spread itself. Returns the updated row, or
 * `null` when no connection exists for the owner.
 */
export function updateWorkspaceGitImportedCommit(
  db: Db,
  ownerId: string,
  importedFromCommit: string,
): WorkspaceGit | null {
  const existing = getWorkspaceGit(db, ownerId);
  if (!existing) return null;
  const updated = WorkspaceGitSchema.parse({
    ...existing,
    importedFromCommit,
    updatedAt: Date.now(),
  });
  db.update(workspaceGit).set(updated).where(eq(workspaceGit.ownerId, ownerId)).run();
  return updated;
}

export function deleteWorkspaceGit(db: Db, ownerId: string): boolean {
  const result = db.delete(workspaceGit).where(eq(workspaceGit.ownerId, ownerId)).run();
  return result.changes > 0;
}

/**
 * #3 G10 — read the owner's STORED git token as the raw ENCRYPTED blob (an
 * XChaCha20-Poly1305 ciphertext from `secrets/secrets.ts::encrypt`), or `null`
 * when none is stored. Server-only, and DELIBERATELY not routed through
 * `getWorkspaceGit`/`WorkspaceGitSchema` (which strip the column): this is the
 * SOLE reader of `git_token_encrypted`, selecting ONLY that column so the
 * ciphertext has exactly one escape point, decrypted in-process at dispatch.
 * The caller (`resolveEffectiveToken`) decrypts under `fastify.masterKey`.
 */
export function getWorkspaceGitToken(db: Db, ownerId: string): string | null {
  const row = db
    .select({ token: workspaceGit.gitTokenEncrypted })
    .from(workspaceGit)
    .where(eq(workspaceGit.ownerId, ownerId))
    .get();
  return row?.token ?? null;
}

/** #3 G10 — whether the owner has a stored git token (the client-facing
 * `hasStoredToken` signal). A column-PRESENCE check: it reuses the sole reader
 * `getWorkspaceGitToken` to fetch the ciphertext blob, but only tests it for
 * null — the ciphertext is never DECRYPTED and is discarded immediately. */
export function workspaceGitTokenPresent(db: Db, ownerId: string): boolean {
  return getWorkspaceGitToken(db, ownerId) !== null;
}

/**
 * #3 G10 — set (encrypted blob) or CLEAR (`null`) the owner's stored git token.
 * Writes the `git_token_encrypted` column DIRECTLY (never through
 * `WorkspaceGitSchema`, which cannot carry it), touching only that column plus
 * `updatedAt` — so a token set/clear never disturbs any tracking field, and,
 * conversely, `updateWorkspaceGitSync`/`...WorkingBranch` (which `.set` a parsed,
 * token-free row) never disturb the token column (Drizzle `.set` updates only
 * the provided keys). Returns the refreshed (token-free) row, or `null` when no
 * connection exists for the owner. Callers serialize via the per-owner
 * `KeyedQueue` (the same posture as the other row writers).
 */
export function setWorkspaceGitToken(
  db: Db,
  ownerId: string,
  encryptedBlob: string | null,
): WorkspaceGit | null {
  const existing = getWorkspaceGit(db, ownerId);
  if (!existing) return null;
  db.update(workspaceGit)
    .set({ gitTokenEncrypted: encryptedBlob, updatedAt: Date.now() })
    .where(eq(workspaceGit.ownerId, ownerId))
    .run();
  return getWorkspaceGit(db, ownerId);
}
