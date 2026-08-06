import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import { MultiSelectionPanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';

/**
 * U21 — the property panel's MANY-selected state.
 *
 * What it has to get right is the COUNT it reports, because that count is what
 * the operator judges the delete by: React Flow selects every edge incident to
 * a lassoed node, so a two-node marquee routinely carries connections nobody
 * aimed at, and the panel is the only place that says so before they go.
 */

function version(overrides: Partial<PipelineVersion> = {}): PipelineVersion {
  return PipelineVersionSchema.parse({
    id: 'plv_1',
    resourceId: 'res_plv1',
    pipelineId: 'pl_1',
    version: 1,
    params: [],
    outputs: [],
    nodes: [
      { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } },
      { id: 'n_b', type: 'http_request', config: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' }],
    containers: [],
    catalogVersion: 1,
    createdAt: 1,
    ...overrides,
  });
}

function loaded() {
  const s = createCanvasStore();
  s.getState().loadVersion(version());
  return s;
}

describe('MultiSelectionPanel (U21)', () => {
  it('counts the activities AND the connections that came with them', () => {
    const store = loaded();
    render(
      <MultiSelectionPanel
        store={store}
        selection={[
          { kind: 'node', id: 'n_a' },
          { kind: 'node', id: 'n_b' },
          { kind: 'edge', id: 'e_1' },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { name: '3 selected' })).toBeTruthy();
    expect(screen.getByText(/2 activities, 1 connection\./)).toBeTruthy();
  });

  it('says nothing about connections when none are selected', () => {
    const store = loaded();
    render(
      <MultiSelectionPanel
        store={store}
        selection={[
          { kind: 'node', id: 'n_a' },
          { kind: 'node', id: 'n_b' },
        ]}
      />,
    );
    expect(screen.getByText(/^2 activities\./)).toBeTruthy();
    expect(screen.queryByText(/connection/)).toBeNull();
  });

  it('is SINGULAR where the count is one', () => {
    // Reachable with one activity and one of its edges — "1 activities,
    // 1 connections" is the kind of wrong that makes a reader distrust the
    // number next to a delete button.
    const store = loaded();
    render(
      <MultiSelectionPanel
        store={store}
        selection={[
          { kind: 'node', id: 'n_a' },
          { kind: 'edge', id: 'e_1' },
        ]}
      />,
    );
    expect(screen.getByText(/^1 activity, 1 connection\./)).toBeTruthy();
  });

  it('deletes everything selected, in one undo entry', () => {
    const store = loaded();
    store.getState().setSelection([
      { kind: 'node', id: 'n_a' },
      { kind: 'node', id: 'n_b' },
    ]);
    render(<MultiSelectionPanel store={store} selection={store.getState().selected} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete selection' }));

    const st = store.getState();
    expect(st.nodes).toHaveLength(0);
    // The edge went with them — a cascade, not a separate act.
    expect(st.edges).toHaveLength(0);
    expect(st.past).toHaveLength(1);
  });
});
