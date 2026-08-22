import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { expectAccessibleNameContainsText } from '../../testing/accessibleName';
import { renderWithRouter } from '../../testing/renderWithRouter';
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

/*
 * `renderWithRouter`, not a bare `render`: the Child runs section renders real
 * `<Link>`s, and `useHref` throws outside a router context. The shared helper is
 * the one `RunDetailPage.test.tsx` already uses, so there is no second opinion
 * here about what "a router that exists and goes nowhere" means.
 */
function renderPanel(node: NodeActivity): HTMLElement {
  renderWithRouter(<NodeActivityPanel node={node} name={null} onClose={vi.fn()} />);
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

  /**
   * With two ends on screen and only one of them a query, the sentence has to
   * say WHICH row it explains — "that end" leaves the reader to guess, and the
   * wrong guess is the truncated-render misreading the sentence exists to kill.
   */
  it('names the source when only the source is a query', () => {
    const panel = renderPanel(
      row({
        nodeId: 'c',
        status: 'success',
        datasetAddresses: { source: { ...SOURCE, object: null }, sink: SINK },
      }),
    );
    expect(panel.textContent).toMatch(/recorded for the source\./);
    expect(panel.textContent).not.toMatch(/sink\./);
  });

  it('names the sink when only the sink is a query', () => {
    const panel = renderPanel(
      row({
        nodeId: 'c',
        status: 'success',
        datasetAddresses: { source: SOURCE, sink: { ...SINK, object: null } },
      }),
    );
    expect(panel.textContent).toMatch(/recorded for the sink\./);
    expect(panel.textContent).not.toMatch(/for the source/);
  });

  it('names both ends when both are queries', () => {
    const panel = renderPanel(
      row({
        nodeId: 'c',
        status: 'success',
        datasetAddresses: {
          source: { ...SOURCE, object: null },
          sink: { ...SINK, object: null },
        },
      }),
    );
    expect(panel.textContent).toMatch(/recorded for the source and sink\./);
  });

  it('does not offer that explanation when both ends name an object', () => {
    const panel = renderPanel(
      row({ nodeId: 'c', status: 'success', datasetAddresses: { source: SOURCE, sink: SINK } }),
    );
    expect(panel.textContent).not.toMatch(/names no single object/);
  });
});

/**
 * #1231 (U20 slice 1) — the child-run drill.
 *
 * Asserted on the ROW rather than through the page for the reason the file's
 * head docblock already gives: the interesting shapes here are ones the page
 * can only reach through a crash or a container timeout.
 */
describe('NodeActivityPanel — child runs', () => {
  function childSection(panel: HTMLElement): HTMLElement {
    return within(panel).getByRole('region', { name: 'Child runs' });
  }

  it('renders no Child runs section for a node that spawned none', () => {
    const panel = renderPanel(row({ nodeId: 'a', status: 'success' }));
    expect(within(panel).queryByRole('region', { name: 'Child runs' })).toBeNull();
  });

  it('links the one child a call node spawned, named so it is not a bare id', () => {
    const panel = renderPanel(
      row({ nodeId: 'a', status: 'waiting', attempts: 1, childRunIds: ['run_child1'] }),
    );
    const link = within(childSection(panel)).getByRole('link', { name: 'Child run run_child1' });
    /* The visible text is the id, so the name has to END with it — the same
       relationship shape `Source`/`Parent` use, checked the same way (#1240). */
    expectAccessibleNameContainsText(link);
    expect(link).toHaveAttribute('href', '/monitor/runs/run_child1');
    /* The visible text stays the raw id — it is what the event feed and the
       runs list are keyed on, so naming the link must not cost the lookup. */
    expect(link.textContent).toBe('run_child1');
  });

  it('lists every child a re-opened call node spawned, as a list', () => {
    const panel = renderPanel(
      row({
        nodeId: 'a',
        status: 'success',
        attempts: 2,
        childRunIds: ['run_c1', 'run_c2'],
      }),
    );
    const section = childSection(panel);
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    expect(within(section).getByRole('link', { name: 'Child run run_c1' })).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Child run run_c2' })).toBeInTheDocument();
    /* The multiplicity is STRUCTURAL — a back-edge loop round spawns an
       additional child and a parallel foreach folds its items onto one row — so
       the section must say why there is more than one rather than let it read
       as a duplicate. */
    expect(section.textContent).toMatch(/loop round|foreach/);
  });

  /*
   * THE STATE THE TICKET IS ABOUT, and the one a naive `length > 0` gate ships
   * silent. The reducer parks the node on the `startChild` COMMAND; the
   * `call.started` announcement lands only after the child row exists. So a node
   * reads `waiting` with no id at all: transiently on every live spawn, and
   * permanently if the server died between the command and the append (#1041).
   * Rendering nothing there says "no children" about a node that has one.
   */
  it('says why a waiting call node has no child to show yet', () => {
    const panel = renderPanel(row({ nodeId: 'a', status: 'waiting', attempts: 1 }));
    expect(panel.textContent).toMatch(/has not been announced/);
  });

  it('does not offer that explanation once the child is announced', () => {
    const panel = renderPanel(
      row({ nodeId: 'a', status: 'waiting', attempts: 1, childRunIds: ['run_child1'] }),
    );
    expect(panel.textContent).not.toMatch(/has not been announced/);
  });

  /*
   * `childRunIds` is append-only and never cleared, so this section outlives the
   * park it was opened for. It may therefore never claim a child is RUNNING —
   * nothing on the row carries a child's status, and a `skipped` call node
   * (a container timeout via `abandonLiveChildren`) can hold one that is.
   */
  it('never claims a listed child is still running', () => {
    const panel = renderPanel(
      row({ nodeId: 'a', status: 'skipped', attempts: 1, childRunIds: ['run_c1'] }),
    );
    expect(childSection(panel).textContent).not.toMatch(/in flight|still running|is running/);
  });
});
