/**
 * A list of resolved NAMES, joined so a name cannot be mistaken for two (#909).
 *
 * The problem it exists for: a `', '` join over free-text names splits a name
 * containing `, ` into what reads as two names, with nothing marking which. One
 * name in, two names out. Worse where the sentence also states a COUNT (#943's
 * "{n} things start in parallel: …"), because the count and the list then
 * disagree in front of the operator.
 *
 * Reachable, though narrowly: names are minted as `` `${activityLabel(node)} ${n}` ``,
 * and `activityLabel` falls back to the RAW TYPE for a type the catalog does not
 * know. `NodeSchema.type` is an unconstrained `z.string().min(1)`, so an IMPORTED
 * doc can carry a comma-bearing one. No catalog title contains a comma — checked
 * against `catalog/registry.ts` — so no doc authored on this canvas can produce
 * one.
 *
 * Quotes ALWAYS, not only when a name needs it. Quoting on demand would be
 * quieter for the comma-free case that is effectively all of them, but it puts
 * two renderings of one list in front of a reader who cannot see which rule
 * produced either.
 *
 * WHERE IT APPLIES, stated once so the asymmetry is a decision rather than an
 * oversight: quoting disambiguates a SEPARATOR that could occur inside a name.
 * So a `', '` join needs it, and two neighbouring renderings deliberately do not
 * — a single name rendered alone (no separator to be confused with) and the
 * implicit-chain preview's `' → '` join (a separator no label can contain). Both
 * live beside `#943`'s site in `FlowCanvas`.
 *
 * Lifted out of `pages/pipeline/containerRules.ts`, where it was module-private,
 * when `FlowCanvas` needed the same convention: copying the expression a third
 * time is what #909 exists to prevent, not something to add to. Note
 * `pages/runs/externalWaits.ts` renders `` “name” (type) `` — a different shape
 * for a different payload, and deliberately left alone here.
 */
export function namedList(names: readonly string[]): string {
  return names.map((n) => `“${n}”`).join(', ');
}
