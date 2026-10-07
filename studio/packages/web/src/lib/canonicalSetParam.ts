/**
 * The ONE spelling of a multi-select kept in a URL param: the picked values in
 * VOCABULARY order, comma-joined — or `undefined` when it narrows nothing. No
 * value picked and every value picked are both the unfiltered list, so both
 * are the param's absence. Values outside the vocabulary are dropped.
 *
 * Shared by the runs bar's "Triggered by" and the pipelines bar's "Last run".
 */
export function canonicalSetParam(
  vocabulary: readonly string[],
  picked: readonly string[],
): string | undefined {
  const kept = vocabulary.filter((v) => picked.includes(v));
  return kept.length === 0 || kept.length === vocabulary.length ? undefined : kept.join(',');
}

/** A comma-joined param read back against its vocabulary, in vocabulary order;
 * `[]` (every value) for an absent param or one holding nothing it knows. */
export function readSetParam<V extends string>(
  vocabulary: readonly V[],
  raw: string | null | undefined,
): V[] {
  if (raw === null || raw === undefined) return [];
  const parts = raw.split(',');
  return vocabulary.filter((v) => parts.includes(v));
}
