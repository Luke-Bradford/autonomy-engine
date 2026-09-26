import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Container, Node, Param } from '@autonomy-studio/shared';
import { ContainerPanel } from './ContainerPanel';

/**
 * U23 — the container config form, at the tier most of it belongs to.
 *
 * `ContainerPanel` is the only one of the four panels that takes plain props and
 * an `onApply` callback rather than a live store, so its whole decision surface
 * — which fields it offers, what it refuses, what it hands back — is reachable
 * in jsdom. `e2e/container-config.spec.ts` keeps the three things that genuinely
 * need a browser: the ⚙ inside a derived box jsdom cannot lay out, the pane
 * click, and the save round-trip proving the edit reached an immutable version.
 */

const NODES: Node[] = [
  { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } },
  { id: 'n_b', type: 'http_request', config: {}, position: { x: 0, y: 100 } },
];

const LOOP: Container = {
  id: 'loop_1',
  kind: 'loop',
  children: ['n_a'],
  exitWhen: '${equals(1, 1)}',
};

/** `before` sits EARLIER in the doc, which is what decides the within-kind ordinal. */
function mount(container: Container, before: Container[] = []) {
  const onApply = vi.fn();
  const containers = [...before, container];
  render(
    <ContainerPanel
      container={container}
      nodes={NODES}
      edges={[]}
      containers={containers}
      params={[]}
      onApply={onApply}
      onCopy={() => {}}
      onDuplicate={() => {}}
    />,
  );
  return onApply;
}

/** The last container `onApply` was handed, which is what the store would store. */
function applied(onApply: ReturnType<typeof vi.fn>): Container {
  expect(onApply).toHaveBeenCalledTimes(1);
  return onApply.mock.calls[0]![0] as Container;
}

function apply() {
  fireEvent.click(screen.getByRole('button', { name: 'Apply container settings' }));
}

describe('ContainerPanel — which fields it offers', () => {
  it('offers a loop its own fields and none of the foreach-only ones', () => {
    mount(LOOP);
    for (const name of [/^exitWhen/, /^maxRounds/, /^timeout/, /^join/]) {
      expect(screen.getByLabelText(name)).toBeDefined();
    }
    expect(screen.queryByLabelText(/^items/)).toBeNull();
    expect(screen.queryByLabelText(/^batchCount/)).toBeNull();
  });

  it('offers a foreach its own fields and none of the loop-only ones', () => {
    mount({ id: 'fe_1', kind: 'foreach', children: ['n_a'], items: '${createArray(1)}' });
    expect(screen.getByLabelText(/^items/)).toBeDefined();
    expect(screen.getByLabelText(/^batchCount/)).toBeDefined();
    expect(screen.queryByLabelText(/^exitWhen/)).toBeNull();
    expect(screen.queryByLabelText(/^maxRounds/)).toBeNull();
    expect(screen.queryByLabelText(/^timeout/)).toBeNull();
  });

  it('offers a stage only join', () => {
    mount({ id: 'st_1', kind: 'stage', children: ['n_a'] });
    expect(screen.getByLabelText(/^join/)).toBeDefined();
    for (const name of [/^exitWhen/, /^maxRounds/, /^timeout/, /^items/, /^batchCount/]) {
      expect(screen.queryByLabelText(name)).toBeNull();
    }
  });

  /** `id`/`kind`/`children` are structural — the panel must never offer them. */
  it('never offers a structural field', () => {
    mount(LOOP);
    for (const name of [/^id/, /^kind/, /^children/]) {
      expect(screen.queryByLabelText(name)).toBeNull();
    }
  });

  it('names the container by its within-kind ordinal', () => {
    mount({ ...LOOP, id: 'loop_2' }, [{ ...LOOP, id: 'loop_0' }]);
    expect(screen.getByRole('heading', { name: 'loop 2' })).toBeDefined();
  });
});

describe('ContainerPanel — applying', () => {
  it('hands back the edited value, preserving every field it does not own', () => {
    const carried = { ...LOOP, futureField: 'keep me' } as Container;
    const onApply = mount(carried);
    fireEvent.change(screen.getByLabelText(/^exitWhen/), {
      target: { value: '${equals(2, 2)}' },
    });
    apply();
    expect(applied(onApply)).toEqual({ ...carried, exitWhen: '${equals(2, 2)}' });
  });

  /**
   * Opening the panel and pressing Apply must hand back what was already
   * stored. A panel that MANUFACTURES a field on open — writing `0` for an
   * absent number, or `''` for an absent string — would author settings the
   * operator never chose, which is #473's shape one level down.
   */
  it('is a no-op when nothing was typed', () => {
    const onApply = mount(LOOP);
    apply();
    expect(applied(onApply)).toEqual(LOOP);
  });

  /**
   * A blank control is an ABSENT field, never a zero. `Number('')` is 0, and a
   * `maxRounds: 0` is a different, legal-looking pipeline.
   */
  it('clearing an optional field removes the key rather than writing a falsy value', () => {
    const onApply = mount({ ...LOOP, maxRounds: 7, join: 'any' });
    fireEvent.change(screen.getByLabelText(/^maxRounds/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/^join/), { target: { value: '' } });
    apply();
    const next = applied(onApply);
    expect(next).toEqual(LOOP);
    expect(Object.keys(next)).not.toContain('maxRounds');
    expect(Object.keys(next)).not.toContain('join');
  });

  it.each([
    ['a fractional round cap', /^maxRounds/, '1.5'],
    ['a zero round cap', /^maxRounds/, '0'],
    ['a negative timeout', /^timeout/, '-1'],
    ['text where a number goes', /^timeout/, 'soon'],
  ])('refuses %s, keeping the typed text and saying why', (_label, field, text) => {
    const onApply = mount(LOOP);
    fireEvent.change(screen.getByLabelText(field), { target: { value: text } });
    apply();
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBeTruthy();
    // The refusal must not revert the box — that would lose the edit silently.
    expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe(text);
  });
});

describe('ContainerPanel — a field that is dead on this kind', () => {
  /**
   * Since #859 closed the last kind-legality hole, NO illegal container field
   * can be minted through any supported path — the write gate refuses all of
   * them. The population this repair path serves is therefore versions minted
   * BEFORE the refusal existed, which are immutable and still openable (reads
   * never validate), plus any future field added to the map ahead of its rule.
   *
   * That population is real but unseedable through the API, so it is covered
   * HERE rather than end to end: this suite mounts the panel on the container
   * directly, which is a component test's licence and not a gate bypass. The
   * e2e that used to cover it seeded through the real write gate and could no
   * longer do so — see #939.
   */
  const STAGE_WITH_ROUNDS: Container = {
    id: 'st_1',
    kind: 'stage',
    children: ['n_a'],
    maxRounds: 3,
  };

  it('renders the carried field, and says it is not valid here', () => {
    mount(STAGE_WITH_ROUNDS);
    expect((screen.getByLabelText(/^maxRounds/) as HTMLInputElement).value).toBe('3');
    expect(screen.getByText(/not valid on a stage/)).toBeDefined();
  });

  /**
   * The advisory's blocked-save claim is DERIVED from the validator, never
   * inferred from the field map — and this is the test that proves the
   * derivation is load-bearing rather than decorative.
   *
   * It used to assert the opposite. `stage` + `maxRounds` was illegal and NOT
   * refused (#859), so on this exact screen Save was enabled and an advisory
   * promising otherwise would have been false every time it could be read.
   * Closing #859 flipped it, and the flip needed NO change to `ContainerPanel`:
   * the refusal appeared, `validateCanvas` began emitting it, and the sentence
   * corrected itself. Had `blocked` been inferred from `CONTAINER_CONFIG_FIELDS`
   * instead, the panel would have been right by luck here and would still carry
   * a second, drifting copy of the kind-legality rules.
   */
  it('claims a blocked save exactly when the validator blocks it', () => {
    mount(STAGE_WITH_ROUNDS);
    const advisory = screen.getByText(/not valid on a stage/).textContent ?? '';
    expect(advisory).toContain('Saving is blocked');
  });

  /**
   * The repair is CLEARING, and the control has to enforce that. Left merely
   * editable, typing a new value into a dead field was accepted, warned about
   * nothing (the consequence gate diffs a validator with no opinion here) and
   * minted the dead field into an immutable version.
   */
  it('refuses a new VALUE for a dead field, rather than only offering to clear it', () => {
    const onApply = mount(STAGE_WITH_ROUNDS);
    fireEvent.change(screen.getByLabelText(/^maxRounds/), { target: { value: '10' } });
    apply();
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('maxRounds');
  });

  /** Leaving the dead field untouched must not block an unrelated edit either. */
  it('still refuses an unrelated edit while the dead field holds a value', () => {
    const onApply = mount(STAGE_WITH_ROUNDS);
    fireEvent.change(screen.getByLabelText(/^join/), { target: { value: 'any' } });
    apply();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('clearing it removes the key', () => {
    const onApply = mount(STAGE_WITH_ROUNDS);
    fireEvent.change(screen.getByLabelText(/^maxRounds/), { target: { value: '' } });
    apply();
    expect(applied(onApply)).toEqual({ id: 'st_1', kind: 'stage', children: ['n_a'] });
  });

  it('says nothing when every carried field is legal here', () => {
    mount(LOOP);
    expect(screen.queryByText(/not valid on a/)).toBeNull();
  });
});

describe('ContainerPanel — a value no control can represent', () => {
  /**
   * `exitWhen: 42` cannot come from this panel, but a hand-written or
   * API-authored doc can carry it. The control would seed EMPTY, so an apply the
   * author believes changed one OTHER field would rewrite this one — corruption
   * caused by opening the panel. There is no whole-config JSON escape for a
   * container the way there is for a node, so the honest move is to refuse to
   * edit at all and say which field is the problem.
   */
  const CORRUPT = { ...LOOP, exitWhen: 42 } as unknown as Container;

  it('disables editing rather than offering a form that would overwrite it', () => {
    mount(CORRUPT);
    expect(screen.queryByRole('button', { name: 'Apply container settings' })).toBeNull();
    expect(screen.queryByLabelText(/^exitWhen/)).toBeNull();
  });

  it('names the field that cannot be shown', () => {
    mount(CORRUPT);
    expect(screen.getByRole('alert').textContent).toContain('exitWhen');
  });
});

/**
 * U17 — which change re-seeds this form, and which must not.
 *
 * The panel's docblock records BOTH halves as decisions: a re-seed keyed on the
 * container OBJECT was written and removed once already (#746 — a membership
 * rewrite mints a new container and would discard a half-typed field), and U17
 * then made "never re-seed" wrong too (an undo replaces the config of the same
 * container and remounts nothing, so the form would show the value just undone).
 * Keying on the CONFIG is what satisfies both, so both halves are pinned here.
 */
describe('ContainerPanel — following an undo without losing a draft (U17)', () => {
  function rerenderable(container: Container) {
    const onApply = vi.fn();
    const view = render(
      <ContainerPanel
        container={container}
        nodes={NODES}
        edges={[]}
        containers={[container]}
        params={[]}
        onApply={onApply}
        onCopy={() => {}}
        onDuplicate={() => {}}
      />,
    );
    return (next: Container) =>
      view.rerender(
        <ContainerPanel
          container={next}
          nodes={NODES}
          edges={[]}
          containers={[next]}
          params={[]}
          onApply={onApply}
          onCopy={() => {}}
          onDuplicate={() => {}}
        />,
      );
  }

  it('a CONFIG change re-seeds the form — the shape an undo arrives in', () => {
    const rerender = rerenderable(LOOP);
    expect(screen.getByLabelText(/^exitWhen/)).toHaveValue('${equals(1, 1)}');

    // What an undo hands back: the SAME container id, a different config.
    rerender({ ...LOOP, exitWhen: '${false}' });
    expect(screen.getByLabelText(/^exitWhen/)).toHaveValue('${false}');
  });

  it('a MEMBERSHIP rewrite does NOT clobber a half-typed field', () => {
    const rerender = rerenderable(LOOP);
    const field = screen.getByLabelText(/^exitWhen/);
    fireEvent.change(field, { target: { value: '${half-typed' } });
    expect(field).toHaveValue('${half-typed');

    // #746's case: a NEW container object carrying an EQUAL config. An
    // identity-keyed re-seed would discard the draft here — which is exactly
    // why this panel keys on `sameContainerConfig` instead.
    rerender({ ...LOOP, children: ['n_a', 'n_b'] });
    expect(screen.getByLabelText(/^exitWhen/)).toHaveValue('${half-typed');
  });
});

describe('ContainerPanel — the expression flyout on exitWhen and items (#864)', () => {
  /**
   * `n_src → [container: n_body] `. `n_src` is UPSTREAM of the container; the
   * body child declares the boolean an exit condition reads. So the two fields
   * must disagree about both nodes, which is the whole reason each is its own
   * site: `exitWhen` reads the body, `items` reads the upstream.
   */
  const SRC: Node = {
    id: 'n_src',
    type: 'agent_task',
    config: { outputs: [{ name: 'rows', type: 'json' }] },
    position: { x: 0, y: 0 },
  };
  const BODY: Node = {
    id: 'n_body',
    type: 'agent_task',
    config: {
      outputs: [
        { name: 'done', type: 'boolean' },
        { name: 'note', type: 'string' },
      ],
    },
    position: { x: 0, y: 100 },
  };
  const PARAMS: Param[] = [{ name: 'flag', type: 'boolean', required: true }];

  function mountSite(container: Container) {
    const onApply = vi.fn();
    render(
      <ContainerPanel
        container={container}
        nodes={[SRC, BODY]}
        edges={[{ id: 'e', from: 'n_src', to: container.id, on: 'success' }]}
        containers={[container]}
        params={PARAMS}
        onApply={onApply}
        onCopy={() => {}}
        onDuplicate={() => {}}
      />,
    );
    return onApply;
  }
  const open = (field: string) =>
    fireEvent.click(screen.getByRole('button', { name: `Insert reference into ${field}` }));
  const option = (name: RegExp) => screen.queryByRole('button', { name });

  it("offers a loop's exitWhen its own child's boolean, never the upstream node", () => {
    const onApply = mountSite({
      id: 'loop_1',
      kind: 'loop',
      children: ['n_body'],
      exitWhen: '${params.flag}',
    });
    open('exitWhen');
    expect(option(/→ done/)).not.toBeNull();
    // Filtered by the save gate's own boolean check, not by a rule restated here.
    expect(option(/→ note/)).toBeNull();
    expect(option(/→ rows/)).toBeNull();

    fireEvent.click(option(/→ done/)!);
    apply();
    // Whole-value field, so the pick REPLACES rather than splicing into `${params.flag}`.
    expect(applied(onApply).exitWhen).toBe('${nodes.n_body.output.done}');
  });

  it("offers a foreach's items its upstream output, never its own body", () => {
    const onApply = mountSite({
      id: 'fe_1',
      kind: 'foreach',
      children: ['n_body'],
      items: '${createArray(1)}',
    });
    open('items');
    expect(option(/→ rows/)).not.toBeNull();
    expect(option(/→ done/)).toBeNull();
    expect(option(/^item/)).toBeNull();

    fireEvent.click(option(/→ rows/)!);
    apply();
    expect(applied(onApply).items).toBe('${nodes.n_src.output.rows}');
  });

  it('gives a field that is dead on this kind no flyout — it may only be cleared', () => {
    mountSite({
      id: 'loop_1',
      kind: 'loop',
      children: ['n_body'],
      exitWhen: '${params.flag}',
      items: '${params.flag}',
    });
    expect(screen.getByRole('button', { name: 'Insert reference into exitWhen' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Insert reference into items' })).toBeNull();
  });
});

describe('ContainerPanel — Copy and Duplicate container (U21 #935)', () => {
  function panel() {
    const handlers = { onApply: vi.fn(), onCopy: vi.fn(), onDuplicate: vi.fn() };
    render(
      <ContainerPanel
        container={LOOP}
        nodes={NODES}
        edges={[]}
        containers={[LOOP]}
        params={[]}
        {...handlers}
      />,
    );
    return handlers;
  }

  it('hands the duplicate to the store and applies nothing', () => {
    const { onApply, onCopy, onDuplicate } = panel();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate container' }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('hands the copy to the store and applies nothing', () => {
    const { onApply, onCopy, onDuplicate } = panel();
    fireEvent.click(screen.getByRole('button', { name: 'Copy container' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onDuplicate).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
