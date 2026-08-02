/**
 * U22 slice 1 — the pure half of the pipeline version history (#903).
 *
 * Every canvas Save mints a NEW immutable version, and until this ticket the
 * canvas only ever opened the newest one (`latestVersion`). With no undo (U17
 * is unbuilt) a bad save had no route back, even though the good version was
 * sitting in the DB intact. This module owns the three decisions that ride on
 * that: how the list is ordered and marked, what a RESTORE actually sends, and
 * when a restore must be refused.
 *
 * It is a pure module for the reason `runFlow.ts` states about its own half —
 * React Flow does not render in jsdom, so the canvas page's rendering is
 * covered by an e2e and everything decidable is decided out here, where a unit
 * test can reach it.
 */
import type { PipelineVersion } from '@autonomy-studio/shared';
import { ApiError } from '../../api/client';
import { latestVersion, type PipelineVersionWrite } from '../../api/pipelines';
import { toVersionBody } from './canvasDoc';

/** One row of the history list — a version summarised, never its whole doc. */
export interface VersionEntry {
  id: string;
  version: number;
  createdAt: number;
  nodeCount: number;
  edgeCount: number;
  containerCount: number;
  paramCount: number;
  outputCount: number;
  /** The newest version — what the canvas opens, and what a run binds to. */
  isHead: boolean;
  /** The version the canvas is currently based on (`canvasStore.loaded`). */
  isCurrent: boolean;
}

/**
 * The versions newest-first, each marked against the head and against the one
 * the canvas is open on.
 *
 * Ordered by `version` DESC and nothing else: `version` is a server-minted
 * `max(version)+1` per pipeline, so it is unique and monotonic and needs no
 * tie-break — unlike the runs list, whose random nanoid ids made "newest-first"
 * arbitrary exactly at a `started_at` tie (R2). `createdAt` is carried for
 * display but is deliberately NOT the sort key; two versions minted inside the
 * same millisecond would order arbitrarily under it.
 */
export function historyEntries(
  versions: PipelineVersion[],
  currentVersion: number | null,
): VersionEntry[] {
  // `latestVersion` and not a local reduce: its docblock states it is the ONE
  // rule for "the highest version", shared so two readers cannot drift.
  const head = latestVersion(versions)?.version ?? null;
  return [...versions]
    .sort((a, b) => b.version - a.version)
    .map((v) => ({
      id: v.id,
      version: v.version,
      createdAt: v.createdAt,
      nodeCount: v.nodes.length,
      edgeCount: v.edges.length,
      containerCount: v.containers.length,
      paramCount: v.params.length,
      outputCount: v.outputs.length,
      isHead: v.version === head,
      isCurrent: currentVersion !== null && v.version === currentVersion,
    }));
}

/**
 * The write body for restoring `v` — built from the SELECTED VERSION's own doc
 * arrays, never from the working canvas.
 *
 * The distinction is the whole correctness of a restore. The obvious
 * implementation — load the old version into the store and press Save — routes
 * through `canvasStore.loadVersion`, which is lossy BY DESIGN: it re-lowers
 * nodes through the current catalog and DROPS any edge whose endpoint is
 * neither a known node nor container id (`canvasStore.ts:506`, `:572`), without
 * setting `dirty`. Restoring through it would silently mint a version that is
 * not the one the operator asked for, and say nothing.
 *
 * `toVersionBody` is reused rather than re-inlined here so that a restore and a
 * save cannot come to disagree about what a version body IS. What it omits is
 * as load-bearing as what it carries: `catalogVersion` is re-stamped by the
 * server, the identity fields are server-minted, and the four `source*`
 * git-provenance fields are dropped — a restored version is newly AUTHORED, not
 * minted from a commit, and claiming otherwise would forge its provenance.
 *
 * #904 — `basedOnVersionId` is the CAS basis, and a restore is a save like any
 * other: it is measured against the HEAD, so the caller passes the version its
 * canvas is on (`canvasStore.loaded`). If another tab has moved the head since,
 * the server refuses this exactly as it refuses a stale save — which is right,
 * because the restore was chosen from a history list that is now out of date.
 */
export function restoreBodyFrom(
  v: PipelineVersion,
  basedOnVersionId: string | null,
): PipelineVersionWrite {
  return toVersionBody(v.nodes, v.edges, v.containers, v.params, v.outputs, basedOnVersionId);
}

/**
 * The five doc fields the canvas store owns, snapshotted before an in-flight
 * version write so the write can tell whether the operator edited underneath it.
 *
 * The element type is `unknown` on purpose: only reference identity is ever
 * compared. Every store action mints a fresh array, so a CHANGED reference is a
 * concurrent edit and an UNCHANGED one is the absence of one — reading into the
 * elements would add precision this decision does not use.
 */
export interface DocSnapshot {
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
  readonly containers: readonly unknown[];
  readonly params: readonly unknown[];
  readonly outputs: readonly unknown[];
}

/**
 * Did the doc survive an in-flight write untouched?
 *
 * `false` means an edit landed during the request, and the caller must NOT
 * rebase the canvas onto what it just minted — that is the one move that
 * silently destroys work. Both version writers ask this: `onSave` (which keeps
 * the edits and re-points `loaded`) and `onRestore`.
 *
 * All five fields are checked because each can move alone — `createContainer`
 * and `setNodeContainer` write only `containers`, the param/output actions
 * write only `params`/`outputs`. Checking a subset would let those edits
 * through invisibly.
 */
export function docUnchanged(before: DocSnapshot, after: DocSnapshot): boolean {
  return (
    before.nodes === after.nodes &&
    before.edges === after.edges &&
    before.containers === after.containers &&
    before.params === after.params &&
    before.outputs === after.outputs
  );
}

/**
 * #904 — is this failure the server refusing a write against a stale basis?
 *
 * Branches on the `stale_write` CODE, never on the bare 409 status. The same
 * route answers 409 `conflict` for any `SQLITE_CONSTRAINT` (the
 * `pipeline_versions_pipeline_id_version_idx` UNIQUE index is the documented
 * backstop on exactly this write), and offering a re-based "save anyway" on one
 * of THOSE would re-POST straight into the same violation. The two 409s look
 * identical from the status line and are opposite in what the operator should
 * do about them.
 */
export function isStaleWrite(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.body?.error === 'stale_write';
}

/**
 * What an operator reads when their save was refused because the pipeline moved
 * underneath them.
 *
 * States all three facts, because omitting any one of them makes the next click
 * a guess: their work is intact (nothing was lost — the refusal is the whole
 * effect), the other save is intact too and reachable, and — the part it is
 * tempting to leave out — saving from here does NOT merge, it advances past
 * `headVersion` carrying only what is on this screen. An operator told merely
 * "someone else saved" would reasonably assume the button reconciles.
 */
export function describeSaveConflict(headVersion: number): string {
  return (
    `Not saved: someone else saved v${String(headVersion)} while you were editing. ` +
    'Your changes are still here, and nothing was overwritten. ' +
    `Saving now creates v${String(headVersion + 1)} from what is on your screen — it will NOT include ` +
    `v${String(headVersion)}'s changes, though v${String(headVersion)} is kept in Version history.`
  );
}

/** The label of the informed-override button — it names the version it mints. */
export function saveAnywayLabel(headVersion: number): string {
  return `Save as v${String(headVersion + 1)} anyway`;
}

export interface RestoreCheck {
  dirty: boolean;
  selectedVersion: number;
  headVersion: number | null;
}

/**
 * Why this version cannot be restored right now, or `null` if it can.
 *
 * The dirty refusal is what stops a restore from destroying anything: the
 * canvas reloads onto the version a restore mints, so unsaved working edits
 * would go with it. Refusing is the fail-safe half of the choice — the friendly
 * alternative (offer to save first) reaches into the save flow, and an operator
 * who is told plainly can save or reload themselves.
 *
 * It is reported BEFORE the head refusal deliberately: told only that the head
 * is already current, an operator with unsaved work would go on clicking rather
 * than go and save.
 */
export function restoreRefusal({
  dirty,
  selectedVersion,
  headVersion,
}: RestoreCheck): string | null {
  if (dirty) {
    return 'Save or discard your unsaved changes before restoring — restoring reopens the canvas on the new version.';
  }
  if (headVersion !== null && selectedVersion === headVersion) {
    return `v${String(selectedVersion)} is already the current version — there is nothing to restore.`;
  }
  return null;
}

/**
 * The confirmation an operator reads before a restore.
 *
 * States what is CREATED and what is KEPT, the convention the container-delete
 * confirmation set (#883). "Kept" is the part that needs saying: versions are
 * immutable, so a restore overwrites nothing — it adds. An operator who thinks
 * this button discards their later work will not press it, and the feature is
 * then no more reachable than it was before.
 */
export function restoreConfirmMessage({
  selectedVersion,
  headVersion,
}: Pick<RestoreCheck, 'selectedVersion' | 'headVersion'>): string {
  const next = (headVersion ?? 0) + 1;
  return (
    `Restore v${String(selectedVersion)}?\n\n` +
    `This creates v${String(next)} with v${String(selectedVersion)}'s contents. ` +
    'Every existing version is kept — nothing is overwritten or deleted.'
  );
}
