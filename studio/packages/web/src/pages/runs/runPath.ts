/**
 * The ONE place a run link's PATH and its ACCESSIBLE NAME are built.
 *
 * Both are per-run identity that a call site must not re-derive, which is why
 * they share a module rather than sitting next to the components that render
 * them. The path half came first and names the rule; #1240 added the name half
 * for the same reason, after five call sites had grown three templates. (Its
 * ticket counted four — it was written from #1232's diff and did not see the
 * `Child run` link #1231 had already added.)
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

/**
 * A run link's accessible name: `<lead> run <runId>`.
 *
 * Every run-navigation anchor's name has to CONTAIN its visible text, because
 * WCAG 2.5.3 (Label in Name) is what lets a speech-input user say what they can
 * see — and "contains" is a LITERAL substring test (it is what axe's
 * `label-content-name-mismatch` and technique G208 check). An em dash used as a
 * separator here once broke containment on the arrow alone.
 *
 * That property holds BY CONSTRUCTION under this signature, which is the whole
 * reason there are two parameters rather than three. The five call sites are of
 * exactly two kinds:
 *
 * - an ACT (`Watch`, `Watch live →`) passes its own visible text as the `lead`,
 *   so the name STARTS with what the control reads;
 * - a RELATIONSHIP (`Source`, `Parent`, `Child`) renders the run id as its
 *   visible text, so the name ENDS with it.
 *
 * There is no third shape in which the name could omit either, so there is
 * nothing left for a runtime check to catch — and a check comparing two
 * arguments the same caller supplies could not catch the real failure anyway,
 * which is a name disagreeing with the DOM rather than with itself. That one is
 * caught where it is visible: `expectAccessibleNameContainsText` runs against
 * the rendered anchor in each call site's own spec.
 *
 * The verb/noun split is deliberate and stays with the caller. `Source`/`Parent`
 * name a relationship the row's `<dt>` has already introduced; `Watch` names an
 * act. Collapsing them onto one lead would flatten a distinction the call sites
 * argue for in place.
 */
export function runLinkLabel(lead: string, runId: string): string {
  return `${lead} run ${runId}`;
}
