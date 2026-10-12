import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@autonomy-studio/shared';
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

  it('describes each select by its ? help', () => {
    const f = mount({ state: 'inactive' });
    for (const select of [f.state(), f.markAs()]) {
      expect(select).toHaveAccessibleDescription(/\S/);
    }
  });
});
