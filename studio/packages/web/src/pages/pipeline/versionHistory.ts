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
import type { PipelineVersionWrite } from '../../api/pipelines';
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
  const head = versions.reduce<number | null>(
    (max, v) => (max === null || v.version > max ? v.version : max),
    null,
  );
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
 */
export function restoreBodyFrom(v: PipelineVersion): PipelineVersionWrite {
  return toVersionBody(v.nodes, v.edges, v.containers, v.params, v.outputs);
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
