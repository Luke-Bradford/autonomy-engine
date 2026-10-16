/**
 * File SELECTION for the `fs` connector: the caps, the wildcard and the
 * modified-time window. `fs.ts` reads the two caps; the wildcard and the
 * window are Copy · Files as-is's (`fs-files-copy.ts`, #1600 OR41 C1a), kept
 * here for Get metadata (C8) and Delete (C9), which select files the same way.
 */
import type { Dirent } from 'node:fs';

/**
 * The two caps' defaults (#1712: shared, so the connection form's notes are
 * built from them). The `file_list` adapter iterates lazily via `opendir` and
 * STOPS at the entry cap (a `permanent` failure), so it never materialises more
 * than that many dirents. Copy · Files as-is applies it to its WHOLE walk (every
 * entry it visits, directories and skipped names included), so a huge tree with
 * nothing matching is bounded too.
 */
export { DEFAULT_MAX_LIST_ENTRIES, DEFAULT_MAX_READ_BYTES } from '@autonomy-studio/shared';

/**
 * Classify a directory entry, or an `lstat` result, by its raw type (a symlink
 * is REPORTED, not followed). `file_list`'s entries and Get metadata's item and
 * child item types (#1600 OR41 C8a) share it, so the two say the same words.
 */
export function direntType(
  d: Pick<Dirent, 'isFile' | 'isDirectory' | 'isSymbolicLink'>,
): 'file' | 'directory' | 'symlink' | 'other' {
  if (d.isFile()) return 'file';
  if (d.isDirectory()) return 'directory';
  if (d.isSymbolicLink()) return 'symlink';
  return 'other';
}

/**
 * A file-NAME wildcard as ADF's `wildcardFileName` reads one: `*` is any run of
 * characters (none included), `?` is exactly one, everything else is literal.
 * Case-sensitive, and matched against the name only, never the folder.
 */
export function wildcardMatcher(pattern: string): (name: string) => boolean {
  // Iterative, not a RegExp: `*a*a*a*b` compiled to `.*a.*a.*a.*b` backtracks
  // exponentially, and a wildcard can come from a `${}` fed by a trigger. This
  // greedy match with one backtrack point is O(name × pattern) at worst.
  const p = [...pattern];
  return (name) => {
    const n = [...name];
    let pi = 0;
    let ni = 0;
    let star = -1;
    let mark = 0;
    while (ni < n.length) {
      if (pi < p.length && (p[pi] === '?' || (p[pi] !== '*' && p[pi] === n[ni]))) {
        pi += 1;
        ni += 1;
      } else if (pi < p.length && p[pi] === '*') {
        star = pi;
        mark = ni;
        pi += 1;
      } else if (star !== -1) {
        pi = star + 1;
        mark += 1;
        ni = mark;
      } else {
        return false;
      }
    }
    while (pi < p.length && p[pi] === '*') pi += 1;
    return pi === p.length;
  };
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
