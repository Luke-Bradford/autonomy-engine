import type { ImportAppliedEvent, WorkspaceGitApplyResult } from '@autonomy-studio/shared';

/**
 * #3 G6a — derive the `import.applied` workspace-audit event from an apply
 * result, or `null` when there is nothing to record. A PURE function (no DB, no
 * git) so the "what counts as effectful" decision is unit-tested directly,
 * independent of the heavy import route.
 *
 * Records EFFECT, not attempts: a refused import (corrupt branch), an empty-repo
 * no-op (`head === null`, nothing applied), and an idempotent all-`unchanged`
 * re-import all return `null`. Emitting on those would drown the audit's "what
 * changed" value in noise. `versionMinted` is part of the effectful test because
 * a restore can mint a version while its `action` reads `restored` (#672 — the
 * two are orthogonal), and an archive-only import has an empty `applied` but a
 * non-empty `archived`.
 */
export function buildImportAppliedEvent(
  result: WorkspaceGitApplyResult,
  ctx: { branch: string; by: string },
): ImportAppliedEvent | null {
  if (result.refused || result.head === null) return null;
  const effectful =
    result.archived.length > 0 ||
    result.applied.some((a) => a.action !== 'unchanged' || a.versionMinted);
  if (!effectful) return null;
  return {
    type: 'import.applied',
    head: result.head,
    branch: ctx.branch,
    applied: result.applied,
    archived: result.archived,
    by: ctx.by,
  };
}
