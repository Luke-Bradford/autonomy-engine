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

export function deleteWorkspaceGit(db: Db, ownerId: string): boolean {
  const result = db.delete(workspaceGit).where(eq(workspaceGit.ownerId, ownerId)).run();
  return result.changes > 0;
}
