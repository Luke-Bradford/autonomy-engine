/**
 * Saving a server response to the operator's disk.
 *
 * There was no download path anywhere in the web package before #959 —
 * `createObjectURL`, `Blob` and `download=` appeared in zero files — so this is
 * the one place that knows how it is done, and every future "save this as a
 * file" goes through here rather than growing a second copy.
 *
 * WHY NOT a plain `<a href="/api/…/export" download>`, which needs no JS at
 * all and matches the link idiom U2 settled (a link can be middle-clicked,
 * copied and bookmarked): the export routes send no `Content-Disposition`, so
 * a 404 or a 500 would be written to the operator's disk as a `.json` file
 * containing `{"error":"not_found"}` with no error surface anywhere. For a
 * subsystem whose entire point is a clean, diffable artifact, silently saving
 * an error body IS the worse failure — so the fetch happens first, its failure
 * is rendered, and only a 2xx reaches the disk.
 */

/**
 * Hand `text` to the browser as a downloaded file named `filename`.
 *
 * The text is written through UNCHANGED. An export body is canonical JSON
 * (#3 G1 — sorted keys, stable bytes, so identical content downloads as
 * identical bytes and exports diff cleanly); reformatting, re-indenting or
 * trimming it here would make this module a second authority on canonical
 * form, and a silent one.
 */
export function downloadTextFile(filename: string, text: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // Deliberately NOT appended to the document: an anchor click navigates in
    // every browser whether or not it is connected, so appending buys nothing
    // and an early return (or a throw) would strand it in the DOM.
    anchor.click();
  } finally {
    // In a `finally` so a failed click cannot leak the object URL, which would
    // pin the whole Blob in memory for the life of the document.
    URL.revokeObjectURL(url);
  }
}

/** Everything outside this set collapses to a single hyphen. */
const NON_SLUG = /[^a-z0-9]+/g;

/**
 * The file name for an exported resource: `<kind>-<slug>-<id>.json`.
 *
 * The id is load-bearing, not decoration. `POST /api/import` mints a brand-new
 * id and does not dedupe by name — importing the same pipeline twice leaves two
 * rows called the same thing — so a name-only file name would collide on disk
 * exactly when the operator most needs to tell two artifacts apart. It also
 * gives a name that slugifies to nothing (all emoji, all CJK, all punctuation)
 * something real to fall back to.
 */
export function exportFileName(
  kind: 'pipeline' | 'connection' | 'trigger',
  name: string,
  id: string,
): string {
  const slug = name.toLowerCase().replace(NON_SLUG, '-').replace(/^-|-$/g, '');
  return slug === '' ? `${kind}-${id}.json` : `${kind}-${slug}-${id}.json`;
}
