import type {
  GlobalParamExportData,
  GlobalParamType,
  WorkspaceParseDiagnostic,
} from '@autonomy-studio/shared';

/**
 * #844 GL6 — the ONE rule for a branch global that must NOT be applied (spec
 * GL-D6), shared by the import preview and the apply so the two cannot disagree
 * about which files are written (#3 G7 parity).
 *
 * A global's `type` is immutable (GL-D1): every saved version that reads it was
 * typed against the stored type at save, so a retype in place would break those
 * runs exactly as a deletion would. A branch file whose type differs from the
 * workspace's same-named global is therefore reported, not written. The operator
 * retypes in the app with delete + create, and the next pull then creates it.
 *
 * A name that differs only in CASE is not a conflict: the spec matches names
 * case-insensitively and writes the value and description, keeping this
 * workspace's spelling (the next Commit writes that spelling back).
 *
 * The message names the workspace's OWN global and two closed enum values, so no
 * free-form committed content is echoed into the response.
 */
export function globalParamConflict(
  path: string,
  incoming: GlobalParamExportData,
  existing: { name: string; type: GlobalParamType },
): WorkspaceParseDiagnostic | null {
  if (incoming.type === existing.type) return null;
  return {
    path,
    code: 'global_param_conflict',
    message:
      `global parameter "${existing.name}" is a ${existing.type} here but a ${incoming.type} on ` +
      "the branch, and a global's type cannot change in place, so this file is not applied — " +
      'to retype it, delete the global and create it again with the new type',
  };
}
