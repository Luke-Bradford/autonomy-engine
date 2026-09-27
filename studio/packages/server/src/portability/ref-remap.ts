import { interpolationMode } from '@autonomy-studio/shared';

/**
 * #1106 — THE rule for moving a node's resource ref across the DB-id /
 * `resourceId` boundary, in whichever direction:
 *
 * - a `${}` dynamic ref is PORTABLE (it routes on run values, not on a row), so
 *   it passes through verbatim and never consults the map;
 * - a literal ref is looked up in the map;
 * - a literal the map does not hold is the caller's to decide, via `onUnmapped`.
 *
 * Three directions use it, and they differ ONLY in `onUnmapped`, which is why it
 * is a parameter rather than three copies of this function:
 * - commit (`workspace-serialize.ts`) THROWS — a commit must not emit a dangling ref;
 * - compare (`workspace-serialize.ts`) FALLS BACK to the id — when merely
 *   comparing, the honest answer is "these forms differ", not an exception;
 * - import (`workspace-apply.ts`) THROWS a `WorkspaceApplyError`.
 *
 * What is deliberately NOT here is the null/absent SHAPE of a ref: the DB node's
 * `connectionId` is `optional()` while the export's is `null`, and a dataset sink
 * may be ABSENT (#1220). That is a fact about each side's schema, so each
 * direction handles it before calling this.
 *
 * Also deliberately not here: `export.ts`'s portable strip, which DESTROYS a
 * literal (nulls an env-specific id) rather than remapping it, and
 * `resourceRefToDb`, whose resource-level address has no dynamic arm.
 */
export function mapLiteralRef(
  ref: string,
  map: Map<string, string>,
  onUnmapped: () => string,
): string {
  if (interpolationMode(ref).mode !== 'literal') return ref;
  return map.get(ref) ?? onUnmapped();
}
