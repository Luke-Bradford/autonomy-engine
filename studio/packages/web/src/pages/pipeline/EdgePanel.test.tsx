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
 *  question about which outcomes are OFFERED. */
function mount(edge: Edge, nodes: Node[], edges: Edge[] = [edge]) {
  const store = createCanvasStore();
  render(<EdgePanel store={store} edge={edge} nodes={nodes} edges={edges} />);
  return { store, group: outcomeGroup() };
}

/** The `Fires on` radio group (U19 slice 2 — no longer a `<select>`). */
function outcomeGroup(): HTMLFieldSetElement {
  return screen.getByRole('group', { name: /Fires on/ }) as HTMLFieldSetElement;
}

/** Every outcome radio, in render order, with the text an operator reads. */
function radios(): { value: string; label: string; disabled: boolean; checked: boolean }[] {
  return [...outcomeGroup().querySelectorAll('input[type="radio"]')].map((input) => {
    const el = input as HTMLInputElement;
    return {
      value: el.value,
      label: (el.closest('label')?.textContent ?? '').trim(),
      disabled: el.disabled,
      checked: el.checked,
    };
  });
}

/** The radio carrying `value`, or undefined. */
function radio(value: string): HTMLInputElement | undefined {
  return [...outcomeGroup().querySelectorAll('input[type="radio"]')].find(
    (i) => (i as HTMLInputElement).value === value,
  ) as HTMLInputElement | undefined;
}

/** The value currently CHECKED — the panel's statement of what the edge holds. */
function checkedValue(): string | null {
  return radios().find((r) => r.checked)?.value ?? null;
}

/** Labels of the offered OPERATIONAL outcomes (`op:` prefix), in order. */
function operationalLabels(): string[] {
  return radios()
    .filter((r) => r.value.startsWith('op:'))
    .map((r) => r.label);
}

/** Labels of the offered BRANCH arms, or null when none are offered at all. */
function branchLabels(): string[] | null {
  const arms = radios().filter((r) => r.value.startsWith('branch:'));
  return arms.length === 0 ? null : arms.map((r) => r.label);
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
  return { store };
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
    expect(operationalLabels()).toEqual(['success', 'failure', 'completion', 'skipped']);
  });

  it('authors the picked outcome through the store', () => {
    const { store } = mountAgainstStore({ id: 'e1', from: 'n_a', to: 'n_b', on: 'success' }, [
      node('n_a', 'http_request'),
      node('n_b', 'http_request'),
    ]);
    fireEvent.click(radio('op:skipped')!);
    expect(store.getState().edges[0]).toMatchObject({ id: 'e1', on: 'skipped' });
  });

  it('authors a BUSINESS branch through the same picker', () => {
    const { store } = mountAgainstStore({ id: 'e1', from: 'n_if', to: 'n_b', on: 'success' }, [
      node('n_if', 'if'),
      node('n_b', 'http_request'),
    ]);
    fireEvent.click(radio('branch:false')!);
    expect(store.getState().edges[0]).toMatchObject({ on: 'branch', branch: 'false' });
  });
});

describe('EdgePanel — branch picker', () => {
  it('offers no Branch group when the source cannot emit a branch', () => {
    mount({ id: 'e1', from: 'n_a', to: 'n_b', on: 'success' }, [node('n_a', 'http_request')]);
    expect(branchLabels()).toBeNull();
  });

  it('offers an `if`s two arms', () => {
    mount({ id: 'e1', from: 'n_if', to: 'n_b', on: 'success' }, [node('n_if', 'if')]);
    expect(branchLabels()).toEqual(['true', 'false']);
  });

  it('offers a `switch`s configured cases plus the implicit default', () => {
    mount({ id: 'e1', from: 'n_sw', to: 'n_b', on: 'success' }, [
      node('n_sw', 'switch', { cases: ['approve', 'reject'] }),
    ]);
    expect(branchLabels()).toEqual(['approve', 'reject', 'default']);
  });

  /**
   * A `switch` case label is an arbitrary string, so `cases: ['success']` is a
   * legal doc. With untagged option values the two `success` options would be
   * indistinguishable to the change handler and picking the BUSINESS branch
   * would silently author the OPERATIONAL outcome.
   */
  it('keeps a case label colliding with an operational outcome distinguishable', () => {
    mount({ id: 'e1', from: 'n_sw', to: 'n_b', on: 'success' }, [
      node('n_sw', 'switch', { cases: ['success'] }),
    ]);
    const values = radios().map((r) => r.value);
    expect(new Set(values).size).toBe(values.length); // no two radios share a value
    expect(values).toContain('op:success');
    expect(values).toContain('branch:success');
  });

  it('renders a branch edge selected on its own arm, not on the first option', () => {
    mount({ id: 'e1', from: 'n_if', to: 'n_b', on: 'branch', branch: 'false' }, [
      node('n_if', 'if'),
    ]);
    expect(checkedValue()).toBe('branch:false');
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
  it('STATES the orphaned value rather than lying, and offers no radio for it', () => {
    mount(
      { id: 'e1', from: 'n_sw', to: 'n_b', on: 'branch', branch: 'gone' },
      [node('n_sw', 'switch', { cases: ['approve'] })], // 'gone' was removed
    );
    // Not a CHOICE — no radio carries it, so it cannot be re-picked...
    expect(radio('branch:gone')).toBeUndefined();
    expect(checkedValue()).toBeNull();
    // ...but the panel still STATES what the doc holds, rather than silently
    // reading as one of the outcomes that IS offered.
    expect(within(outcomeGroup()).getByText(/^gone — not offered/)).toBeTruthy();
  });

  it('shows a branch edge off a NON-branching source the same way', () => {
    mount({ id: 'e1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' }, [
      node('n_a', 'http_request'),
    ]);
    expect(branchLabels()).toBeNull();
    expect(checkedValue()).toBeNull();
    expect(within(outcomeGroup()).getByText(/^true — not offered/)).toBeTruthy();
  });

  /**
   * The orphan note has to reach a SCREEN READER, not just the page.
   *
   * With no radio checked, someone tabbing into the group lands on an unchecked
   * `success` — so a loose sibling paragraph is read only in browse mode and the
   * edge's actual value goes unannounced in focus mode. The old `<select>` got
   * this for free by BEING the value. `aria-describedby` puts it back.
   */
  it('ties the orphan note to the group, so focusing it announces the truth', () => {
    mount({ id: 'e1', from: 'n_sw', to: 'n_b', on: 'branch', branch: 'gone' }, [
      node('n_sw', 'switch', { cases: ['approve'] }),
    ]);
    const described = outcomeGroup().getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(document.getElementById(described!)?.textContent).toMatch(/^gone — not offered/);
  });

  /** ...and no dangling reference when there is nothing to describe. */
  it('leaves the group undescribed when the condition IS offered', () => {
    mount({ id: 'e1', from: 'n_a', to: 'n_b', on: 'success' }, [node('n_a', 'http_request')]);
    expect(outcomeGroup().getAttribute('aria-describedby')).toBeNull();
  });

  /** An edge endpoint may be a CONTAINER id, or a deleted node. Degrade. */
  it('degrades to the operational outcomes when the source node is absent', () => {
    mount({ id: 'e1', from: 'c_loop', to: 'n_b', on: 'success' }, []);
    expect(operationalLabels()).toEqual(['success', 'failure', 'completion', 'skipped']);
    expect(branchLabels()).toBeNull();
    expect(checkedValue()).toBe('op:success');
  });
});

/**
 * `rewireEdge` REFUSES a retype that would duplicate another edge. A refusal the
 * operator cannot see is a control that silently does nothing: they pick
 * `failure`, React re-renders from the unchanged store, and the radio snaps back
 * with no explanation. The choice is disabled instead.
 */
describe('EdgePanel — a condition another edge already holds', () => {
  const subject: Edge = { id: 'e1', from: 'n_a', to: 'n_b', on: 'success' };
  const sibling: Edge = { id: 'e2', from: 'n_a', to: 'n_b', on: 'failure' };

  it('disables the taken option and says why', () => {
    mount(subject, [node('n_a', 'http_request')], [subject, sibling]);
    const taken = radios().find((r) => r.value === 'op:failure')!;
    expect(taken.disabled).toBe(true);
    expect(taken.label).toMatch(/^failure — already used/);
  });

  it('leaves every other option, and the edge’s OWN condition, selectable', () => {
    mount(subject, [node('n_a', 'http_request')], [subject, sibling]);
    for (const on of ['success', 'completion', 'skipped']) {
      expect(radio(`op:${on}`)!.disabled).toBe(false);
    }
    // ...and the edge's own condition stays CHECKED, not merely selectable.
    expect(checkedValue()).toBe('op:success');
  });

  /** Only edges between the SAME pair collide — the key includes both ends. */
  it('ignores an edge with the same condition between a different pair', () => {
    const elsewhere: Edge = { id: 'e2', from: 'n_a', to: 'n_c', on: 'failure' };
    mount(subject, [node('n_a', 'http_request')], [subject, elsewhere]);
    expect(radio('op:failure')!.disabled).toBe(false);
  });

  it('disables a taken BRANCH arm, not just an operational outcome', () => {
    const s: Edge = { id: 'e1', from: 'n_if', to: 'n_b', on: 'success' };
    const other: Edge = { id: 'e2', from: 'n_if', to: 'n_b', on: 'branch', branch: 'true' };
    mount(s, [node('n_if', 'if')], [s, other]);
    const takenArm = radios().find((r) => r.value === 'branch:true')!;
    expect(takenArm.disabled).toBe(true);
    expect(takenArm.label).toMatch(/^true — already used/);
    expect(radio('branch:false')!.disabled).toBe(false);
  });
});

/**
 * U6e — the bounce cap.
 *
 * The one number that decides whether an authored loop terminates: a back-edge
 * with no `maxBounces` is refused by the save gate, and one with the wrong cap
 * silently either loops too long or fails as `capped`.
 */
describe('EdgePanel — a back-edge bounce cap', () => {
  const NODES = [node('a', 'http_request'), node('b', 'llm_call')];
  const back = (maxBounces = 10): Edge =>
    ({ id: 'e_back', from: 'b', to: 'a', on: 'success', back: true, maxBounces }) as Edge;

  function mountBack(edge = back()) {
    const store = createCanvasStore();
    store.getState().loadVersion(
      PipelineVersionSchema.parse({
        id: 'plv_1',
        resourceId: 'res_1',
        pipelineId: 'pl_1',
        version: 1,
        params: [],
        outputs: [],
        nodes: NODES,
        edges: [{ id: 'e_fwd', from: 'a', to: 'b', on: 'success' }, edge],
        containers: [],
        catalogVersion: 1,
        createdAt: 1,
      }),
    );
    render(<EdgePanel store={store} edge={edge} nodes={NODES} edges={[edge]} />);
    return { store, field: screen.getByLabelText(/Bounce cap/) as HTMLInputElement };
  }

  it('names the element a back-edge and shows the stored cap', () => {
    const { field } = mountBack(back(4));
    expect(screen.getByRole('heading').textContent).toBe('Back-edge');
    expect(field.value).toBe('4');
  });

  it('is absent for a forward edge, which has no cap to set', () => {
    mount({ id: 'e_1', from: 'a', to: 'b', on: 'success' } as Edge, NODES);
    expect(screen.getByRole('heading').textContent).toBe('Edge');
    expect(screen.queryByLabelText(/Bounce cap/)).toBeNull();
  });

  it('commits a new cap on blur', () => {
    const { store, field } = mountBack();
    fireEvent.change(field, { target: { value: '3' } });
    fireEvent.blur(field, { target: { value: '3' } });
    expect(store.getState().edges.find((e) => e.id === 'e_back')?.maxBounces).toBe(3);
  });

  it('accepts 0 — a back-edge that never bounces is a savable doc', () => {
    const { store, field } = mountBack();
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.blur(field, { target: { value: '0' } });
    expect(store.getState().edges.find((e) => e.id === 'e_back')?.maxBounces).toBe(0);
  });

  /**
   * The refusal has to be VISIBLE and has to KEEP the operator's text. Silently
   * reverting the field is the defect class U6a fixed in the condition picker:
   * a control that appears to accept a value and does nothing.
   */
  it.each([
    ['1.5', 'a fraction'],
    ['-2', 'a negative'],
    ['', 'an emptied field'],
  ])('refuses %s (%s) out loud, without reverting or writing', (typed) => {
    const { store, field } = mountBack(back(6));
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.blur(field, { target: { value: typed } });
    expect(store.getState().edges.find((e) => e.id === 'e_back')?.maxBounces).toBe(6);
    expect(field.value).toBe(typed);
    expect(screen.getByRole('alert').textContent).toMatch(/whole number/);
  });

  /**
   * `Number('')` is 0, so an emptied field would commit a cap of ZERO — a legal
   * value with entirely different behaviour — if the blank were not caught
   * before the numeric test. Pinned separately from the refusal above because
   * this is the one bad value that would have been stored SILENTLY.
   */
  it.each([
    ['', 'cleared to retype'],
    ['abc', 'non-numeric text, which a number input reports as blank'],
  ])('does not read a blank field (%s) as a cap of zero', (typed) => {
    const { store, field } = mountBack(back(6));
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.blur(field, { target: { value: typed } });
    expect(store.getState().edges.find((e) => e.id === 'e_back')?.maxBounces).toBe(6);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  /**
   * Reverting to the STORED value after a refusal must clear the banner.
   *
   * The no-op-blur guard returns before the write, and used to return before
   * the error was cleared too — so typing `1.5`, blurring, then retyping the
   * original cap and blurring left the banner asserting "not a whole number"
   * over a field showing a valid, unchanged value. The write is what a no-op
   * blur skips; the acknowledgement is not.
   */
  it('clears a standing error when the field is put back to the stored value', () => {
    const { store, field } = mountBack(back(6));
    fireEvent.change(field, { target: { value: '1.5' } });
    fireEvent.blur(field, { target: { value: '1.5' } });
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.change(field, { target: { value: '6' } });
    fireEvent.blur(field, { target: { value: '6' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.getState().edges.find((e) => e.id === 'e_back')?.maxBounces).toBe(6);
  });

  /**
   * A back-edge that declares NO cap — the imported / pre-#444 doc this feature
   * keeps invoking. The field must not show `10` for it: that states a cap the
   * doc does not hold (against the canvas' own `×?` and the aria-label's "no
   * bounce cap declared"), and because `commit` early-returns on
   * `text === stored` it made the field a DEAD END — the operator sees `10`,
   * types `10`, nothing is written, and the doc stays unsavable.
   */
  describe('a back-edge with no declared cap', () => {
    const capless = { id: 'e_back', from: 'b', to: 'a', on: 'success', back: true } as Edge;

    it('renders empty rather than inventing the default', () => {
      const { field } = mountBack(capless);
      expect(field.value).toBe('');
    });

    it('accepts the default typed in — the field is not a dead end', () => {
      const { store, field } = mountBack(capless);
      fireEvent.change(field, { target: { value: '10' } });
      fireEvent.blur(field, { target: { value: '10' } });
      expect(store.getState().edges.find((e) => e.id === 'e_back')?.maxBounces).toBe(10);
    });
  });

  it('a blur that changed nothing does not dirty the doc', () => {
    const { store, field } = mountBack(back(6));
    store.setState({ dirty: false });
    fireEvent.blur(field, { target: { value: '6' } });
    expect(store.getState().dirty).toBe(false);
  });
});
