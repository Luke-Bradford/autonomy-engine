import { Link } from 'react-router';
import type { RunSummary } from '@autonomy-studio/shared';
import { placeSpans } from './attemptSpans';
import { formatClock, formatElapsed } from './format';
import { groupRunsByPipeline, type RunBar } from './runBars';
import { runStatusLabel, runStatusTone } from './runStatus';
import { runDetailPath } from './runPath';

/**
 * U29 (#1015) — the runs list on ONE shared time axis, grouped by pipeline.
 *
 * The table answers "which runs are there" as a column of unrelated durations.
 * It cannot answer "what was this workspace DOING between 09:00 and 09:20" —
 * whether two pipelines overlapped, whether a schedule is bunching its fires,
 * whether an idle-looking hour was really idle. Those are questions about
 * POSITION on a shared axis, and only a chart states position.
 *
 * It reuses U12a's geometry (`placeSpans`, `spanWindow`) and its stylesheet
 * (`.timeline-*`) rather than growing a second copy, and inherits the three
 * properties that make that chart trustworthy — each a way a chart can lie more
 * convincingly than a table:
 *
 *  1. **No clock.** A run with no `finishedAt` is drawn hatched to the right
 *     edge, claiming no length. A frozen `now` would rescale EVERY other bar
 *     too, not just the stale one. (The live counter is #890, still deferred.)
 *  2. **The axis is the measured window of the ROWS SHOWN** — not `now`, and
 *     not the `?since=` filter bound, which is a request for rows rather than a
 *     statement about when anything ran.
 *  3. **A row that cannot be honestly placed is NAMED, not dropped.** The
 *     classification and its sentences live in `runBars.ts`; the list beneath
 *     the chart is what stops the timeline reading as the whole page when it is
 *     a subset of it.
 *
 * And one property this surface needs that the per-run chart did not:
 *
 *  4. **The duration is TEXT on every row, not only a bar length.** The runs
 *     list has no bounded window — "Any time" is its default — so a month-wide
 *     axis renders second-long runs at the stylesheet's 2px visibility floor,
 *     and a row of identical dots asserts that those runs were all the same
 *     length. The bar owns POSITION, the label owns the VALUE; neither has to
 *     carry both.
 */
export interface RunTimelineProps {
  /** The rows as filtered, in the order the table would render them. */
  runs: RunSummary[];
}

/** What a bar states about itself, in one phrase, for the title and SR text. */
function barSentence(bar: RunBar, durationMs: number | null): string {
  const started = `started ${formatClock(bar.startedAtMs)}`;
  const length = durationMs === null ? 'no finish on record' : formatElapsed(durationMs);
  return `${runStatusLabel(bar.run.status)} · ${started} · ${length}`;
}

export function RunTimeline({ runs }: RunTimelineProps): React.ReactElement {
  const { groups, unplottable, window } = groupRunsByPipeline(runs);

  if (window === null) {
    return (
      <section aria-labelledby="run-timeline-heading" className="run-timeline">
        <h3 id="run-timeline-heading">Timeline</h3>
        <p>
          Nothing to plot — no run in view has a start this chart can believe. Every one is listed
          below with the reason.
        </p>
        <UnplottableList rows={unplottable} />
      </section>
    );
  }

  return (
    <section aria-labelledby="run-timeline-heading" className="run-timeline">
      <h3 id="run-timeline-heading">Timeline</h3>
      <p className="timeline-axis-note">
        {formatClock(window.from)} → {formatClock(window.to)} ·{' '}
        {formatElapsed(Math.max(0, window.to - window.from))} of measured wall clock, as of the last
        refresh. One lane per pipeline, all lanes on the same axis, so two bars that overlap
        horizontally were running at the same time. A very wide axis floors short bars at a few
        pixels — the length beside each bar is the measurement.
      </p>
      {groups.map((group) => {
        const headingId = `run-timeline-group-${group.pipelineId}`;
        return (
          <div key={group.pipelineId} className="run-timeline-group">
            <h4 id={headingId} className="run-timeline-group-name">
              {group.pipelineName}
            </h4>
            {/* The group heading is attached to its list programmatically, not
                merely placed above it: a screen reader landing on a bar has no
                other way to learn which pipeline's lane it is in. */}
            <ol className="timeline-rows" aria-labelledby={headingId}>
              {/* ONE `placeSpans` call for the lane, not one per row — it maps
                  an array to an array, and calling it per bar allocated a
                  single-element array and destructured it again for every row.
                  `placed.span` is the bar it was built from, so nothing has to
                  be zipped back together. */}
              {placeSpans(group.bars, window.from, window.to).map((placed) => {
                const bar = placed.span;
                const sentence = barSentence(bar, placed.durationMs);
                return (
                  <li key={bar.run.id} className="timeline-row run-timeline-row">
                    <span className="timeline-row-label">
                      <Link to={runDetailPath(bar.run.id)} title={bar.run.id}>
                        v{bar.run.pipelineVersion} · {formatClock(bar.startedAtMs)}
                      </Link>
                    </span>
                    <span className="timeline-track">
                      <span
                        data-tone={runStatusTone(bar.run.status)}
                        data-open={placed.width === null ? 'true' : undefined}
                        className="timeline-span"
                        style={
                          placed.width === null
                            ? { left: `${placed.left}%`, right: '0' }
                            : { left: `${placed.left}%`, width: `${placed.width}%` }
                        }
                        title={`${group.pipelineName} · ${sentence}`}
                      >
                        <span className="visually-hidden">{sentence}</span>
                      </span>
                    </span>
                    {/* Property 4: the measurement, in words, beside the bar. */}
                    <span className="run-timeline-length">
                      {placed.durationMs === null ? '—' : formatElapsed(placed.durationMs)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
      <UnplottableList rows={unplottable} />
    </section>
  );
}

function UnplottableList({
  rows,
}: {
  rows: { run: RunSummary; reason: string }[];
}): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div className="timeline-untimed">
      <h4>Not on the timeline</h4>
      <ul>
        {rows.map(({ run, reason }) => (
          <li key={run.id}>
            <Link to={runDetailPath(run.id)} title={run.id}>
              {run.pipelineName} v{run.pipelineVersion}
            </Link>{' '}
            — {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
