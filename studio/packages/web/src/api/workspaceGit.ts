import { z } from 'zod';
import {
  CommitWorkspaceGitBodySchema,
  ConnectWorkspaceGitBodySchema,
  SetWorkspaceGitTokenBodySchema,
  WorkspaceGitCommitResultSchema,
  WorkspaceGitDriftSchema,
  WorkspaceGitStatusSchema,
  type CommitWorkspaceGitBody,
  type ConnectWorkspaceGitBody,
  type SetWorkspaceGitTokenBody,
  type WorkspaceGitCommitResult,
  type WorkspaceGitDrift,
  type WorkspaceGitStatus,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * #3 G10 / U18 slice 1 — the client half of the workspace-git subsystem.
 *
 * The server has carried these routes since the G-series; nothing in the web
 * app called them, so the whole commit/publish path was unreachable from the
 * UI. This module is the first client of them (#956).
 *
 * The response ENVELOPES (`{git}`, `{drift}`, `{commit}`) are declared here
 * rather than in `@autonomy-studio/shared` because the server declares them
 * inline too — there is no shared envelope schema to reuse, and inventing one
 * would mean editing the server to import it. The PAYLOAD schemas are the
 * shared ones, which is where the contract actually lives.
 */
const GitEnvelopeSchema = z.object({ git: WorkspaceGitStatusSchema });
const NullableGitEnvelopeSchema = z.object({ git: WorkspaceGitStatusSchema.nullable() });
const DriftEnvelopeSchema = z.object({ drift: WorkspaceGitDriftSchema });
const CommitEnvelopeSchema = z.object({ commit: WorkspaceGitCommitResultSchema });

export {
  CommitWorkspaceGitBodySchema,
  ConnectWorkspaceGitBodySchema,
  SetWorkspaceGitTokenBodySchema,
};

/**
 * The workspace's git connection, or `null` when there is none.
 *
 * `null` is a 200, NOT a 404 — "this workspace has no repo" is the DEFAULT
 * state (git is opt-in, settled #662), not a missing resource. Callers must
 * keep it distinct from "not loaded yet" and from "the read failed": rendering
 * a not-connected surface on an unknown state would manufacture an absent fact
 * (#473).
 */
export function getWorkspaceGit(signal?: AbortSignal): Promise<WorkspaceGitStatus | null> {
  return apiFetch('/api/workspace/git', { schema: NullableGitEnvelopeSchema, signal }).then(
    (r) => r.git,
  );
}

export function connectWorkspaceGit(body: ConnectWorkspaceGitBody): Promise<WorkspaceGitStatus> {
  return apiFetch('/api/workspace/git', {
    method: 'POST',
    body,
    schema: GitEnvelopeSchema,
  }).then((r) => r.git);
}

export function disconnectWorkspaceGit(): Promise<void> {
  return apiFetch<void>('/api/workspace/git', { method: 'DELETE' });
}

/**
 * Re-observe the remote and return the refreshed status.
 *
 * `GET /api/workspace/git` is a pure DB read: `state`, `lastFetchAt` and
 * `lastFetchError` are whatever the last sync recorded, so a repo that became
 * unreachable an hour ago still reads `ready`. This is the only way for the
 * status panel to state a CURRENT fact rather than a remembered one.
 */
export function fetchWorkspaceGit(): Promise<WorkspaceGitStatus> {
  return apiFetch('/api/workspace/git/fetch', {
    method: 'POST',
    schema: GitEnvelopeSchema,
  }).then((r) => r.git);
}

/**
 * Store a git token. Write-only by construction: the ciphertext is stripped
 * from every response and the only signal back is `hasStoredToken`, so there is
 * no read counterpart to this and never will be.
 */
export function setWorkspaceGitToken(body: SetWorkspaceGitTokenBody): Promise<WorkspaceGitStatus> {
  return apiFetch('/api/workspace/git/token', {
    method: 'PUT',
    body,
    schema: GitEnvelopeSchema,
  }).then((r) => r.git);
}

/** Idempotent: clearing an absent token is a success, not an error. */
export function clearWorkspaceGitToken(): Promise<WorkspaceGitStatus> {
  return apiFetch('/api/workspace/git/token', {
    method: 'DELETE',
    schema: GitEnvelopeSchema,
  }).then((r) => r.git);
}

/**
 * The ADVISORY "what would my next Commit change" report (#662 — drift is
 * advisory; the real serialization point is the push).
 *
 * A POST with no body, like `fireTrigger`/`restorePipeline`: it is not a read
 * of a cacheable resource (it re-fetches the remote as a side effect), but it
 * writes nothing the caller names.
 */
export function readWorkspaceGitDrift(): Promise<WorkspaceGitDrift> {
  return apiFetch('/api/workspace/git/drift', {
    method: 'POST',
    schema: DriftEnvelopeSchema,
  }).then((r) => r.drift);
}

/**
 * Commit the workspace working copy to the working branch and push it.
 *
 * This commits the WHOLE workspace — every pipeline, connection and trigger the
 * serializer produces — which is why it is a workspace-level act on the Manage
 * hub rather than a per-pipeline command-bar button.
 *
 * `committed: false` is a legitimate success meaning "the serialization already
 * matched the branch tip"; callers must not render it as a commit.
 */
export function commitWorkspace(body: CommitWorkspaceGitBody): Promise<WorkspaceGitCommitResult> {
  return apiFetch('/api/workspace/git/commit', {
    method: 'POST',
    body,
    schema: CommitEnvelopeSchema,
  }).then((r) => r.commit);
}
