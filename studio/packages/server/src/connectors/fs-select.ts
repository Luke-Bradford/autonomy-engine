/**
 * File SELECTION for the `fs` connector: the caps, the wildcard and the
 * modified-time window. Shared by `file_list`/`file_read` (`fs.ts`) and
 * Copy · Files as-is (`fs-files-copy.ts`, #1600 OR41 C1a); Get metadata (C8)
 * and Delete (C9) select files the same way.
 */

/** Default read size cap (bytes) — bounds a huge file from OOM-ing a worker. */
export const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Default `file_list` entry cap — bounds a pathological directory (millions of
 * entries) from producing an unbounded `entries` output / OOM-ing a worker. The
 * adapter iterates lazily via `opendir` and STOPS at the cap (a `permanent`
 * failure), so it never materialises more than this many dirents. Copy · Files
 * as-is applies it to its WHOLE walk (every entry it visits, directories and
 * skipped names included), so a huge tree with nothing matching is bounded too.
 */
export const DEFAULT_MAX_LIST_ENTRIES = 10_000;

/**
 * A file-NAME wildcard as ADF's `wildcardFileName` reads one: `*` is any run of
 * characters (none included), `?` is exactly one, everything else is literal.
 * Case-sensitive, and matched against the name only, never the folder.
 */
export function wildcardMatcher(pattern: string): (name: string) => boolean {
  const source = [...pattern]
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
    })
    .join('');
  const re = new RegExp(`^${source}$`, 's');
  return (name) => re.test(name);
}

/**
 * The *Modified between* window: start inclusive, end exclusive, both UTC
 * instants and both optional (ADF's `modifiedDatetimeStart`/`End`). A value
 * that does not parse, or a start not before the end, is refused rather than
 * read as "no window", which would copy everything.
 */
export function modifiedWindow(
  start: string | undefined,
  end: string | undefined,
): { ok: true; contains: (mtimeMs: number) => boolean } | { ok: false; error: string } {
  const parse = (label: string, value: string | undefined) => {
    if (value === undefined) return { ok: true as const, ms: undefined };
    const ms = Date.parse(value);
    return Number.isNaN(ms)
      ? { ok: false as const, error: `${label} '${value}' is not a date and time` }
      : { ok: true as const, ms };
  };
  const from = parse('modified from', start);
  if (!from.ok) return from;
  const to = parse('modified before', end);
  if (!to.ok) return to;
  if (from.ms !== undefined && to.ms !== undefined && from.ms >= to.ms) {
    return { ok: false, error: `modified from '${start}' is not before modified before '${end}'` };
  }
  return {
    ok: true,
    contains: (mtimeMs) =>
      (from.ms === undefined || mtimeMs >= from.ms) && (to.ms === undefined || mtimeMs < to.ms),
  };
}
