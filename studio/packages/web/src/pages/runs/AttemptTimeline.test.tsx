import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttemptTimeline } from './AttemptTimeline';
import { placeSpans, timelineWindow, untimedReason } from './attemptSpans';
import { formatClock } from './format';
import { emptyNodeCost, type AttemptSpan, type NodeActivity } from './runSummary';

const span = (over: Partial<AttemptSpan> & { startedAtMs: number }): AttemptSpan => ({
  endedAtMs: undefined,
  startedAs: 'dispatched',
  endedAs: undefined,
  instanceId: undefined,
  ...over,
});

const node = (over: Partial<NodeActivity> & { nodeId: string }): NodeActivity => ({
  status: 'success',
  attempts: 1,
  outputs: 0,
  lastOutputName: undefined,
  error: undefined,
  failureKind: undefined,
  failureCode: undefined,
  outputValues: undefined,
  copiedFromRunId: undefined,
  instanceId: undefined,
  startedAtMs: undefined,
  endedAtMs: undefined,
  spans: [],
  cost: emptyNodeCost(),
  costSpansInstances: false,
  toolCalls: [],
  ...over,
});

const noNames = () => null;

describe('timelineWindow', () => {
  it('spans the earliest start to the latest END the log stated', () => {
    const window = timelineWindow([
      node({
        nodeId: 'a',
        spans: [span({ startedAtMs: 1_000, endedAtMs: 1_400, endedAs: 'success' })],
      }),
      node({
        nodeId: 'b',
        spans: [span({ startedAtMs: 1_200, endedAtMs: 4_000, endedAs: 'success' })],
      }),
    ]);
    expect(window).toEqual({ from: 1_000, to: 4_000 });
  });

  it('does NOT let an open span stretch the axis to an assumed present', () => {
    /* The rule that keeps this page clock-free (#867; the live counter is
       #890). Were the open span given an end, every closed bar beside it would
       be rescaled by a number nobody measured — and it would keep shrinking on
       every re-render, which is worse than a stale cell because it is moving. */
    const window = timelineWindow([
      node({
        nodeId: 'a',
        spans: [span({ startedAtMs: 1_000, endedAtMs: 1_400, endedAs: 'success' })],
      }),
      node({ nodeId: 'b', status: 'dispatched', spans: [span({ startedAtMs: 1_300 })] }),
    ]);
    expect(window).toEqual({ from: 1_000, to: 1_400 });
  });

  it('ignores an end that PRECEDES its start rather than reversing the axis', () => {
    // `format.ts` and the drill-in panel both already refuse to turn a corrupt
    // clock into a duration; letting one set `to` would run the axis backwards.
    const window = timelineWindow([
      node({
        nodeId: 'a',
        spans: [span({ startedAtMs: 5_000, endedAtMs: 10, endedAs: 'success' })],
      }),
    ]);
    expect(window).toEqual({ from: 5_000, to: 5_000 });
  });

  it('is null when nothing has a span at all', () => {
    expect(timelineWindow([node({ nodeId: 'a' })])).toBeNull();
  });

  it('survives more spans than a spread call can carry', () => {
    /* The review finding on #1007. `Math.min(...instants)` passes one ARGUMENT
       per instant and V8 overflows the stack above ~100k of them (measured on
       this Node: 100,000 fine, 125,000 `RangeError`) — so a run with a large
       `foreach`, or many retries, would throw inside render and blank the whole
       run-detail page rather than degrade to a rough axis.

       The two span objects are SHARED across the array rather than built per
       index, which keeps this to one 130k-pointer array instead of 130k
       objects. Sound because the only thing under test is the ARGUMENT COUNT
       ceiling: `timelineWindow` reads fields and never identity, and the
       arithmetic itself is what the three cases above cover. Alternating them
       still makes the asserted window a real min and max rather than a
       constant, so a fold that returned its first span would fail too.

       MUTATION-CHECKED: restoring the spread turns exactly this test red with
       `RangeError: Maximum call stack size exceeded` and leaves the other 16
       green — none of them is anywhere near the limit. */
    const early = span({ startedAtMs: 1_000, endedAtMs: 1_400, endedAs: 'success' });
    const late = span({ startedAtMs: 9_000, endedAtMs: 9_400, endedAs: 'success' });
    const spans = Array.from({ length: 130_000 }, (_, i) => (i % 2 === 0 ? early : late));
    expect(timelineWindow([node({ nodeId: 'a', spans })])).toEqual({ from: 1_000, to: 9_400 });
  });
});

describe('placeSpans', () => {
  it('places a span as a percentage of the window', () => {
    const [placed] = placeSpans(
      [span({ startedAtMs: 1_500, endedAtMs: 2_000, endedAs: 'success' })],
      1_000,
      3_000,
    );
    expect(placed!.left).toBe(25);
    expect(placed!.width).toBe(25);
  });

  it('gives an open span NO width, rather than one running to the axis end', () => {
    const [placed] = placeSpans([span({ startedAtMs: 2_000 })], 1_000, 3_000);
    expect(placed!.width).toBeNull();
  });

  it('does not emit NaN for a window with no extent', () => {
    /* A single instantaneous span, or a single open one. `NaN%` is dropped
       SILENTLY by CSS — every bar would collapse to the left edge with nothing
       logged anywhere, so this is the failure that would never be reported. */
    const placed = placeSpans(
      [span({ startedAtMs: 1_000, endedAtMs: 1_000, endedAs: 'success' })],
      1_000,
      1_000,
    );
    expect(placed[0]!.left).toBe(0);
    expect(placed[0]!.width).toBe(0);
    expect(Number.isNaN(placed[0]!.left)).toBe(false);
    expect(Number.isNaN(placed[0]!.width!)).toBe(false);
  });
});

describe('untimedReason', () => {
  it('names a copied frontier node as not having run here', () => {
    expect(untimedReason(node({ nodeId: 'a', copiedFromRunId: 'r1', attempts: 0 }))).toContain(
      'copied from an earlier run',
    );
  });

  it('names a skipped node, and says why there is no event for it', () => {
    expect(untimedReason(node({ nodeId: 'a', status: 'skipped', attempts: 0 }))).toContain(
      'skipped',
    );
  });

  it('says a node has not started when nothing started it', () => {
    expect(untimedReason(node({ nodeId: 'a', status: 'pending', attempts: 0 }))).toBe(
      'has not started',
    );
  });

  /**
   * A node ABANDONED mid-flight is `skipped` too, and must not be described as
   * routed around. `abandonLiveChildren` flips a live child straight to
   * `skipped` on a container timeout ("abandoned mid-flight, not failed") and
   * leaves `attempts` alone, so `skipped` alone cannot carry the routing claim.
   *
   * Asserted as the sentence it must NOT produce plus the one it must, because
   * the failure this guards is a confident wrong explanation rather than a
   * missing one — and the honest answer here is the LOG description, not a
   * named cause the row has no container to support.
   */
  it('does not call an abandoned node routed around, though it too is skipped', () => {
    const reason = untimedReason(node({ nodeId: 'a', status: 'skipped', attempts: 1 }));
    expect(reason).not.toContain('routes around');
    expect(reason).toContain('no start-and-terminal pair');
  });

  it('describes the LOG for a node that ran but cannot be measured', () => {
    // `fail`, `filter`, `call_pipeline`, `if`, `switch` and a parallel foreach
    // body node all reach this, so naming any one of them would be a guess.
    expect(untimedReason(node({ nodeId: 'a', status: 'failure', attempts: 1 }))).toContain(
      'no start-and-terminal pair',
    );
  });
});

describe('<AttemptTimeline>', () => {
  it('draws one bar per span, keeping the Nodes table order', () => {
    render(
      <AttemptTimeline
        nodes={[
          node({
            nodeId: 'b',
            spans: [
              span({ startedAtMs: 1_000, endedAtMs: 1_200, endedAs: 'failure' }),
              span({ startedAtMs: 3_000, endedAtMs: 3_500, endedAs: 'success' }),
            ],
          }),
          node({
            nodeId: 'a',
            spans: [span({ startedAtMs: 1_100, endedAtMs: 1_900, endedAs: 'success' })],
          }),
        ]}
        nameOf={noNames}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('b');
    expect(rows[0]!.querySelectorAll('.timeline-span')).toHaveLength(2);
    expect(rows[1]!.querySelectorAll('.timeline-span')).toHaveLength(1);
  });

  it('colours a bar by the tone of what ENDED it, not the node’s current status', () => {
    /* A retried node is `success` NOW and its first attempt failed. Colouring
       every bar by the row status would repaint that history green — erasing the
       one thing the timeline was built to show. */
    const { container } = render(
      <AttemptTimeline
        nodes={[
          node({
            nodeId: 'a',
            status: 'success',
            spans: [
              span({ startedAtMs: 1_000, endedAtMs: 1_200, endedAs: 'failure' }),
              span({ startedAtMs: 2_000, endedAtMs: 2_200, endedAs: 'success' }),
            ],
          }),
        ]}
        nameOf={noNames}
      />,
    );
    const bars = [...container.querySelectorAll('.timeline-span')];
    expect(bars.map((b) => b.getAttribute('data-tone'))).toEqual(['failure', 'success']);
  });

  it('marks an open span open and claims no length for it', () => {
    const { container } = render(
      <AttemptTimeline
        nodes={[
          node({
            nodeId: 'a',
            status: 'success',
            spans: [span({ startedAtMs: 1_000, endedAtMs: 1_500, endedAs: 'success' })],
          }),
          node({ nodeId: 'b', status: 'dispatched', spans: [span({ startedAtMs: 1_200 })] }),
        ]}
        nameOf={noNames}
      />,
    );
    const open = container.querySelector<HTMLElement>('.timeline-span[data-open="true"]');
    expect(open).not.toBeNull();
    expect(open!.textContent).toContain('no end on record');
    /* …and it must carry NO width, which would be a stated length. It is pinned
       against the measured bar in the same render rather than against `''`
       alone: an assertion that a style is absent passes just as well when the
       style never parsed, which is how the first version of this test went
       vacuous (jsdom silently drops an inline `max(2px, 25%)`). */
    expect(open!.style.width).toBe('');
    expect(open!.style.right).toBe('0px');
    const measured = container.querySelector<HTMLElement>('.timeline-span:not([data-open])');
    expect(measured!.style.width).not.toBe('');
    expect(measured!.style.right).toBe('');
  });

  /**
   * #1010 — an open span states its un-endedness ONCE.
   *
   * Pinned as the whole `title`, not as an absence: asserting only that "still
   * open" is gone would pass just as well if the bar stopped saying anything at
   * all. Both open statuses are covered because a PARK is where the old wording
   * read worst — "waiting (timer), still open · … · no end on record" said it
   * three times, the status word included.
   */
  it('says an open span has not ended ONCE, for a dispatch and for a park alike', () => {
    const { container } = render(
      <AttemptTimeline
        nodes={[
          node({
            nodeId: 'a',
            status: 'dispatched',
            spans: [span({ startedAtMs: 0, startedAs: 'dispatched' })],
          }),
          node({
            nodeId: 'b',
            status: 'wait_pending',
            spans: [span({ startedAtMs: 0, startedAs: 'wait_pending' })],
          }),
          /* A measured bar, so the window has an extent and the two open bars
             above are placed rather than short-circuited by `timelineWindow`. */
          node({
            nodeId: 'c',
            status: 'success',
            spans: [span({ startedAtMs: 0, endedAtMs: 4_000, endedAs: 'success' })],
          }),
        ]}
        nameOf={(id) => id.toUpperCase()}
      />,
    );
    /* Rows keep the order they were handed in, and `formatClock` is locale- and
       timezone-dependent — so the expected clock is built with the same helper
       the component uses rather than hardcoded. */
    const titles = [...container.querySelectorAll('.timeline-row .timeline-span')].map((b) =>
      b.getAttribute('title'),
    );
    const at0 = formatClock(0);

    expect(titles[0]).toBe(`A · running · started ${at0} · no end on record`);
    expect(titles[1]).toBe(`B · waiting (timer) · started ${at0} · no end on record`);

    /* The closed bar keeps the END's word and a real length — the label change
       must not have flattened the two cases into one. */
    expect(titles[2]).toBe(`C · success · started ${at0} · 4s`);

    expect(container.textContent).not.toContain('still open');
  });

  it('names every untimed node with its reason instead of dropping it', () => {
    render(
      <AttemptTimeline
        nodes={[
          node({
            nodeId: 'a',
            spans: [span({ startedAtMs: 1_000, endedAtMs: 1_400, endedAs: 'success' })],
          }),
          node({ nodeId: 'gate', status: 'skipped', attempts: 0 }),
        ]}
        nameOf={(id) => (id === 'gate' ? 'Gate' : null)}
      />,
    );
    expect(screen.getByText('Not on the timeline')).toBeTruthy();
    // Named, and identifiable: the display name is visible and the authored id
    // is on `title` (the row label's convention, and the only copy on the page).
    expect(screen.getByText('Gate').getAttribute('title')).toBe('gate');
    expect(screen.getByText(/routes around/)).toBeTruthy();
  });

  it('says nothing is measurable yet rather than drawing an empty axis', () => {
    render(
      <AttemptTimeline
        nodes={[node({ nodeId: 'a', status: 'pending', attempts: 0 })]}
        nameOf={noNames}
      />,
    );
    expect(screen.getByText(/Nothing measurable yet/)).toBeTruthy();
    expect(screen.getByText('Not on the timeline')).toBeTruthy();
  });
});
