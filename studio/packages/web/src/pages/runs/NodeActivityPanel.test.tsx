import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeActivityPanel } from './NodeActivityPanel';
import { emptyNodeCost } from './runSummary';
import type { DatasetAddress } from '@autonomy-studio/shared';
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
    datasetAddresses: undefined,
    outputValues: undefined,
    copiedFromRunId: undefined,
    instanceId: undefined,
    startedAtMs: undefined,
    endedAtMs: undefined,
    spans: [],
    childRunIds: [],
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

/**
 * #996 M6 (#1162, data-movement spec §2.1) — "where did this data go".
 *
 * The dispatch record has been durable since M6 slice B (#1149) and unreadable
 * without a `run_events` query, which §2.1 names as the unacceptable state. The
 * section is PRESENCE-GATED on the fact rather than on the activity type: the
 * panel has no doc and cannot ask what kind a node is, and every node that
 * resolved an address has one recorded.
 */
describe('NodeActivityPanel — the resolved dataset address', () => {
  const SOURCE: DatasetAddress = {
    kind: 'sqlite',
    store: '/data/app.db',
    storeIdentity: '16777232:914',
    object: 'main.people',
  };
  const SINK: DatasetAddress = {
    kind: 'sqlite',
    store: '/data/warehouse.db',
    storeIdentity: '16777232:915',
    object: 'main.people_copy',
  };

  it('names both ends a copy resolved', () => {
    const panel = renderPanel(
      row({ nodeId: 'c', status: 'success', datasetAddresses: { source: SOURCE, sink: SINK } }),
    );
    expect(panel.textContent).toMatch(/Data movement/);
    expect(panel.textContent).toMatch(/'\/data\/app\.db' → 'main\.people'/);
    expect(panel.textContent).toMatch(/'\/data\/warehouse\.db' → 'main\.people_copy'/);
  });

  it('renders no section at all for a node that resolved no dataset', () => {
    const panel = renderPanel(row({ nodeId: 'a', status: 'success' }));
    expect(panel.textContent).not.toMatch(/Data movement/);
  });

  /** Source-only is real (a read-only dataset activity), and an absent sink is
   *  rendered as absent rather than as a blank row. */
  it('omits the Sink row when the dispatch resolved no sink', () => {
    const panel = renderPanel(
      row({ nodeId: 'c', status: 'success', datasetAddresses: { source: SOURCE } }),
    );
    expect(panel.textContent).toMatch(/Data movement/);
    expect(panel.textContent).toMatch(/Source/);
    expect(panel.textContent).not.toMatch(/Sink/);
  });

  /**
   * A `query` dataset's `object` is `null` BY DESIGN — it is a SELECT over an
   * arbitrary set of tables and reducing it to one name would be a guess
   * (`address.ts`). `describeDatasetAddress` then renders the store alone, which
   * without a word of explanation reads as a truncated render rather than a
   * stated absence.
   */
  it('says why a query end names a store and no object', () => {
    const panel = renderPanel(
      row({
        nodeId: 'c',
        status: 'success',
        datasetAddresses: { source: { ...SOURCE, object: null }, sink: SINK },
      }),
    );
    expect(panel.textContent).toMatch(/'\/data\/app\.db'/);
    expect(panel.textContent).toMatch(/names no single object/);
  });

  it('does not offer that explanation when both ends name an object', () => {
    const panel = renderPanel(
      row({ nodeId: 'c', status: 'success', datasetAddresses: { source: SOURCE, sink: SINK } }),
    );
    expect(panel.textContent).not.toMatch(/names no single object/);
  });

});
