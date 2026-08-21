/**
 * The dataset detail route's path, minted in ONE place (#996 M9).
 *
 * `encodeURIComponent` on `runDetailPath`/`pipelinePath`'s precedent, and for
 * the reason those spell out: the route reads the segment back with
 * `useParams`, which decodes exactly once, so an unencoded link would look
 * perfectly correct until the id alphabet widened. Today's nanoid alphabet
 * (`A-Za-z0-9_-`) needs no escaping at all — this guards the contract, not a
 * live hazard, which is exactly why it belongs in a helper rather than in every
 * call site's head.
 */
export function datasetDetailPath(datasetId: string): string {
  return `/manage/datasets/${encodeURIComponent(datasetId)}`;
}
