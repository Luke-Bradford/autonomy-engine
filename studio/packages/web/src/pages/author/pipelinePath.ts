import { withParams } from '../../lib/withParams';

/**
 * The ONE place a pipeline-canvas path is built (U4).
 *
 * Same pairing rule — and the same silent failure mode — as `runDetailPath`:
 * the id is `encodeURIComponent`d here because the route reads it back with
 * `useParams`, which DECODES exactly once. Today's ids are `pl_` + a nanoid,
 * whose alphabet needs no escaping, so a missing encode in one of the three
 * builders (the Factory resources tree, the pipelines page, and any future
 * deep-link) would look perfectly correct until the alphabet widened.
 *
 * Its own module rather than a second export from `FactoryResources.tsx`, so
 * that file exports components only (`react-refresh/only-export-components`).
 */
export function pipelinePath(pipelineId: string, version?: number, nodeId?: string): string {
  const path = `/author/pipelines/${encodeURIComponent(pipelineId)}`;
  if (version === undefined) return path;
  const query = new URLSearchParams({ [OPEN_VERSION_PARAM]: String(version) });
  if (nodeId !== undefined) query.set(OPEN_NODE_PARAM, nodeId);
  return `${path}?${query.toString()}`;
}

/**
 * #1484 OR35 — `?version=N` opens the editor on saved version N, read-only, so
 * a run can link to the version that ran rather than the latest. Debug
 * versions are not in a pipeline's version list, so a debug run links without
 * it.
 */
const OPEN_VERSION_PARAM = 'version';

/**
 * #1541 — `&node=<id>` marks one activity or container as selected in that
 * read-only version, so a failed run's "Open in editor" lands on what failed.
 * Only beside `version`: the node is the version-that-ran's, and the editor's
 * working copy may have moved on.
 */
const OPEN_NODE_PARAM = 'node';

/**
 * The editor path for the version a RUN bound: that saved version, or for a
 * debug run (whose version is not in the history) the pipeline itself.
 *
 * `nodeId` selects that node in the version. A debug run drops it with the
 * version (#1541): it has no read-only preview to select in, and selecting the
 * id in the working copy would point at a node the operator may have changed
 * or deleted since the debug run started.
 */
export function runVersionPath(
  pipelineId: string,
  version: number,
  debug: boolean,
  nodeId?: string,
): string {
  return debug ? pipelinePath(pipelineId) : pipelinePath(pipelineId, version, nodeId);
}

/** The version `pipelinePath` asked to open, or `undefined` for none or a malformed one. */
export function readOpenVersion(params: URLSearchParams): number | undefined {
  const raw = params.get(OPEN_VERSION_PARAM);
  return raw !== null && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}

/**
 * #1521 — `params` with the editor's previewed version written in: `version`
 * set to it, or removed for none, and `node` set to `nodeId` or removed. The
 * node belongs to the version a link opened, so the caller passes it only while
 * that version is the one shown.
 */
export function withOpenVersion(
  params: URLSearchParams,
  version: number | null,
  nodeId: string | undefined,
): URLSearchParams {
  return withParams(params, {
    [OPEN_VERSION_PARAM]: version === null ? '' : String(version),
    [OPEN_NODE_PARAM]: nodeId ?? '',
  });
}

/** The node `pipelinePath` asked to select, or `undefined` for none. Any
 * non-empty id: an id the version does not hold selects nothing. */
export function readOpenNode(params: URLSearchParams): string | undefined {
  const raw = params.get(OPEN_NODE_PARAM);
  return raw === null || raw === '' ? undefined : raw;
}
