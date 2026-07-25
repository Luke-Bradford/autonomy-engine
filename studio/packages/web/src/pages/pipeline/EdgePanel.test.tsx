import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PipelineVersionSchema, type Edge, type Node } from '@autonomy-studio/shared';
import { EdgePanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';

const node = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({
  id,
  type,
  config,
  position: { x: 0, y: 0 },
});

/** Mounts the panel over an edge the store does NOT hold — enough for every
 *  question about which options are OFFERED. */
function mount(edge: Edge, nodes: Node[], edges: Edge[] = [edge]) {
  const store = createCanvasStore();
  render(<EdgePanel store={store} edge={edge} nodes={nodes} edges={edges} />);
  return { store, select: screen.getByLabelText(/Fires on/) as HTMLSelectElement };
}

/** Mounts the panel over an edge the store really holds, so a pick can be
 *  asserted where it lands: in the working graph. */
function mountAgainstStore(edge: Edge, nodes: Node[]) {
  const store = createCanvasStore();
  store.getState().loadVersion(
    PipelineVersionSchema.parse({
      id: 'plv_1',
      resourceId: 'res_1',
      pipelineId: 'pl_1',
      version: 1,
      params: [],
      outputs: [],
      nodes,
      edges: [edge],
      containers: [],
      catalogVersion: 1,
      createdAt: 1,
    }),
  );
  render(<EdgePanel store={store} edge={edge} nodes={nodes} edges={[edge]} />);
  return { store, select: screen.getByLabelText(/Fires on/) as HTMLSelectElement };
}

/** The option TEXT of a named `<optgroup>`, or null if the group is absent. */
function group(label: string): string[] | null {
  const g = document.querySelector(`optgroup[label="${label}"]`);
  return g === null ? null : [...g.querySelectorAll('option')].map((o) => o.textContent ?? '');
}

describe('EdgePanel — operational outcomes', () => {
  /**
   * `skipped` was pinned out of `AUTHORABLE_EDGE_ON` when #1 F1 gave the engine
   * skip routing, deferred to this ticket. The engine has routed it, the schema
   * has carried it and `validatePipelineDoc` has never refused it — only the
   * canvas could not author it.
   */
  it('offers all FOUR operational outcomes, `skipped` included', () => {
    mount({ id: 'e1', from: 'n_a', to: 'n_b', on: 'success' }, [node('n_a', 'http_request')]);
    expect(group('Outcome')).toEqual(['success', 'failure', 'completion', 'skipped']);
  });

  it('authors the picked outcome through the store', () => {
    const { store, select } = mountAgainstStore(
      { id: 'e1', from: 'n_a', to: 'n_b', on: 'success' },
      [node('n_a', 'http_request'), node('n_b', 'http_request')],
    );
    fireEvent.change(select, { target: { value: 'op:skipped' } });
    expect(store.getState().edges[0]).toMatchObject({ id: 'e1', on: 'skipped' });
  });

  it('authors a BUSINESS branch through the same picker', () => {
    const { store, select } = mountAgainstStore(
      { id: 'e1', from: 'n_if', to: 'n_b', on: 'success' },
      [node('n_if', 'if'), node('n_b', 'http_request')],
    );
    fireEvent.change(select, { target: { value: 'branch:false' } });
    expect(store.getState().edges[0]).toMatchObject({ on: 'branch', branch: 'false' });
  });
});

describe('EdgePanel — branch picker', () => {
  it('offers no Branch group when the source cannot emit a branch', () => {
    mount({ id: 'e1', from: 'n_a', to: 'n_b', on: 'success' }, [node('n_a', 'http_request')]);
    expect(group('Branch')).toBeNull();
  });

  it('offers an `if`s two arms', () => {
    mount({ id: 'e1', from: 'n_if', to: 'n_b', on: 'success' }, [node('n_if', 'if')]);
    expect(group('Branch')).toEqual(['true', 'false']);
  });

  it('offers a `switch`s configured cases plus the implicit default', () => {
    mount({ id: 'e1', from: 'n_sw', to: 'n_b', on: 'success' }, [
      node('n_sw', 'switch', { cases: ['approve', 'reject'] }),
    ]);
    expect(group('Branch')).toEqual(['approve', 'reject', 'default']);
  });

  /**
   * A `switch` case label is an arbitrary string, so `cases: ['success']` is a
   * legal doc. With untagged option values the two `success` options would be
   * indistinguishable to the change handler and picking the BUSINESS branch
   * would silently author the OPERATIONAL outcome.
   */
  it('keeps a case label colliding with an operational outcome distinguishable', () => {
    const { select } = mount({ id: 'e1', from: 'n_sw', to: 'n_b', on: 'success' }, [
      node('n_sw', 'switch', { cases: ['success'] }),
    ]);
    const values = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(new Set(values).size).toBe(values.length); // no two options share a value
    expect(values).toContain('op:success');
    expect(values).toContain('branch:success');
  });

  it('renders a branch edge selected on its own arm, not on the first option', () => {
    const { select } = mount({ id: 'e1', from: 'n_if', to: 'n_b', on: 'branch', branch: 'false' }, [
      node('n_if', 'if'),
    ]);
    expect(select.value).toBe('branch:false');
  });
});

/**
 * A `<select>` whose `value` matches no `<option>` silently renders the FIRST
 * option — the panel would then state a condition the doc does not hold. This
 * is reachable WITHOUT leaving the canvas: `declaredBranchesOf` reads a
 * `switch`'s `config.cases` live, so editing that config in the node panel can
 * un-declare a branch an existing edge still uses.
 */
describe('EdgePanel — a persisted value the source does not offer', () => {
  it('shows the orphaned value as a DISABLED option rather than lying', () => {
    const { select } = mount(
      { id: 'e1', from: 'n_sw', to: 'n_b', on: 'branch', branch: 'gone' },
      [node('n_sw', 'switch', { cases: ['approve'] })], // 'gone' was removed
    );
    expect(select.value).toBe('branch:gone');
    const orphan = screen.getByRole('option', { name: /^gone — not offered/ }) as HTMLOptionElement;
    expect(orphan.disabled).toBe(true);
  });

  it('shows a branch edge off a NON-branching source the same way', () => {
    const { select } = mount({ id: 'e1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' }, [
      node('n_a', 'http_request'),
    ]);
    expect(select.value).toBe('branch:true');
    expect(group('Branch')).toBeNull();
    expect(within(select).getByRole('option', { name: /^true — not offered/ })).toBeTruthy();
  });

  /** An edge endpoint may be a CONTAINER id, or a deleted node. Degrade. */
  it('degrades to the operational outcomes when the source node is absent', () => {
    const { select } = mount({ id: 'e1', from: 'c_loop', to: 'n_b', on: 'success' }, []);
    expect(group('Outcome')).toEqual(['success', 'failure', 'completion', 'skipped']);
    expect(group('Branch')).toBeNull();
    expect(select.value).toBe('op:success');
  });
});

/**
 * `updateEdgeCondition` REFUSES a retype that would duplicate another edge. A
 * refusal the operator cannot see is a control that silently does nothing:
 * they pick `failure`, React re-renders from the unchanged store, and the
 * select snaps back with no explanation. The option is disabled instead.
 */
describe('EdgePanel — a condition another edge already holds', () => {
  const subject: Edge = { id: 'e1', from: 'n_a', to: 'n_b', on: 'success' };
  const sibling: Edge = { id: 'e2', from: 'n_a', to: 'n_b', on: 'failure' };

  it('disables the taken option and says why', () => {
    mount(subject, [node('n_a', 'http_request')], [subject, sibling]);
    const taken = screen.getByRole('option', {
      name: /^failure — already used/,
    }) as HTMLOptionElement;
    expect(taken.disabled).toBe(true);
  });

  it('leaves every other option, and the edge’s OWN condition, selectable', () => {
    mount(subject, [node('n_a', 'http_request')], [subject, sibling]);
    for (const name of ['success', 'completion', 'skipped']) {
      expect((screen.getByRole('option', { name }) as HTMLOptionElement).disabled).toBe(false);
    }
  });

  /** Only edges between the SAME pair collide — the key includes both ends. */
  it('ignores an edge with the same condition between a different pair', () => {
    const elsewhere: Edge = { id: 'e2', from: 'n_a', to: 'n_c', on: 'failure' };
    mount(subject, [node('n_a', 'http_request')], [subject, elsewhere]);
    expect((screen.getByRole('option', { name: 'failure' }) as HTMLOptionElement).disabled).toBe(
      false,
    );
  });

  it('disables a taken BRANCH arm, not just an operational outcome', () => {
    const s: Edge = { id: 'e1', from: 'n_if', to: 'n_b', on: 'success' };
    const other: Edge = { id: 'e2', from: 'n_if', to: 'n_b', on: 'branch', branch: 'true' };
    mount(s, [node('n_if', 'if')], [s, other]);
    expect(
      (screen.getByRole('option', { name: /^true — already used/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('option', { name: 'false' }) as HTMLOptionElement).disabled).toBe(
      false,
    );
  });
});
