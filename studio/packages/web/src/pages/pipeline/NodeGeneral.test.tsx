import { describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NodeSchema, fieldLabelOf, type Node } from '@autonomy-studio/shared';
import { createCanvasStore } from './canvasStore';
import { NodeGeneral } from './NodeGeneral';

/**
 * #1669 — the General tab's Mark as (#1600 C0c), over a real store: every
 * assertion is about what the form wrote to the doc, or how it presents the doc
 * it was given. #1694 OR42 — Activity state is no longer a field here: the
 * canvas switches an activity off, and Mark as shows only while it is.
 */
function mount(extra: Partial<Node> = {}) {
  const store = createCanvasStore();
  const target: Node = { id: 'a', type: 'http_request', config: {}, position: { x: 0, y: 0 } };
  store.setState({ nodes: [{ ...target, ...extra }], edges: [], containers: [] });
  render(<NodeGeneral store={store} nodeId="a" />);
  return {
    store,
    stored: () => store.getState().nodes[0]!,
    markAs: () => screen.getByRole('combobox', { name: 'Mark as' }),
  };
}

describe('NodeGeneral — Mark as (#1600 C0c, #1694 OR42)', () => {
  it('has no Activity state field, and no Mark as while the activity is active', () => {
    mount({ onInactiveMarkAs: 'failure' });
    expect(screen.queryByRole('combobox', { name: 'Activity state' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Mark as' })).toBeNull();
  });

  it("names Mark as's options in ADF's words, storing the engine's", () => {
    const f = mount({ state: 'inactive' });
    const options = Array.from((f.markAs() as HTMLSelectElement).options);
    expect(options.map((o) => [o.value, o.textContent])).toEqual([
      ['success', 'Succeeded'],
      ['failure', 'Failed'],
      ['skipped', 'Skipped'],
    ]);
  });

  it('appears when the activity is switched off, writes through, and keeps the mark when re-activated', () => {
    const f = mount();
    act(() => void f.store.getState().setNodesInactive(['a'], true));
    fireEvent.change(f.markAs(), { target: { value: 'failure' } });
    expect(f.stored().onInactiveMarkAs).toBe('failure');

    act(() => void f.store.getState().setNodesInactive(['a'], false));
    expect(screen.queryByRole('combobox', { name: 'Mark as' })).toBeNull();
    // Absent, never 'active', so an active doc is byte-identical to a pre-C0c one.
    expect('state' in f.stored()).toBe(false);
    expect(f.stored().onInactiveMarkAs).toBe('failure');
    act(() => void f.store.getState().setNodesInactive(['a'], true));
    expect(f.markAs()).toHaveValue('failure');
  });

  it("describes Mark as by its own ? help, from the schema's description", () => {
    const f = mount({ state: 'inactive' });
    const note = fieldLabelOf(NodeSchema.shape.onInactiveMarkAs)!.description!;
    expect(f.markAs()).toHaveAccessibleDescription(expect.stringContaining(note.slice(0, 40)));
  });
});

describe('NodeGeneral — User properties (#1600 C0d)', () => {
  const mountAs = (type: string, extra: Partial<Node> = {}) => {
    const store = createCanvasStore();
    store.setState({
      nodes: [{ id: 'a', type, config: {}, position: { x: 0, y: 0 }, ...extra }],
      edges: [],
      containers: [],
    });
    render(<NodeGeneral store={store} nodeId="a" />);
    return () => store.getState().nodes[0]!;
  };
  const add = () => screen.getByRole('button', { name: 'Add user property' });

  it('adds rows that write name and value straight to the doc, up to five', () => {
    const stored = mountAs('http_request');
    fireEvent.click(add());
    fireEvent.change(screen.getByLabelText('User property 1 name'), {
      target: { value: 'File' },
    });
    fireEvent.change(screen.getByLabelText('User property 1 value'), {
      target: { value: '${params.file}' },
    });
    expect(stored().userProperties).toEqual([{ name: 'File', value: '${params.file}' }]);
    for (let i = 0; i < 4; i += 1) fireEvent.click(add());
    expect(stored().userProperties).toHaveLength(5);
    expect(add()).toBeDisabled();
  });

  it('removing the last row removes the key', () => {
    const stored = mountAs('http_request', { userProperties: [{ name: 'a', value: 'b' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove user property 1' }));
    expect('userProperties' in stored()).toBe(false);
  });

  it('is offered on an activity the engine evaluates and on a pipeline call (#1673)', () => {
    const stored = mountAs('if');
    fireEvent.click(add());
    fireEvent.change(screen.getByLabelText('User property 1 name'), { target: { value: 'Why' } });
    expect(stored().userProperties).toEqual([{ name: 'Why', value: '' }]);
    cleanup();
    mountAs('execute_pipeline', { call: { pipelineVersionId: 'pv', params: {} } });
    expect(add()).toBeEnabled();
  });
});
