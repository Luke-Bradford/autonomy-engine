import { z } from 'zod';
import {
  WorkspaceGitAppliedResourceSchema,
  WorkspaceGitArchivedResultSchema,
} from './workspace-git.js';

/**
 * #3 G6a — the WORKSPACE-AUDIT log (Foundation Spec #3, "Publish must be
 * EVENT-SOURCED"). An owner-scoped, append-only log of the workspace mutations
 * that the DB row-state alone cannot answer historically ("who connected the
 * repo?", "when was this pipeline archived, and what triggers did it disable?",
 * "what did the last import bring in, and from which commit?"). It mirrors
 * `run_events` (the run-level reducer log): an `id`, a monotonic per-owner
 * `seq`, an envelope `type`, a JSON `payload`, and a `createdAt` timestamp.
 *
 * G6a lands the substrate + three writers (`repo.connected`,
 * `pipeline.archived`, `import.applied`). G6c adds `pipeline.published` and
 * PROJECTS the `active` pointer from this log (the pointer becomes a
 * last-writer projection, not the source of truth) — which is why the pointer's
 * event lives here from day one rather than in an ad-hoc mutable row.
 *
 * DELIBERATE DIVERGENCE from `run_events`: that log stores `payload` OPEN
 * (`z.unknown()`) because a huge closed `EngineEventSchema` is validated only at
 * its single writer and the reducer owns typing internally. This log instead
 * types the row `payload` as the closed `WorkspaceEventSchema` union, because it
 * CROSSES THE API BOUNDARY typed (`GET /api/workspace/audit`) — the FE switches
 * on the discriminant — so validating on read as well as write is worth the
 * (tiny) extra strictness here.
 */

/**
 * The principal who caused the event. Always present — every writer runs on an
 * authenticated route with a `request.principal.id` — so REQUIRED, never
 * defaulted (#473: a genuinely-known actor is not manufactured as absent, and
 * an absent one would never be manufactured as a placeholder either).
 */
const BySchema = z.string().min(1);

/** A git repo was connected to the workspace (`POST /api/workspace/git`). The
 * `repoUrl` is credential-free BY CONSTRUCTION — `ConnectWorkspaceGitBodySchema`
 * refuses an embedded `user:password@` at the boundary — so it is safe to
 * persist verbatim (no redaction helper exists or is needed until G10's stored
 * PATs). */
export const RepoConnectedEventSchema = z.object({
  type: z.literal('repo.connected'),
  repoUrl: z.string().min(1),
  collabBranch: z.string().min(1),
  by: BySchema,
});
export type RepoConnectedEvent = z.infer<typeof RepoConnectedEventSchema>;

/** A pipeline was archived via the MANUAL route (`POST
 * /api/pipelines/:id/archive`). Archives that happen DURING an import (a
 * branch-absent pipeline) are NOT emitted here — they are captured in
 * `import.applied.archived[]` instead, so an import never double-counts an
 * archive. Reuses the apply's `{resourceId, name, disabledTriggerIds}` shape. */
export const PipelineArchivedEventSchema = WorkspaceGitArchivedResultSchema.extend({
  type: z.literal('pipeline.archived'),
  by: BySchema,
});
export type PipelineArchivedEvent = z.infer<typeof PipelineArchivedEventSchema>;

/** An `import` applied a collaboration-branch snapshot to the DB (`POST
 * /api/workspace/git/import`). Emitted only for an EFFECTFUL import (something
 * created/updated/renamed/minted, or a pipeline archived) — an idempotent
 * all-`unchanged` re-import writes no event. `head` is the collab-branch commit
 * the snapshot was taken at (always present for an effectful import — an empty
 * repo applies nothing). `branch` is the collaboration branch. */
export const ImportAppliedEventSchema = z.object({
  type: z.literal('import.applied'),
  head: z.string().min(1),
  branch: z.string().min(1),
  applied: z.array(WorkspaceGitAppliedResourceSchema),
  archived: z.array(WorkspaceGitArchivedResultSchema),
  by: BySchema,
});
export type ImportAppliedEvent = z.infer<typeof ImportAppliedEventSchema>;

/**
 * The closed workspace-audit event union, discriminated on `type`. G6c adds
 * `pipeline.published` here (and the `active`-pointer projection folds over
 * exactly this log).
 */
export const WorkspaceEventSchema = z.discriminatedUnion('type', [
  RepoConnectedEventSchema,
  PipelineArchivedEventSchema,
  ImportAppliedEventSchema,
]);
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;

/**
 * The persisted envelope row. `seq` is monotonic per owner from 0 (append
 * order authority, independent of the wall clock); `createdAt` is the event's
 * epoch-millis timestamp (the logical `at`) and the keyset-pagination key for
 * `GET /api/workspace/audit`. `type` duplicates `payload.type` as an indexed
 * column so a future projection (G6c's active pointer) can filter by kind
 * without scanning JSON — the writer stamps it FROM the validated payload, so
 * the two can never disagree.
 */
export const WorkspaceEventRowSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  payload: WorkspaceEventSchema,
  createdAt: z.number().int().nonnegative(),
});
export type WorkspaceEventRow = z.infer<typeof WorkspaceEventRowSchema>;

// No `New…Schema` insert type: these events are server-emitted only (never
// client-authored), and the `appendWorkspaceEvent` repo fn takes the owner +
// the typed `payload` directly, assigning `id`/`seq`/`createdAt` and deriving
// `type` from the payload — so an insert-shape schema would be inert surface.
