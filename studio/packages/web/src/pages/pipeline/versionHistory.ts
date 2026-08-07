/**
 * U22 slice 1 — the pure half of the pipeline version history (#903, #904).
 *
 * Every canvas Save mints a NEW immutable version, and until this ticket the
 * canvas only ever opened the newest one (`latestVersion`). With no undo (U17
 * was unbuilt when this landed) a bad save had no route back, even though the
 * good version was sitting in the DB intact. U17 has since landed, and the two
 * do NOT overlap: undo reaches back through this session's edits, a restore
 * reaches back through SAVED versions — including from a later session, a
 * reload, or past the 50-step history cap. This module owns the decisions that ride on that:
 * how the list is ordered and marked, what a RESTORE actually sends, when a
 * restore must be refused, and — since #904 — how a write refused against a
 * stale basis is recognised and worded.
 *
 * It is a pure module for the reason `runFlow.ts` states about its own half —
 * React Flow does not render in jsdom, so the canvas page's rendering is
 * covered by an e2e and everything decidable is decided out here, where a unit
 * test can reach it.
 */
import type { ActivePipelineVersion, PipelineVersion } from '@autonomy-studio/shared';
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
  /**
   * #979 — the ACTIVE published version (G6c-1). A third, independent fact: the
   * head is what the next save advances from, `current` is what the editor is
   * based on, and this is what a new `active`-bound trigger will resolve to. All
   * three routinely name different versions.
   */
  isActive: boolean;
}

/**
 * #979 — the active pointer as this page knows it, in THREE states.
 *
 * `undefined` is not a stylistic nullable — it is the load-bearing distinction.
 * `null` is the assertion "this pipeline has never been published", which is
 * exactly what `expectedActiveVersionId: null` claims to the CAS
 * (`PublishPipelineBodySchema` makes that field required and undefaulted so an
 * absent fact is never manufactured). Collapsing an unread or failed fetch into
 * `null` would send that assertion on no evidence — the #473 fail-open shape —
 * and would also render "nothing is published" as though it were known.
 */
export type ActiveVersionState = ActivePipelineVersion | null | undefined;

/**
 * #979 — the active version as this PAGE is able to NAME it, in four states.
 *
 * The pointer is a version id; the prose wants a version number, and this page
 * can only supply one for a version in the list it fetched. A version published
 * by another session AFTER this page loaded is genuinely active and genuinely
 * unnameable here — `'unnamed'` is that case, and it exists because the obvious
 * `?? null` fallback reports it as "nothing is published", which is the opposite
 * of the truth.
 *
 * - `number`   — published, and in this page's history list
 * - `'unnamed'`— published, but minted after this page loaded
 * - `null`     — nothing is published
 * - `undefined`— the pointer was not read at all
 */
export type ActiveVersionLabel = number | 'unnamed' | null | undefined;

/**
 * Resolve the pointer to something the prose can say.
 *
 * ONE resolver, because there were two call sites doing
 * `versions.find(…)?.version ?? null` inline and both carried the same defect.
 * The `isActive` TAG needs no equivalent: it matches by id and simply does not
 * mark a row it cannot find, which is silence rather than a false claim.
 */
export function activeVersionLabel(
  active: ActiveVersionState,
  versions: PipelineVersion[],
): ActiveVersionLabel {
  if (active === undefined) return undefined;
  if (active === null) return null;
  return versions.find((v) => v.id === active.versionId)?.version ?? 'unnamed';
}

/** The active version in a sentence, however much of it is known. */
function activePhrase(activeVersion: number | 'unnamed'): string {
  return activeVersion === 'unnamed'
    ? 'the version that is currently active (published after this page loaded, so it is not in the history list yet)'
    : `v${String(activeVersion)}`;
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
  /**
   * The active published version's id, `null` for never-published, `undefined`
   * while unread. Required rather than defaulted, the convention this panel's
   * `locked` prop set: a caller that forgets it should fail to compile, not
   * silently render a pipeline as having nothing deployed.
   *
   * Unread and never-published both mark NO row — the tag's absence claims only
   * "not known to be active", and no prose here asserts the stronger reading.
   */
  activeVersionId: string | null | undefined,
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
      // By ID, never by version number: the pointer the server projects is a
      // version id, and it is the only thing the two sides agree on.
      isActive: activeVersionId != null && v.id === activeVersionId,
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
 * #904 — `basedOnVersionId` is the CAS basis, and a restore declares one like
 * any other write. But NOT the basis a SAVE declares: the caller passes the
 * head of the version LIST the row was picked from, never `canvasStore.loaded`.
 * The two part company exactly when it matters — a refused save leaves `loaded`
 * pointing at the old version by construction, so a `loaded`-based basis would
 * 409 every restore for as long as the conflict banner stood. That was live in
 * the first cut of this ticket and is pinned by the e2e "a restore still works
 * while a save conflict is on screen". If the head has moved since the list was
 * fetched the server still refuses, which is right: the row was chosen against
 * a history that is out of date.
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

/**
 * What an operator reads when a RESTORE was refused because the head moved.
 *
 * Its own sentence rather than `describeSaveConflict`'s, because the two
 * surfaces offer different acts: a refused save can be advanced past with the
 * working graph, while a refused restore just needs re-trying against the
 * refreshed list. Both live out here for the same reason — the canvas has no
 * unit test, so any prose left inline is prose nothing checks.
 *
 * `null` covers the case where the refreshed list came back empty: the write
 * was still refused, and saying so vaguely beats naming a version that is not
 * there.
 */
export function describeRestoreConflict(headVersion: number | null): string {
  const moved =
    headVersion === null
      ? 'this pipeline’s versions changed while the history was open'
      : `someone else saved v${String(headVersion)} while this history was open`;
  return `Not restored: ${moved}. The list has been refreshed — nothing was changed, and you can restore again.`;
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
export interface PublishCheck {
  /** The version being previewed — the one a Publish would make active. */
  selected: PipelineVersion;
  active: ActiveVersionState;
  /** Is a git repo connected to this workspace? `undefined` while unread. */
  gitConnected: boolean | undefined;
  archived: boolean;
}

/**
 * #979 — why this version cannot be published right now, or `null` if it can.
 *
 * The rungs are the SERVER's rungs, checked in the server's order
 * (`routes/pipelines.ts` publish: no repo → archived → no provenance → CAS), so
 * the two cannot come to disagree about which reason an operator is shown. What
 * is NOT duplicated here is the CAS itself: a stale pointer is only knowable at
 * the server, and it arrives as a refusal (see `isPublishRefused`).
 *
 * The unread rung is hoisted above all of them because it gates our right to
 * judge any of the others — see `ActiveVersionState` for why unread must never
 * be read as "never published".
 *
 * Every message names the ACT that clears it. This surface is unusual in that
 * its most common refusal — no git provenance — is the NORMAL state of almost
 * every version (provenance is stamped only on a git import,
 * `portability/workspace-apply.ts`), so a disabled button explained in server
 * vocabulary would read as a broken feature rather than as a step not yet taken.
 */
export function publishRefusal({
  selected,
  active,
  gitConnected,
  archived,
}: PublishCheck): string | null {
  if (gitConnected === undefined || active === undefined) {
    return 'This pipeline’s publish state could not be read, so publishing is held back rather than guessed at — reload the page.';
  }
  if (!gitConnected) {
    return 'Publishing needs a git repo: it makes a COMMITTED version the active one. Connect a repo in Manage → Git.';
  }
  if (archived) {
    return 'This pipeline is archived — restore it before publishing.';
  }
  if (selected.sourceCommit === null || selected.sourceBlobSha === null) {
    return (
      `v${String(selected.version)} was authored here, not imported from a commit, so git cannot name it. ` +
      'Commit this pipeline in Manage → Git and import it back — publish the version that import mints.'
    );
  }
  if (active !== null && active.versionId === selected.id) {
    return `v${String(selected.version)} is already the active version — there is nothing to publish.`;
  }
  return null;
}

/**
 * The confirmation an operator reads before a publish.
 *
 * The trigger sentence is the part that cannot be guessed and is the reason this
 * prose exists at all: `resolveBindToActive` (`routes/triggers.ts`) resolves a
 * binding ONCE, at trigger creation, so publishing re-points what is created
 * NEXT and moves nothing that already exists. An operator who assumed publishing
 * re-deploys their live triggers would be wrong in the direction that matters.
 *
 * States what is KEPT for the same reason `restoreConfirmMessage` does:
 * publishing appends a pointer event and destroys nothing.
 */
export function publishConfirmMessage({
  selectedVersion,
  activeVersion,
}: {
  selectedVersion: number;
  activeVersion: ActiveVersionLabel;
}): string {
  const replacing =
    activeVersion === null
      ? 'Nothing is published for this pipeline yet.'
      : activeVersion === undefined
        ? // Unreachable via the refusal ladder, which holds a publish back until
          // the pointer is read. Stated rather than assumed away: silence here
          // would read as "nothing is published", the one thing it is not.
          'What is published now could not be read.'
        : `It replaces ${activePhrase(activeVersion)}.`;
  return (
    `Publish v${String(selectedVersion)}?\n\n` +
    `v${String(selectedVersion)} becomes this pipeline’s active version. ${replacing}\n\n` +
    `A NEW trigger set to bind to “active” will resolve to v${String(selectedVersion)}. Triggers that ` +
    'already exist resolved their version once, when they were created, and do NOT move.\n\n' +
    'No version is changed or deleted — publishing moves a pointer.'
  );
}

/**
 * What an operator reads after a publish returns.
 *
 * Derived from `published` rather than assumed: the server answers
 * `published: false` for the idempotent re-publish of the already-active version
 * and appends NO event (the audit records effect, not attempts). The refusal
 * ladder makes that unreachable except by a race, which is precisely why it must
 * not be reported as a publish — it will only ever arrive unexpectedly.
 */
export function publishOutcomeMessage({
  published,
  selectedVersion,
}: {
  published: boolean;
  selectedVersion: number;
}): string {
  return published
    ? `Published v${String(selectedVersion)} — it is now this pipeline’s active version.`
    : `v${String(selectedVersion)} was already the active version, so nothing changed.`;
}

/**
 * #979 — is this failure the publish route refusing on a business rule?
 *
 * `PublishRefusedError` maps to 409 `conflict` (`server/src/errors.ts`), and all
 * FOUR of its causes — no repo, archived, no provenance, stale CAS — share that
 * one undifferentiated code. So this predicate cannot say WHICH, and the caller
 * must not claim to know; it can only re-read the state and say what it now
 * sees. `stale_write` is excluded because it is the version route's code, not
 * this one's, and it offers a different act.
 */
export function isPublishRefused(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.body?.error === 'conflict';
}

/**
 * What an operator reads when a publish was refused.
 *
 * Deliberately NOT the server's own sentence, for the reason the refused-restore
 * path already states: it names internal DB ids. And deliberately not a CAS
 * story either — `isPublishRefused` cannot tell a stale pointer from a
 * disconnected repo, so this names the re-read fact and points at the one place
 * that explains the rest, rather than asserting a cause it does not have.
 *
 * THREE states again, and for the same reason as `ActiveVersionState`:
 * `null` is "nothing is published" — a fact, including the case where the
 * pointer was cleared between the click and the re-read — while `undefined` is
 * "the re-read ITSELF failed". Reporting the second as the first would print an
 * absent fact as a benign default, one file away from where that is preached.
 */
export function describePublishRefusal(activeVersion: ActiveVersionLabel): string {
  if (activeVersion === undefined) {
    return (
      'Not published: the server refused it, and this pipeline’s publish state could not be re-read ' +
      'afterwards — so what is active now is unknown. Nothing was changed. Reload the page, and check ' +
      'Manage → Git if the repo was disconnected.'
    );
  }
  const now =
    activeVersion === null
      ? 'nothing is published for this pipeline'
      : `the active version is ${activePhrase(activeVersion)}`;
  return (
    `Not published: the server refused it, and this pipeline’s publish state has been re-read — ${now}. ` +
    'Nothing was changed. If the repo was disconnected or this pipeline archived, Manage → Git says so.'
  );
}

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
