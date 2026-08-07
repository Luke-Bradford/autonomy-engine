import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeActivityPanel } from './NodeActivityPanel';
import { emptyNodeCost } from './runSummary';
import type { NodeActivity } from './runSummary';

/**
 * #1008 — the "why is there no duration" chain, tested against the ROW rather
 * than through the page.
 *
 * The panel takes a plain `NodeActivity`, and the rows that make this chain
 * interesting are ones the page can only reach through a container timeout. The
 * page-level tests in `RunDetailPage.test.tsx` cover the routed-around case end
 * to end through a real fold; these cover the row shapes directly, which is the
 * only practical way to state the ABANDONED case — `reconcileNodeActivity` is
 * already unit-tested to produce exactly this shape (see its `#867` cases).
 */

function row(over: Partial<NodeActivity> & { nodeId: string }): NodeActivity {
  return {
    cost: emptyNodeCost(),
    costSpansInstances: false,
    toolCalls: [],
    status: 'pending',
    attempts: 0,
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
    ...over,
  };
}

function renderPanel(node: NodeActivity): HTMLElement {
  render(<NodeActivityPanel node={node} name={null} onClose={vi.fn()} />);
  return screen.getByRole('complementary');
}

describe('NodeActivityPanel — why there is no duration', () => {
  it('says a routed-around node was never going to run', () => {
    const panel = renderPanel(row({ nodeId: 'a', status: 'skipped', attempts: 0 }));
    expect(panel.textContent).toMatch(/routed around, so it was never going to run/);
  });

  /**
   * THE CASE THE STATUS ALONE GETS WRONG, and the reason the arm tests
   * `attempts` too.
   *
   * `skipped` is not only the routed-around verdict. `abandonLiveChildren`
   * flips a LIVE child — dispatched, parked, retry-pending — straight to
   * `skipped` when its container times out ("abandoned mid-flight, not failed",
   * per the reducer), leaving `attempts` alone; `reconcileNodeActivity` then
   * clears the open span's start, because no close can ever arrive. The row
   * therefore reaches this panel with no `startedAtMs`, a `skipped` status and
   * `attempts >= 1`.
   *
   * On status alone the panel would tell the operator that a node which was
   * running when its container gave up "was never going to run" — a confident
   * wrong explanation, which is worse here than a vague right one.
   */
  it('does NOT tell an abandoned node it was never going to run, though it is skipped too', () => {
    const panel = renderPanel(row({ nodeId: 'a', status: 'skipped', attempts: 1 }));
    expect(panel.textContent).not.toMatch(/never going to run/);
    expect(panel.textContent).not.toMatch(/has not started/);
    // What is true of it, without naming a cause the row cannot support.
    expect(panel.textContent).toMatch(/No span was recorded for this attempt/);
  });

  it('still says a node that nothing has started has not started', () => {
    const panel = renderPanel(row({ nodeId: 'a', status: 'pending', attempts: 0 }));
    expect(panel.textContent).toMatch(/has not started, so there is nothing to measure yet/);
  });

  it('keeps the copied-node sentence ahead of both', () => {
    const panel = renderPanel(
      row({ nodeId: 'a', status: 'success', attempts: 0, copiedFromRunId: 'run_0' }),
    );
    expect(panel.textContent).toMatch(/not executed in this run/);
    expect(panel.textContent).not.toMatch(/has not started/);
  });
});
