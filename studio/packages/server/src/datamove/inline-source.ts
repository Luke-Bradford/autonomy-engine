import {
  FAILURE_CODES,
  INLINE_SOURCE_DATASET_ID,
  containsSecretMarker,
  datasetConnectionKindAdvisory,
  inlineDatasetConfigIssues,
  type ConnectionKind,
  type InlineDataset,
} from '@autonomy-studio/shared';
import type { ResolvedDataset } from '../connectors/types.js';

/**
 * #1600 C1q — the checks an inline source must pass before any store reads it,
 * shared by the executor's dispatch and the Preview route so the two cannot
 * drift. The executor runs its node-shaped rungs first (a source named twice, a
 * kind the activity does not accept); these are the ones that hold for the
 * source alone.
 *
 * 1. The store the source reads must be one its kind can live in
 *    (`DATASET_CONNECTION_KINDS`), or a Table would reach an `fs` reader.
 * 2. No secret marker: a `${}` parameter can resolve run-supplied json no save
 *    gate saw, so this runs on the RESOLVED value, as it does for a saved
 *    dataset's overrides.
 * 3. `validateDoc`'s config rule again, after the values resolved, so a doc that
 *    bypassed the save gate cannot run a config other than the one it carries.
 *
 * On success it builds the same `ResolvedDataset` a saved one becomes, so every
 * reader runs unchanged.
 */
export function resolveInlineSource(
  inline: InlineDataset,
  connectionKind: ConnectionKind,
): { error: string; code: string } | { dataset: ResolvedDataset } {
  const storeMismatch = datasetConnectionKindAdvisory(inline.kind, connectionKind);
  if (storeMismatch !== null) {
    return {
      error: `the inline source's ${storeMismatch}`,
      code: FAILURE_CODES.DATASET_CONNECTION_MISMATCH,
    };
  }
  if (containsSecretMarker(inline.config)) {
    return {
      error:
        'an inline source resolved to a value containing a secret marker — ' +
        'parameters are non-secret; use a declared secret sink',
      code: FAILURE_CODES.DATASET_PARAM_SECRET_MARKER,
    };
  }
  const issues = inlineDatasetConfigIssues(inline.kind, inline.config);
  if (issues !== null) {
    return {
      error: `the inline ${inline.kind} source is not valid once its parameters are applied: ${issues}`,
      code: FAILURE_CODES.DATASET_PARAM_INVALID,
    };
  }
  return {
    dataset: {
      id: INLINE_SOURCE_DATASET_ID,
      name: `inline ${inline.kind}`,
      kind: inline.kind,
      config: inline.config,
      columns: [],
    },
  };
}
