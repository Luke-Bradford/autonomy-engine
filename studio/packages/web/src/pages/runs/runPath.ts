/**
 * The ONE place a run-detail path is built.
 *
 * Every call site has to `encodeURIComponent` the id, because the route it
 * lands on reads the id back with `useParams`, which DECODES exactly once (see
 * `RunDetailRoute`). Getting that pairing wrong in one place and not the others
 * is a silent, id-dependent bug: today's ids are `run_` + a nanoid, whose
 * alphabet (`A-Za-z0-9_-`) needs no escaping at all, so a missing encode would
 * look perfectly fine until the alphabet widened.
 *
 * It became a helper when U3r added a third builder (`LegacyRunRedirect`)
 * alongside `RunsPage` and `TriggersPage` — three copies of an invariant is
 * where the project's single-source-of-truth rule bites.
 *
 * Note react-router uses `%2F` as an internal sentinel, so a literal `/` inside
 * an id still would not round-trip; ids must stay path-safe regardless.
 */
export function runDetailPath(runId: string): string {
  return `/monitor/runs/${encodeURIComponent(runId)}`;
}
