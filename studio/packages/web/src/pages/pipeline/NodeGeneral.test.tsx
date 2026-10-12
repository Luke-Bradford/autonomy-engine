import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NodeSchema, fieldLabelOf, type Node } from '@autonomy-studio/shared';
import { createCanvasStore } from './canvasStore';
import { NodeGeneral } from './NodeGeneral';

/**
 * #1669 — the General tab's Activity state and Mark as (#1600 C0c), over a real
 * store: every assertion is about what the form wrote to the doc, or how it
 * presents the doc it was given.
 */
function mount(extra: Partial<Node> = {}) {
  const store = createCanvasStore();
  const target: Node = { id: 'a', type: 'http_request', config: {}, position: { x: 0, y: 0 } };
  store.setState({ nodes: [{ ...target, ...extra }], edges: [], containers: [] });
  render(<NodeGeneral store={store} nodeId="a" />);
  return {
    stored: () => store.getState().nodes[0]!,
    state: () => screen.getByRole('combobox', { name: 'Activity state' }),
    markAs: () => screen.getByRole('combobox', { name: 'Mark as' }),
  };
}

describe('NodeGeneral — Activity state and Mark as (#1600 C0c)', () => {
  it('keeps Mark as visible but disabled while the activity is active', () => {
    const f = mount();
    expect(f.state()).toHaveValue('active');
    expect(f.markAs()).toBeDisabled();
    expect(f.markAs()).toHaveValue('success');
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

  it('writes the state and the mark through, and keeps the mark when re-activated', () => {
    const f = mount();
    fireEvent.change(f.state(), { target: { value: 'inactive' } });
    expect(f.stored().state).toBe('inactive');
    expect(f.markAs()).toBeEnabled();

    fireEvent.change(f.markAs(), { target: { value: 'failure' } });
    expect(f.stored().onInactiveMarkAs).toBe('failure');

    fireEvent.change(f.state(), { target: { value: 'active' } });
    // Absent, never 'active', so an active doc is byte-identical to a pre-C0c one.
    expect('state' in f.stored()).toBe(false);
    expect(f.markAs()).toBeDisabled();
    expect(f.markAs()).toHaveValue('failure');
  });

  it("describes each select by its own ? help, from the schema's description", () => {
    const f = mount({ state: 'inactive' });
    for (const [select, field] of [
      [f.state(), NodeSchema.shape.state],
      [f.markAs(), NodeSchema.shape.onInactiveMarkAs],
    ] as const) {
      const note = fieldLabelOf(field)!.description!;
      expect(select).toHaveAccessibleDescription(expect.stringContaining(note.slice(0, 40)));
    }
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

  it('is not offered on an activity the engine evaluates, which would never record them', () => {
    mountAs('if');
    expect(screen.queryByRole('button', { name: 'Add user property' })).toBeNull();
  });

  it('still shows ones such an activity already holds, so the refusal can be acted on', () => {
    mountAs('if', { userProperties: [{ name: 'a', value: 'b' }] });
    expect(screen.getByLabelText('User property 1 name')).toHaveValue('a');
  });
});
