import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttemptTimeline } from './AttemptTimeline';
import { placeSpans, timelineWindow, untimedReason } from './attemptTimeline';
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
      node({ nodeId: 'a', spans: [span({ startedAtMs: 1_000, endedAtMs: 1_400, endedAs: 'success' })] }),
      node({ nodeId: 'b', spans: [span({ startedAtMs: 1_200, endedAtMs: 4_000, endedAs: 'success' })] }),
    ]);
    expect(window).toEqual({ from: 1_000, to: 4_000 });
  });

  it('does NOT let an open span stretch the axis to an assumed present', () => {
    /* The rule that keeps this page clock-free (#867; the live counter is
       #890). Were the open span given an end, every closed bar beside it would
       be rescaled by a number nobody measured — and it would keep shrinking on
       every re-render, which is worse than a stale cell because it is moving. */
    const window = timelineWindow([
      node({ nodeId: 'a', spans: [span({ startedAtMs: 1_000, endedAtMs: 1_400, endedAs: 'success' })] }),
      node({ nodeId: 'b', status: 'dispatched', spans: [span({ startedAtMs: 1_300 })] }),
    ]);
    expect(window).toEqual({ from: 1_000, to: 1_400 });
  });

  it('ignores an end that PRECEDES its start rather than reversing the axis', () => {
    // `format.ts` and the drill-in panel both already refuse to turn a corrupt
    // clock into a duration; letting one set `to` would run the axis backwards.
    const window = timelineWindow([
      node({ nodeId: 'a', spans: [span({ startedAtMs: 5_000, endedAtMs: 10, endedAs: 'success' })] }),
    ]);
    expect(window).toEqual({ from: 5_000, to: 5_000 });
  });

  it('is null when nothing has a span at all', () => {
    expect(timelineWindow([node({ nodeId: 'a' })])).toBeNull();
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
    const placed = placeSpans([span({ startedAtMs: 1_000, endedAtMs: 1_000, endedAs: 'success' })], 1_000, 1_000);
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
    expect(untimedReason(node({ nodeId: 'a', status: 'skipped', attempts: 0 }))).toContain('skipped');
  });

  it('says a node has not started when nothing started it', () => {
    expect(untimedReason(node({ nodeId: 'a', status: 'pending', attempts: 0 }))).toBe(
      'has not started',
    );
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
          node({ nodeId: 'a', spans: [span({ startedAtMs: 1_100, endedAtMs: 1_900, endedAs: 'success' })] }),
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
          node({ nodeId: 'a', status: 'success', spans: [span({ startedAtMs: 1_000, endedAtMs: 1_500, endedAs: 'success' })] }),
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

  it('names every untimed node with its reason instead of dropping it', () => {
    render(
      <AttemptTimeline
        nodes={[
          node({ nodeId: 'a', spans: [span({ startedAtMs: 1_000, endedAtMs: 1_400, endedAs: 'success' })] }),
          node({ nodeId: 'gate', status: 'skipped', attempts: 0 }),
        ]}
        nameOf={(id) => (id === 'gate' ? 'Gate' : null)}
      />,
    );
    expect(screen.getByText('Not on the timeline')).toBeTruthy();
    expect(screen.getByText('Gate')).toBeTruthy();
    expect(screen.getByText(/routes around/)).toBeTruthy();
  });

  it('says nothing is measurable yet rather than drawing an empty axis', () => {
    render(<AttemptTimeline nodes={[node({ nodeId: 'a', status: 'pending', attempts: 0 })]} nameOf={noNames} />);
    expect(screen.getByText(/Nothing measurable yet/)).toBeTruthy();
    expect(screen.getByText('Not on the timeline')).toBeTruthy();
  });
});
