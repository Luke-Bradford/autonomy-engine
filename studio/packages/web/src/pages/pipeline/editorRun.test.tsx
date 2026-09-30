import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { PipelineVersionSchema } from '@autonomy-studio/shared';
import { renderWithRouter } from '../../testing/renderWithRouter';
import { emptyNodeCost, type NodeActivity } from '../runs/runSummary';
import { FlowCanvas } from './FlowCanvas';
import { createCanvasStore } from './canvasStore';
import { EditorRunDrawer } from './editorRun';
import { EditorRunContext, type EditorRunView } from './editorRunContext';

/**
 * #1395 OR4 slice 2 — the run the editor started, drawn over the AUTHORING
 * canvas and in its dock. The streaming half (`EditorRunProvider`) is the run
 * page's own fold and is exercised end to end by `e2e/editor-run.spec.ts`; these
 * pin what the canvas and the drawer do with a given view.
 */

function row(over: Partial<NodeActivity> & { nodeId: string }): NodeActivity {
  return {
    cost: emptyNodeCost(),
    costSpansInstances: false,
    toolCalls: [],
    captures: [],
    status: 'pending',
    attempts: 0,
    outputs: 0,
    lastOutputName: undefined,
    lastOutput: undefined,
    error: undefined,
    failureKind: undefined,
    failureCode: undefined,
    datasetAddresses: undefined,
    input: undefined,
    params: undefined,
    inputInstanceId: undefined,
    outputValues: undefined,
    copiedFromRunId: undefined,
    copiedChildRunId: undefined,
    variableWrite: undefined,
    instanceId: undefined,
    startedAtMs: undefined,
    endedAtMs: undefined,
    spans: [],
    childRunIds: [],
    ...over,
  };
}

function view(over: Partial<EditorRunView> = {}): EditorRunView {
  return {
    runId: 'run_1',
    overlay: new Map(),
    nodes: [],
    status: 'running',
    live: true,
    nameOf: () => null,
    ...over,
  };
}

function mountCanvas(run: EditorRunView | null) {
  const store = createCanvasStore();
  store.getState().loadVersion(
    PipelineVersionSchema.parse({
      id: 'plv_1',
      resourceId: 'res_plv1',
      pipelineId: 'pl_1',
      version: 1,
      params: [],
      outputs: [],
      nodes: [
        { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } },
        { id: 'n_b', type: 'http_request', config: {}, position: { x: 0, y: 160 } },
      ],
      edges: [],
      containers: [{ id: 'c_1', kind: 'stage', children: ['n_a', 'n_b'] }],
      catalogVersion: 1,
      createdAt: 1,
    }),
  );
  return render(
    <EditorRunContext.Provider value={run}>
      <ReactFlowProvider>
        <FlowCanvas store={store} />
      </ReactFlowProvider>
    </EditorRunContext.Provider>,
  );
}

function box(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .flow-node`);
  expect(el, `no rendered node ${id}`).not.toBeNull();
  return el!;
}

describe('the authoring canvas under an editor run', () => {
  it('draws each node’s status and measured facts under its card, in the monitor’s words', () => {
    const { container } = mountCanvas(
      view({
        overlay: new Map([
          ['n_a', { type: 'http_request', status: 'success', tone: 'success', facts: '1.5s' }],
        ]),
      }),
    );
    const a = box(container, 'n_a');
    expect(a.dataset['runStatus']).toBe('success');
    const chip = a.querySelector('[data-testid="node-run-status"]');
    expect(chip?.className).toBe('flow-node-run flow-node-run--success');
    expect(chip?.textContent).toBe('success1.5s');
    // A node the run has no entry for says nothing, rather than a guess.
    expect(box(container, 'n_b').querySelector('[data-testid="node-run-status"]')).toBeNull();
  });

  it('declines an entry for a node the draft has RE-TYPED since the run’s version', () => {
    const { container } = mountCanvas(
      view({
        overlay: new Map([
          ['n_a', { type: 'copy', status: 'success', tone: 'success', facts: '3 rows' }],
        ]),
      }),
    );
    const a = box(container, 'n_a');
    expect(a.dataset['runStatus']).toBeUndefined();
    expect(a.querySelector('[data-testid="node-run-status"]')).toBeNull();
  });

  it('adds a container’s status and progress to its label, as the monitor’s box does', () => {
    const { container } = mountCanvas(
      view({
        overlay: new Map([
          ['c_1', { type: 'stage', status: 'running', tone: 'running', facts: 'round 2' }],
        ]),
      }),
    );
    expect(container.querySelector('.flow-container-label')?.textContent).toBe(
      'stage 1 · running · round 2',
    );
  });

  it('declines a container entry once the draft’s box is a different KIND', () => {
    const { container } = mountCanvas(
      view({
        overlay: new Map([
          ['c_1', { type: 'loop', status: 'running', tone: 'running', facts: null }],
        ]),
      }),
    );
    expect(container.querySelector('.flow-container-label')?.textContent).toBe('stage 1');
    expect(container.querySelector('.flow-container')?.getAttribute('data-run-status')).toBeNull();
  });

  it('draws nothing at all with no run', () => {
    const { container } = mountCanvas(null);
    expect(container.querySelector('[data-testid="node-run-status"]')).toBeNull();
    expect(container.querySelector('.flow-container-label')?.textContent).toBe('stage 1');
  });
});

describe('EditorRunDrawer', () => {
  const run = view({
    nodes: [
      row({
        nodeId: 'n_a',
        status: 'success',
        attempts: 1,
        outputValues: { status: 200 },
      }),
    ],
    status: 'success',
    live: false,
    nameOf: (id) => (id === 'n_a' ? 'HTTP Request 1' : null),
  });

  function mountDrawer(
    value: EditorRunView | null,
    nodeId: string | null,
    type: string | null = 'http_request',
  ) {
    return renderWithRouter(
      <EditorRunContext.Provider value={value}>
        <EditorRunDrawer nodeId={nodeId} type={type} />
      </EditorRunContext.Provider>,
    );
  }

  it('shows the selected node’s part in the run, and the way to the whole run', () => {
    mountDrawer(run, 'n_a');
    expect(screen.getByRole('complementary', { name: 'Node HTTP Request 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open full run' }).getAttribute('href')).toContain(
      'run_1',
    );
  });

  it('shows nothing for a node the run has no row for, or with no run', () => {
    const { container } = mountDrawer(run, 'n_b');
    expect(container.innerHTML).toBe('');
    const again = mountDrawer(null, 'n_a');
    expect(again.container.innerHTML).toBe('');
  });

  it('shows nothing for a node the draft has RE-TYPED since the run — as the chip does', () => {
    const typed = {
      ...run,
      overlay: new Map([
        ['n_a', { type: 'http_request', status: 'success', tone: 'success' as const, facts: null }],
      ]),
    };
    expect(mountDrawer(typed, 'n_a', 'copy').container.innerHTML).toBe('');
    expect(mountDrawer(typed, 'n_a', 'http_request').container.innerHTML).not.toBe('');
  });

  it('Close hides it for that node', async () => {
    const { container } = mountDrawer(run, 'n_a');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(container.innerHTML).toBe('');
  });
});
