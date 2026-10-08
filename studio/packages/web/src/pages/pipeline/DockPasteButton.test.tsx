import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PipelineVersionSchema } from '@autonomy-studio/shared';
import { DockPasteButton } from './DockPasteButton';
import { createCanvasStore } from './canvasStore';
import { clearClipboard } from './clipboard';
import { PASTE_BUSY_NOTICE } from './paste';

function loaded() {
  const store = createCanvasStore();
  store.getState().loadVersion(
    PipelineVersionSchema.parse({
      id: 'plv_1',
      resourceId: 'res_plv1',
      pipelineId: 'pl_1',
      version: 1,
      params: [],
      outputs: [],
      nodes: [{ id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
      catalogVersion: 1,
      createdAt: 1,
    }),
  );
  return store;
}

describe('DockPasteButton (U21, moved to the dock header by #1477 OR29)', () => {
  it('pastes what was copied, and says how much', () => {
    clearClipboard();
    const store = loaded();
    store.getState().setSelection([{ kind: 'node', id: 'n_a' }]);
    store.getState().copySelection('pl_1');
    store.getState().setSelection([]);

    const notices: string[] = [];
    render(<DockPasteButton store={store} pipelineId="pl_1" onNotice={(m) => notices.push(m)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));

    expect(store.getState().nodes).toHaveLength(2);
    expect(store.getState().past).toHaveLength(1);
    expect(notices).toEqual(['Pasted 1 activity.']);
  });

  it('is ALWAYS enabled — the refusal is more use said than hidden', () => {
    clearClipboard();
    const notices: string[] = [];
    render(
      <DockPasteButton store={loaded()} pipelineId="pl_1" onNotice={(m) => notices.push(m)} />,
    );
    // A greyed button cannot explain WHY it is grey, and "nothing copied yet"
    // and "copied from another pipeline" are different answers.
    const button = screen.getByRole('button', { name: 'Paste' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toMatch(/^Pasted/);
  });

  it('refuses while a save or restore is in flight, as ⌘V does, and says so', () => {
    clearClipboard();
    const store = loaded();
    store.getState().setSelection([{ kind: 'node', id: 'n_a' }]);
    store.getState().copySelection('pl_1');
    store.getState().setSelection([]);

    const notices: string[] = [];
    render(
      <DockPasteButton store={store} pipelineId="pl_1" onNotice={(m) => notices.push(m)} busy />,
    );
    const button = screen.getByRole('button', { name: 'Paste' });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(store.getState().nodes).toHaveLength(1);
    expect(notices).toEqual([PASTE_BUSY_NOTICE]);
  });
});
