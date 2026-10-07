import type { ReactNode } from 'react';
import type { RunState } from '@autonomy-studio/shared';
import { InlineJsonValue } from './CappedValue';

/**
 * #844 GL5 — the workspace globals this run read, as the ENGINE holds them.
 *
 * Read from the page's one projection (`useRunProjection`), like the Variables
 * section beside it. `state.globals` is the `run.started` snapshot, so it holds
 * exactly the globals the bound version reads, taken when the run started (for
 * a rerun-from-failed, copied from the source run). It never changes during the
 * run, which is why there is no live/final distinction here, and why an edit to
 * a global after the start is not reflected.
 *
 * No type column: the snapshot carries values only, and the version's recorded
 * read types never reach the web.
 *
 * Omitted entirely while the projection is unavailable: without it there is
 * nothing to say whether the run read any, so any message would be a guess. For
 * a run that read none it renders `empty`, which the run page's Variables tab
 * uses to say so. The snapshot is taken at `run.started`, so a run past that
 * which read none never will — but a run with no `run.started` (queued, or
 * skipped) has no snapshot, and the page passes no `empty` for one.
 */
export function RunGlobals({
  overlay,
  empty = null,
}: {
  overlay: { ready: true; state: Pick<RunState, 'globals'> } | { ready: false; reason: string };
  /** Shown in place of the section for a run that read no globals. */
  empty?: ReactNode;
}) {
  if (!overlay.ready) return null;
  const names = Object.keys(overlay.state.globals).sort((a, b) => a.localeCompare(b, 'en'));
  if (names.length === 0) return empty;
  return (
    <section aria-labelledby="run-globals-heading">
      <h3 id="run-globals-heading">Global parameters</h3>
      <p className="page-hint">
        The values this run read when it started. A later edit to a global does not change them.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Global parameter</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {names.map((name, i) => (
            <tr key={name}>
              <th scope="row">
                <code>{name}</code>
              </th>
              <td>
                <InlineJsonValue id={`run-global-value-${i}`} value={overlay.state.globals[name]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
