import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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

/**
 * #869 — the Outputs block is bounded in the DOM, not merely on screen.
 *
 * `index.css` clamped `.node-detail-outputs` to `12rem` with a scrollbar, which
 * stops a payload taking over the panel and does nothing about the document: an
 * agent node's `text` output is realistically tens of KB and a `foreach` fan-in
 * has no bound at all, and every character of it was serialized and mounted.
 *
 * The tail is exactly what someone debugging a bad output came to read, so a
 * bare truncation would trade one defect for a worse one. These pin the whole
 * contract: bounded by default, the withholding STATED, and the remainder
 * reachable — including by keyboard, and including after the panel is reused
 * for a different node.
 */
describe('NodeActivityPanel — the outputs payload is bounded in the DOM', () => {
  const CAP = 4000;
  /* A marker in the TAIL, past the cap. Asserting on it rather than on a length
     alone is what makes these tests fail for the right reason: a cap that was
     applied to the wrong end, or not at all, both move this string. */
  const TAIL = 'THE_TAIL_MARKER';
  /** A single output value whose serialization overshoots the cap by `over`. */
  function bigRow(over: number) {
    // `{"text":"…"}` — 11 characters of envelope around the padded value.
    const pad = 'x'.repeat(CAP + over - 11 - TAIL.length);
    return row({
      nodeId: 'a',
      status: 'success',
      attempts: 1,
      outputValues: { text: pad + TAIL },
    });
  }
  const outputsCode = (panel: HTMLElement): HTMLElement => {
    const el = panel.querySelector('.node-detail-outputs');
    if (el === null) throw new Error('no outputs element');
    return el as HTMLElement;
  };
  const toggle = (panel: HTMLElement) =>
    within(panel).queryByRole('button', { name: /Show (all|first)/ });

  it('leaves a payload under the cap exactly as it was, with no disclosure', () => {
    const panel = renderPanel(
      row({ nodeId: 'a', status: 'success', attempts: 1, outputValues: { text: 'short' } }),
    );
    expect(outputsCode(panel).textContent).toBe('{"text":"short"}');
    expect(toggle(panel)).toBeNull();
    expect(panel.textContent).not.toMatch(/showing the first/);
  });

  it('keeps a payload of exactly the cap whole — the boundary is not off by one', () => {
    const panel = renderPanel(bigRow(0));
    expect(outputsCode(panel).textContent).toHaveLength(CAP);
    expect(panel.textContent).toContain(TAIL);
    expect(toggle(panel)).toBeNull();
  });

  it('holds the tail of an oversized payload OUT of the DOM, and says how much', () => {
    const panel = renderPanel(bigRow(2000));
    expect(outputsCode(panel).textContent).toHaveLength(CAP);
    // Not merely short: the withheld tail is absent from the whole panel.
    expect(panel.textContent).not.toContain(TAIL);
    expect(panel.textContent).toMatch(
      new RegExp(`showing the first ${CAP} of ${CAP + 2000} characters`),
    );
    expect(toggle(panel)).toHaveAttribute('aria-expanded', 'false');
  });

  it('reveals the remainder on request, and takes it back', async () => {
    const user = userEvent.setup();
    const panel = renderPanel(bigRow(2000));
    const button = toggle(panel);
    if (button === null) throw new Error('no disclosure');

    await user.click(button);
    expect(outputsCode(panel).textContent).toHaveLength(CAP + 2000);
    expect(panel.textContent).toContain(TAIL);
    expect(toggle(panel)).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle(panel) as HTMLElement);
    expect(outputsCode(panel).textContent).toHaveLength(CAP);
    expect(panel.textContent).not.toContain(TAIL);
  });

  /*
   * The reveal is a `<button>` so that it answers the keyboard, not the pointer
   * alone. A `div` with an onClick would pass every assertion above and be
   * unreachable for anyone not using a mouse.
   */
  it('reveals by keyboard as well as by pointer', async () => {
    const user = userEvent.setup();
    const panel = renderPanel(bigRow(2000));
    (toggle(panel) as HTMLElement).focus();
    await user.keyboard('{Enter}');
    expect(panel.textContent).toContain(TAIL);
  });

  /*
   * `RunDetailPage` swaps this panel IN PLACE when another node is opened — it
   * is not remounted. Without an identity key on the section, `expanded` would
   * survive the swap and mount the NEXT node's whole un-requested payload: the
   * cap defeated by the control that relieves it.
   */
  it('does not carry an expansion from one node onto the next', async () => {
    /* A harness that SWAPS the node prop on a mounted panel, which is what
       `RunDetailPage` does — deliberately not RTL's `rerender`, which would
       replace the router wrapper `renderWithRouter` provides and take the
       reconciliation being tested with it. */
    function Swapper({ nodes }: { nodes: NodeActivity[] }) {
      const [i, setI] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setI(1)}>
            open the next node
          </button>
          <NodeActivityPanel node={nodes[i] as NodeActivity} name={null} onClose={vi.fn()} />
        </>
      );
    }
    const user = userEvent.setup();
    renderWithRouter(<Swapper nodes={[bigRow(2000), { ...bigRow(2000), nodeId: 'b' }]} />);

    await user.click(screen.getByRole('button', { name: /Show all/ }));
    expect(screen.getByRole('complementary').textContent).toContain(TAIL);

    await user.click(screen.getByRole('button', { name: 'open the next node' }));
    const panel = screen.getByRole('complementary');
    expect(outputsCode(panel).textContent).toHaveLength(CAP);
    expect(panel.textContent).not.toContain(TAIL);
  });
});
