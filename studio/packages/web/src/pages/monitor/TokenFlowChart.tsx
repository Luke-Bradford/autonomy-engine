import {
  formatTokenCount,
  tokenSideReported,
  type TokenSeries,
  type TokenSeriesBucket,
} from '@autonomy-studio/shared';
import { formatWhen } from '../runs/format';

/**
 * #967 — the time-SERIES half of the Tokens panel. The model table answers
 * "where did the tokens go"; this answers "how did they move".
 *
 * ## Why this is hand-rolled and not a charting library
 *
 * `packages/web` has no chart tooling, so this is the first one either way, and
 * a library would have to be argued for rather than assumed. Three reasons it is
 * not:
 *
 *   - Every chart library ships its own colour defaults as literals. This app's
 *     palette test asserts that EVERY colour literal lives in one of the two
 *     `index.css` palette blocks, precisely so nothing can stay dark-mode-tinted
 *     in light mode. An imported palette is exactly the silent white-in-dark
 *     failure that rule exists to catch.
 *   - The mark is a bucketed stacked bar. The geometry is two percentages.
 *   - The repo already draws its time-based visuals this way (`RunTimeline`,
 *     `AttemptTimeline`): positioned elements with percentage geometry, whose
 *     colours are ordinary CSS custom properties and therefore theme for free.
 *
 * ## Why it plots TOKENS and not spend
 *
 * Tokens and dollars are different scales, and putting both on one plot would
 * need two y-axes — the chart that invents a correlation by choosing how to
 * align them. Tokens are also the thing the panel cannot already tell you: spend
 * has a five-way honest vocabulary in the table (`costHeadline`) that a line
 * cannot express, where a missing price would have to be drawn as either a gap
 * or a zero and those look identical. So spend-over-time is a separate decision,
 * deliberately not smuggled in here; the server already carries the per-bucket
 * `cost`, so it is a render-only change when it is wanted.
 *
 * ## The honesty this has to preserve
 *
 * `inputTokens`/`outputTokens` are OPTIONAL on `activity.metered` — a provider
 * may omit `usage`, and an agent-CLI exchange carries no token fields at all —
 * and the SQL sums them with `coalesce(…, 0)`. So a bucket of real, unmeasured
 * AI work arrives here as a confident `0`. A zero-height bar would state that
 * nothing happened. `inputReportedResponseCount`/`outputReportedResponseCount`
 * are what distinguish the two, and an unmeasured bucket is drawn as a hatched
 * marker that says so, never as a bar of height zero. The same applies per SIDE:
 * a bucket whose input was counted and whose output was not is not wholly
 * unmeasured, so it keeps its stack — but the uncounted half is hatched rather
 * than drawn flat, because a gap and a zero must not look alike at either scale.
 */

export interface TokenFlowChartProps {
  series: TokenSeries;
  /** The window's lower bound, for the axis's left label. */
  windowStart: number;
  /** The instant the server built the response, for the axis's right label. */
  generatedAt: number;
}

/**
 * Whether ONE side of a bucket carried no token count at all — the fact
 * `coalesce(sum(…), 0)` destroys, which is why the presence counts exist.
 *
 * The SINGLE source of that question: `segment` draws the hatched sliver from it,
 * `bucketSentence` words it from it, and the legend decides whether to explain the
 * hatch from it, so a mark can never appear that the legend does not cover.
 *
 * Since #1025 the pair arrives INSIDE `cost` — `meteredAggregateColumns()` counts
 * it for every cost surface now, not just this query.
 */
function isSideUnreported(bucket: TokenSeriesBucket, side: 'in' | 'out'): boolean {
  return !tokenSideReported(bucket.cost, side === 'in' ? 'input' : 'output');
}

/** A bucket in which exchanges were billed but NOBODY reported a token count. */
function isUnmeasured(bucket: TokenSeriesBucket): boolean {
  return isSideUnreported(bucket, 'in') && isSideUnreported(bucket, 'out');
}

/**
 * The sentence a bucket carries in BOTH its `title` and its visually-hidden
 * text — one string, so the tooltip and the screen-reader text cannot drift.
 * Built here rather than inline for the same reason `barSentence` is in
 * `RunTimeline`: a tooltip must never be the only way to reach a value.
 */
function bucketSentence(bucket: TokenSeriesBucket): string {
  const when = `${formatWhen(bucket.bucketStart)}–${formatWhen(bucket.bucketEnd)}`;
  const partial = bucket.partial ? ' (period incomplete)' : '';
  if (bucket.cost.responseCount === 0) return `${when}${partial}: no billed exchanges`;
  const exchanges = `${bucket.cost.responseCount} exchange${bucket.cost.responseCount === 1 ? '' : 's'}`;
  if (isUnmeasured(bucket)) return `${when}${partial}: ${exchanges}, tokens not reported`;
  /*
   * EACH SIDE STATES ITS OWN MEASUREDNESS. A gateway can report one side and
   * omit the other, and `coalesce(sum(…), 0)` hands the omitted one over as `0`
   * — so "0 out" would assert a measurement nobody made, which is the same
   * plotted-zero failure the hatched marker exists to prevent, just at half
   * scale. `segment` draws that side as a hatched sliver for the same reason,
   * so the sentence and the mark make the same claim.
   */
  const side = (tokens: number, label: 'in' | 'out') =>
    isSideUnreported(bucket, label)
      ? `${label} not reported`
      : `${formatTokenCount(tokens)} ${label}`;
  const counts = `${side(bucket.cost.inputTokens, 'in')} / ${side(bucket.cost.outputTokens, 'out')}`;
  return `${when}${partial}: ${exchanges}, ${counts}`;
}

export function TokenFlowChart({
  series,
  windowStart,
  generatedAt,
}: TokenFlowChartProps): React.ReactElement {
  const { buckets } = series;
  /*
   * The scale is the tallest STACK, not the tallest single series, because the
   * two are stacked — scaling to the larger of the two alone would let a stack
   * overflow the plot. `max` can legitimately be 0 (a window whose only AI use
   * was agent-CLI work, which reports no tokens); the guard keeps that from
   * becoming a division by zero and every bar `NaN%` wide.
   */
  const max = buckets.reduce((n, b) => Math.max(n, b.cost.inputTokens + b.cost.outputTokens), 0);
  const pct = (tokens: number) => (max === 0 ? 0 : (tokens / max) * 100);

  /*
   * ONE half of a stack. The `unreported` case is the whole-bucket marker at
   * half scale: the bucket had exchanges and this side of them carried no token
   * count, which `coalesce(sum(…), 0)` delivers as a confident `0`. Given an
   * inline `height: 0%` that reads as a measurement of nothing, so instead the
   * side gets no inline height at all and wears a hatched sliver whose size is
   * fixed in CSS — the same "encodes no magnitude" property the marker has.
   *
   * The `responseCount > 0` guard is what keeps a genuinely EMPTY bucket out of
   * this branch: no exchanges means no reports either, and nothing happening is
   * a measured zero that should draw as one. (A bucket where BOTH sides are
   * unreported never reaches here — `isUnmeasured` claims it first.)
   */
  const segment = (bucket: TokenSeriesBucket, side: 'in' | 'out') => {
    const tokens = side === 'in' ? bucket.cost.inputTokens : bucket.cost.outputTokens;
    const unreported = isSideUnreported(bucket, side);
    return (
      <span
        className={`token-flow-seg token-flow-seg--${side}${
          unreported ? ' token-flow-seg--unreported' : ''
        }`}
        {...(unreported ? {} : { style: { height: `${pct(tokens)}%` } })}
      />
    );
  };

  return (
    <figure className="token-flow">
      <figcaption className="token-flow-caption">
        Token flow over time
        {/* The scale is stated, because without a y-axis the bars are
            relative-only and a reader would otherwise have to guess what the
            tallest one means. */}
        {max > 0 ? (
          <span className="token-flow-scale">peak {formatTokenCount(max)} / bucket</span>
        ) : null}
      </figcaption>

      <ol className="token-flow-bars">
        {buckets.map((bucket) => {
          const sentence = bucketSentence(bucket);
          const unmeasured = isUnmeasured(bucket);
          return (
            <li className="token-flow-bucket" key={bucket.bucketStart}>
              <span
                className="token-flow-stack"
                /* Both flags are DATA from the server, not render-time guesses.
                   `partial` marks the clipped leading bucket and the one still
                   in progress — an in-progress period drawn like a finished one
                   reads as a collapse in AI use rather than a period that has
                   only just started. */
                data-partial={bucket.partial ? 'true' : undefined}
                data-unmeasured={unmeasured ? 'true' : undefined}
                title={sentence}
              >
                {unmeasured ? (
                  // Not a bar: a fixed-height hatched marker. Its height encodes
                  // nothing, which is the point — there is no measured magnitude
                  // to encode, and a short bar would claim there was a small one.
                  <span className="token-flow-unmeasured" />
                ) : (
                  <>
                    {segment(bucket, 'out')}
                    {segment(bucket, 'in')}
                  </>
                )}
                <span className="visually-hidden">{sentence}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {/* Endpoint labels only — never a label per bar, and never a calendar day
          or clock hour as a bucket NAME. Buckets are aligned to absolute epoch
          multiples, so their boundaries are UTC; the window's own vocabulary is
          "how far back", which these two instants state without implying the
          bars line up with local days. */}
      <div className="token-flow-axis">
        <span>{formatWhen(windowStart)}</span>
        <span>{formatWhen(generatedAt)}</span>
      </div>

      <ul className="token-flow-legend">
        <li>
          <span className="token-flow-swatch token-flow-seg--in" aria-hidden="true" />
          Tokens in
        </li>
        <li>
          <span className="token-flow-swatch token-flow-seg--out" aria-hidden="true" />
          Tokens out
        </li>
        {/* #1035 — the ONE mark on this chart whose meaning is not self-evident was
            the only one with nothing explaining it. A reader saw a hatched stub and
            had no way to learn it meant "nobody reported this" rather than "almost
            zero" — precisely the misreading the hatch was introduced to prevent,
            arriving one step later.

            ONE entry covers BOTH hatched marks (the half-scale sliver and the
            whole-bucket marker), because THE HATCH is what they share and what
            needs explaining — they differ only in how much of the stack went
            unreported, a distinction each bar's own title already states in words.
            Two near-identical hatched swatches would ask the reader to tell those
            apart by texture alone.

            The swatch is neutral, and cannot match both marks anyway: the sliver
            deliberately KEEPS its per-side series hue (identity survives), so it
            is blue for "in" and orange for "out", while the whole-bucket marker is
            grey. Colour is already taught by the two entries above; this entry
            teaches the one signal all three share.

            Rendered only when the series actually contains such a mark, and from
            the SAME predicate the marks are drawn from — a legend explaining
            something that is not on screen is noise, and one derived independently
            could disagree with the chart. */}
        {buckets.some((b) => isSideUnreported(b, 'in') || isSideUnreported(b, 'out')) ? (
          <li>
            <span className="token-flow-swatch token-flow-swatch--unreported" aria-hidden="true" />
            Not reported
          </li>
        ) : null}
      </ul>
    </figure>
  );
}
