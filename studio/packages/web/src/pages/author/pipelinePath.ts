/**
 * The ONE place a pipeline-canvas path is built (U4).
 *
 * Same pairing rule — and the same silent failure mode — as `runDetailPath`:
 * the id is `encodeURIComponent`d here because the route reads it back with
 * `useParams`, which DECODES exactly once. Today's ids are `pl_` + a nanoid,
 * whose alphabet needs no escaping, so a missing encode in one of the three
 * builders (the Factory Resources tree, the pipelines page, and any future
 * deep-link) would look perfectly correct until the alphabet widened.
 *
 * Its own module rather than a second export from `FactoryResources.tsx`, so
 * that file exports components only (`react-refresh/only-export-components`).
 */
export function pipelinePath(pipelineId: string, version?: number): string {
  const path = `/author/pipelines/${encodeURIComponent(pipelineId)}`;
  return version === undefined ? path : `${path}?${OPEN_VERSION_PARAM}=${version}`;
}

/**
 * #1484 OR35 — `?version=N` opens the editor on saved version N, read-only, so
 * a run can link to the version that ran rather than the latest. Debug
 * versions are not in a pipeline's version list, so a debug run links without
 * it.
 */
const OPEN_VERSION_PARAM = 'version';

/**
 * The editor path for the version a RUN bound: that saved version, or for a
 * debug run (whose version is not in the history) the pipeline itself.
 */
export function runVersionPath(pipelineId: string, version: number, debug: boolean): string {
  return pipelinePath(pipelineId, debug ? undefined : version);
}

/** The version `pipelinePath` asked to open, or `undefined` for none or a malformed one. */
export function readOpenVersion(params: URLSearchParams): number | undefined {
  const raw = params.get(OPEN_VERSION_PARAM);
  return raw !== null && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}
