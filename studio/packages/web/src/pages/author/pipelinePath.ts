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
export function pipelinePath(pipelineId: string): string {
  return `/author/pipelines/${encodeURIComponent(pipelineId)}`;
}
