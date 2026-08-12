import { z } from 'zod';
import {
  CommitWorkspaceGitBodySchema,
  ConnectWorkspaceGitBodySchema,
  SetWorkspaceGitTokenBodySchema,
  WorkspaceGitApplyResultSchema,
  WorkspaceGitCommitResultSchema,
  WorkspaceGitDivergenceSchema,
  WorkspaceGitDriftSchema,
  WorkspaceGitImportPreviewSchema,
  WorkspaceGitStatusSchema,
  type CommitWorkspaceGitBody,
  type ConnectWorkspaceGitBody,
  type SetWorkspaceGitTokenBody,
  type WorkspaceGitAppliedAction,
  type WorkspaceGitApplyResult,
  type WorkspaceGitCommitResult,
  type WorkspaceGitDisposition,
  type WorkspaceGitDivergence,
  type WorkspaceGitDrift,
  type WorkspaceGitDriftChange,
  type WorkspaceGitImportPreview,
  type WorkspaceGitStatus,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * #3 G10 / U18 slices 1-2 — the client half of the workspace-git subsystem.
 *
 * The server has carried these routes since the G-series; nothing in the web
 * app called them, so the whole commit/publish path was unreachable from the
 * UI. This module is the first client of them (#956 outgoing, #962 incoming).
 *
 * The response ENVELOPES (`{git}`, `{drift}`, `{commit}`, `{divergence}`,
 * `{preview}`, `{import}`) are declared here rather than in
 * `@autonomy-studio/shared` because the server declares them inline too — there
 * is no shared envelope schema to reuse, and inventing one would mean editing
 * the server to import it. The PAYLOAD schemas are the shared ones, which is
 * where the contract actually lives.
 */
const GitEnvelopeSchema = z.object({ git: WorkspaceGitStatusSchema });
const NullableGitEnvelopeSchema = z.object({ git: WorkspaceGitStatusSchema.nullable() });
const DriftEnvelopeSchema = z.object({ drift: WorkspaceGitDriftSchema });
const CommitEnvelopeSchema = z.object({ commit: WorkspaceGitCommitResultSchema });
const DivergenceEnvelopeSchema = z.object({ divergence: WorkspaceGitDivergenceSchema });
const PreviewEnvelopeSchema = z.object({ preview: WorkspaceGitImportPreviewSchema });
const ApplyEnvelopeSchema = z.object({ import: WorkspaceGitApplyResultSchema });

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

/**
 * Where this workspace's import base sits relative to the collaboration branch.
 *
 * ADVISORY ONLY, and the server proves it: `/import` never consults divergence.
 * It answers "is there anything to come, and was the history rewritten", which
 * is a thing to TELL the operator, not a gate to hold them behind.
 *
 * The comparison is `importedFromCommit` (the collab commit the last applied
 * import actually read) against the freshly-observed collab head — deliberately
 * not the head against itself, which would always read `current`.
 */
export function readWorkspaceGitDivergence(): Promise<WorkspaceGitDivergence> {
  return apiFetch('/api/workspace/git/divergence', {
    method: 'POST',
    schema: DivergenceEnvelopeSchema,
  }).then((r) => r.divergence);
}

/**
 * What an import WOULD do: the per-resource dispositions, the pipelines it
 * would archive, and the files it could not parse.
 *
 * A dry run in the strict sense — it writes no resource — but it is not a
 * promise about the future: the branch is re-read at import time and may have
 * moved. Callers must present it as "what is there now", never as "what will
 * land". See `importWorkspaceGit`.
 */
export function previewWorkspaceGitImport(): Promise<WorkspaceGitImportPreview> {
  return apiFetch('/api/workspace/git/import-preview', {
    method: 'POST',
    schema: PreviewEnvelopeSchema,
  }).then((r) => r.preview);
}

/**
 * Apply the collaboration branch to this workspace.
 *
 * THREE things a caller has to get right, all of them ways to report a false
 * outcome:
 *
 * 1. `refused: true` arrives as HTTP **200**. It means a file would not parse
 *    and the whole apply was abandoned — nothing was written. Rendering a 200
 *    as success reports an import that did not happen.
 * 2. There is no compare-and-set. This takes no body and no expected head; the
 *    server re-fetches and applies whatever is at the branch tip at that
 *    instant. So `result.head` may differ from the head a preview showed, and
 *    `result.archived` may name pipelines that preview never listed.
 * 3. Every resource absent from the branch is soft-archived and its triggers
 *    disabled. That is the widest-blast-radius act on this page, and it is
 *    reported in `archived`, not in `applied`.
 *
 * Non-destructive in the delete sense (nothing is removed from the database)
 * and idempotent (re-applying an unchanged branch yields `action: 'unchanged'`
 * throughout and mints no version).
 */
export function importWorkspaceGit(): Promise<WorkspaceGitApplyResult> {
  return apiFetch('/api/workspace/git/import', {
    method: 'POST',
    schema: ApplyEnvelopeSchema,
  }).then((r) => r.import);
}

/**
 * The human label for a previewed disposition.
 *
 * Prose lives HERE rather than inline in the page, following
 * `api/portability.ts`'s `describeAttention`/`describeImported`: these are
 * one-for-one translations of a wire enum, so they belong beside the schema
 * that names it, where a new variant fails to compile in one place.
 */
export function describeDisposition(disposition: WorkspaceGitDisposition): string {
  switch (disposition) {
    case 'create':
      return 'new here';
    case 'unchanged':
      return 'unchanged';
    case 'update':
      return 'content differs';
    case 'rename':
      return 'renamed';
    // #983 — worded IDENTICALLY to `describeAppliedAction`'s `superseded`,
    // because the preview and the outcome are now reporting the same fact about
    // the same resource minutes apart, and two phrasings would read as two
    // different findings.
    case 'superseded':
      return 'already here — this workspace has authored past it';
  }
}

/**
 * The human label for a DRIFT change — what a commit would send OUT.
 *
 * #964 — deliberately NOT a re-export of `describeDisposition`, though the two
 * tables now share a row component and the enums nearly line up (drift has no
 * counterpart to `superseded`, which is pull-direction only). Drift is the
 * commit-direction dual of the pull-direction disposition, so the same word means
 * opposite things: a drift `added` is a resource this workspace HAS and the branch
 * does not, where a disposition `create` ("new here") is the exact reverse.
 * Sharing the prose would silently invert the sentence in one of the two tables.
 */
export function describeDriftChange(change: WorkspaceGitDriftChange): string {
  switch (change) {
    case 'added':
      return 'not on the branch yet';
    case 'removed':
      return 'gone here, still on the branch';
    case 'modified':
      return 'content differs';
    case 'renamed':
      return 'renamed';
  }
}

/** The human label for what an import actually did to a resource. */
export function describeAppliedAction(action: WorkspaceGitAppliedAction): string {
  switch (action) {
    case 'created':
      return 'created';
    case 'restored':
      return 'restored from archive';
    case 'updated':
      return 'updated';
    case 'renamed':
      return 'renamed';
    // #963 — the branch names a version this workspace already holds and has
    // since authored past. Says what was true AND what to do about it: the fact
    // being reconciled is the `contentChanged: true` the preview reported for
    // this resource, which a bare "unchanged" would flatly contradict. (Since
    // #983 the preview LABELS that case `superseded` too, so this is now the
    // second half of one sentence rather than a correction of the first.)
    case 'superseded':
      return 'already here — this workspace has authored past it';
    case 'unchanged':
      return 'unchanged';
  }
}
