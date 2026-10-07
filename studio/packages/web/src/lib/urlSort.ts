/**
 * #1569 — a sortable table's order, kept in the URL. ONE home for the rules the
 * runs grid, a run's activity runs and the pipelines grid share (#1569 folded
 * the three copies):
 *
 *  - a junk key is dropped, and a junk or absent `dir` is the column's NATURAL
 *    direction, the one it opens in;
 *  - the natural direction writes no `dir`, and the default order no params at
 *    all, so a plain list keeps a plain URL (`''` deletes a param, `withParams`);
 *  - a header click opens another column in its natural direction and flips the
 *    sorted one.
 *
 * A table with a `defaultKey` always has an order. One without (`null`) also has
 * "no sort" — a run's activity runs in run order — and there a second flip
 * returns to it.
 */
export type SortDir = 'asc' | 'desc';

export interface UrlSort<K extends string> {
  key: K;
  dir: SortDir;
}

export interface UrlSortSpec<K extends string> {
  keys: readonly K[];
  natural: Readonly<Record<K, SortDir>>;
  defaultKey: K | null;
  params: { readonly sort: string; readonly dir: string };
}

function isKey<K extends string>(spec: UrlSortSpec<K>, v: string | null): v is K {
  return (spec.keys as readonly (string | null)[]).includes(v);
}

/** The order the URL asks for; `null` only for a table without a default. */
export function readUrlSort<K extends string>(
  spec: UrlSortSpec<K>,
  params: URLSearchParams,
): UrlSort<K> | null {
  const raw = params.get(spec.params.sort);
  const key = isKey(spec, raw) ? raw : spec.defaultKey;
  if (key === null) return null;
  const dir = params.get(spec.params.dir);
  return { key, dir: dir === 'asc' || dir === 'desc' ? dir : spec.natural[key] };
}

/** The params an order writes. */
export function urlSortParams<K extends string>(
  spec: UrlSortSpec<K>,
  sort: UrlSort<K> | null,
): Record<string, string> {
  if (sort === null) return { [spec.params.sort]: '', [spec.params.dir]: '' };
  const natural = sort.dir === spec.natural[sort.key];
  return {
    [spec.params.sort]: sort.key === spec.defaultKey && natural ? '' : sort.key,
    [spec.params.dir]: natural ? '' : sort.dir,
  };
}

/** A header click. */
export function nextUrlSort<K extends string>(
  spec: UrlSortSpec<K>,
  current: UrlSort<K> | null,
  clicked: K,
): UrlSort<K> | null {
  if (current === null || current.key !== clicked) {
    return { key: clicked, dir: spec.natural[clicked] };
  }
  // Without a default, the flip away from natural is followed by "no sort".
  if (spec.defaultKey === null && current.dir !== spec.natural[clicked]) return null;
  return { key: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/** A header's `aria-sort`: only the sorted column carries one (`null` → none). */
export function ariaSortOf(dir: SortDir | null): 'ascending' | 'descending' | undefined {
  return dir === null ? undefined : dir === 'asc' ? 'ascending' : 'descending';
}
