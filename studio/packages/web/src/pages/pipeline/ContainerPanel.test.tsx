import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { answerConfirm } from '../../testing/confirmDialog';
import {
  ContainerKindSchema,
  type Container,
  type Node,
  type Param,
} from '@autonomy-studio/shared';
import { ContainerPanel } from './ContainerPanel';
import { CONTAINER_PALETTE } from './activityGroups';

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
      variables={[]}
      globals={[]}
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

describe('ContainerPanel says what the container does (#1413)', () => {
  // Every KIND, not every palette entry: a kind the palette forgot would get no
  // line at all, and this is what catches it.
  it.each(ContainerKindSchema.options)(
    'a %s box repeats its palette description and names its kind',
    (kind) => {
      const description = CONTAINER_PALETTE.find((e) => e.kind === kind)?.description;
      expect(description).toBeDefined();
      mount({ ...LOOP, kind } as Container);
      const about = screen.getAllByRole('heading', { level: 2 })[0]!.nextElementSibling;
      expect(about?.classList.contains('property-panel__about')).toBe(true);
      expect(about?.textContent).toBe(`${description} ${kind}`);
      // One sentence, like an activity's (registry.test.ts holds those).
      expect(description).toMatch(/^[^.!?]+\.$/);
    },
  );
});

describe('ContainerPanel — which fields it offers', () => {
  it('offers a loop its own fields and none of the foreach-only ones', () => {
    mount(LOOP);
    for (const name of ['Exit when', /^Max rounds/, /^Timeout \(seconds\)/, 'Join']) {
      expect(screen.getByLabelText(name)).toBeDefined();
    }
    expect(screen.queryByLabelText('Items')).toBeNull();
    expect(screen.queryByLabelText(/^Batch count/)).toBeNull();
    expect(screen.queryByLabelText('Allow unordered variable writes')).toBeNull();
  });

  it('offers a foreach its own fields and none of the loop-only ones', () => {
    mount({ id: 'fe_1', kind: 'foreach', children: ['n_a'], items: '${createArray(1)}' });
    expect(screen.getByLabelText('Items')).toBeDefined();
    expect(screen.getByLabelText(/^Batch count/)).toBeDefined();
    // #844 V5 — the variable-guard opt-in is a foreach field.
    expect(screen.getByLabelText('Allow unordered variable writes')).toBeDefined();
    expect(screen.queryByLabelText('Exit when')).toBeNull();
    expect(screen.queryByLabelText(/^Max rounds/)).toBeNull();
    expect(screen.queryByLabelText(/^Timeout \(seconds\)/)).toBeNull();
  });

  it('offers a stage only join', () => {
    mount({ id: 'st_1', kind: 'stage', children: ['n_a'] });
    expect(screen.getByLabelText('Join')).toBeDefined();
    for (const name of [
      'Exit when',
      /^Max rounds/,
      /^Timeout \(seconds\)/,
      'Items',
      /^Batch count/,
      'Allow unordered variable writes',
    ]) {
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
    expect(screen.getByRole('heading', { name: 'Until 2' })).toBeDefined();
  });
});

/**
 * #1397 — an edit that leaves the pipeline unsavable is asked about in the
 * shared dialog, titled with the question; Apply waits for the answer.
 */
describe('ContainerPanel — the confirmation (#1397)', () => {
  const BROKEN = '${equals(nodes.n_nope.output.v, 1)}';

  it('asks before applying an edit the validator would refuse, and a Cancel applies nothing', async () => {
    const user = userEvent.setup();
    const onApply = mount(LOOP);
    fireEvent.change(screen.getByLabelText('Exit when'), { target: { value: BROKEN } });
    apply();
    expect(onApply).not.toHaveBeenCalled();
    const text = await answerConfirm(user, 'cancel');
    expect(text.startsWith('Apply these changes to Until 1?')).toBe(true);
    expect(text).toContain('unsavable');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies the edit once the operator says Apply changes', async () => {
    const user = userEvent.setup();
    const onApply = mount(LOOP);
    fireEvent.change(screen.getByLabelText('Exit when'), { target: { value: BROKEN } });
    apply();
    await answerConfirm(user, 'accept');
    expect(applied(onApply).exitWhen).toBe(BROKEN);
  });
});

describe('ContainerPanel — applying', () => {
  it('hands back the edited value, preserving every field it does not own', () => {
    const carried = { ...LOOP, futureField: 'keep me' } as Container;
    const onApply = mount(carried);
    fireEvent.change(screen.getByLabelText('Exit when'), {
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
  it('an edit to a foreach does not write the untouched opt-in (#844 V5)', () => {
    const fe: Container = {
      id: 'fe_1',
      kind: 'foreach',
      children: ['n_a'],
      items: '${createArray(1)}',
    };
    const onApply = mount(fe);
    fireEvent.change(screen.getByLabelText(/^Batch count/), { target: { value: '2' } });
    apply();
    expect(applied(onApply)).toEqual({ ...fe, batchCount: 2 });
  });

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
    fireEvent.change(screen.getByLabelText(/^Max rounds/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Join'), { target: { value: '' } });
    apply();
    const next = applied(onApply);
    expect(next).toEqual(LOOP);
    expect(Object.keys(next)).not.toContain('maxRounds');
    expect(Object.keys(next)).not.toContain('join');
  });

  it.each([
    ['a fractional round cap', /^Max rounds/, '1.5'],
    ['a zero round cap', /^Max rounds/, '0'],
    ['a negative timeout', /^Timeout \(seconds\)/, '-1'],
    ['text where a number goes', /^Timeout \(seconds\)/, 'soon'],
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
    expect((screen.getByLabelText(/^Max rounds/) as HTMLInputElement).value).toBe('3');
    expect(screen.getByText(/not valid on Stage 1/)).toBeDefined();
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
    const advisory = screen.getByText(/not valid on Stage 1/).textContent ?? '';
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
    fireEvent.change(screen.getByLabelText(/^Max rounds/), { target: { value: '10' } });
    apply();
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('maxRounds');
  });

  /** Leaving the dead field untouched must not block an unrelated edit either. */
  it('still refuses an unrelated edit while the dead field holds a value', () => {
    const onApply = mount(STAGE_WITH_ROUNDS);
    fireEvent.change(screen.getByLabelText('Join'), { target: { value: 'any' } });
    apply();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('clearing it removes the key', () => {
    const onApply = mount(STAGE_WITH_ROUNDS);
    fireEvent.change(screen.getByLabelText(/^Max rounds/), { target: { value: '' } });
    apply();
    expect(applied(onApply)).toEqual({ id: 'st_1', kind: 'stage', children: ['n_a'] });
  });

  it('says nothing when every carried field is legal here', () => {
    mount(LOOP);
    expect(screen.queryByText(/not valid on /)).toBeNull();
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
    expect(screen.queryByLabelText('Exit when')).toBeNull();
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
        variables={[]}
        globals={[]}
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
          variables={[]}
          globals={[]}
          onApply={onApply}
          onCopy={() => {}}
          onDuplicate={() => {}}
        />,
      );
  }

  it('a CONFIG change re-seeds the form — the shape an undo arrives in', () => {
    const rerender = rerenderable(LOOP);
    expect(screen.getByLabelText('Exit when')).toHaveValue('${equals(1, 1)}');

    // What an undo hands back: the SAME container id, a different config.
    rerender({ ...LOOP, exitWhen: '${false}' });
    expect(screen.getByLabelText('Exit when')).toHaveValue('${false}');
  });

  it('a MEMBERSHIP rewrite does NOT clobber a half-typed field', () => {
    const rerender = rerenderable(LOOP);
    const field = screen.getByLabelText('Exit when');
    fireEvent.change(field, { target: { value: '${half-typed' } });
    expect(field).toHaveValue('${half-typed');

    // #746's case: a NEW container object carrying an EQUAL config. An
    // identity-keyed re-seed would discard the draft here — which is exactly
    // why this panel keys on `sameContainerConfig` instead.
    rerender({ ...LOOP, children: ['n_a', 'n_b'] });
    expect(screen.getByLabelText('Exit when')).toHaveValue('${half-typed');
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
        variables={[]}
        globals={[]}
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
        variables={[]}
        globals={[]}
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

// #1420 OR26 — batchCount is a number whose MEANING is a mode, so the panel says
// which mode the value in the box means, as it is typed.
describe('ContainerPanel — a foreach says whether it runs in parallel', () => {
  const FOREACH: Container = {
    id: 'fe_1',
    kind: 'foreach',
    children: ['n_a'],
    items: '${createArray(1)}',
  };

  it('reads as sequential with no batchCount, and as parallel once one is typed', () => {
    mount(FOREACH);
    expect(screen.getByText(/^Sequential: items run one at a time, in order\./)).toBeDefined();
    fireEvent.change(screen.getByLabelText(/^Batch count/), { target: { value: '4' } });
    expect(screen.getByText(/^Parallel: up to 4 items run at once\./)).toBeDefined();
    expect(screen.queryByText(/^Sequential:/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Batch count/), { target: { value: '1' } });
    expect(screen.getByText(/^Sequential:/)).toBeDefined();
  });

  it('claims neither mode for a value that is not a batch count', () => {
    mount({ ...FOREACH, batchCount: 3 });
    expect(screen.getByText(/^Parallel: up to 3 items/)).toBeDefined();
    // A fraction the schema refuses, and number literals `Number()` reads but
    // Apply's own parser refuses — each would otherwise claim a mode.
    for (const value of ['2.5', '0x3', '+3', '99']) {
      fireEvent.change(screen.getByLabelText(/^Batch count/), { target: { value } });
      expect(screen.queryByText(/^(Sequential|Parallel):/), value).toBeNull();
    }
  });

  it('is a foreach line only', () => {
    mount(LOOP);
    expect(screen.queryByText(/^(Sequential|Parallel):/)).toBeNull();
  });
});

describe('ContainerPanel — properties on tabs (#1477 OR29)', () => {
  const FOREACH: Container = {
    id: 'fe_1',
    kind: 'foreach',
    children: ['n_a'],
    items: '${createArray(1)}',
  };
  // By key: Fluent draws a tab's label twice (once hidden, to reserve its width).
  const tabKeys = () => screen.getAllByRole('tab').map((t) => t.id.split('-tab-')[1]);

  it('splits a ForEach into Items · Concurrency · Settings', () => {
    mount(FOREACH);
    expect(tabKeys()).toEqual(['items', 'concurrency', 'settings']);
  });

  it('splits an Until into Condition · Settings', () => {
    mount(LOOP);
    expect(tabKeys()).toEqual(['condition', 'settings']);
  });

  it('shows Batch count only once Concurrency is chosen, and Items no longer', async () => {
    const user = userEvent.setup();
    mount(FOREACH);
    expect(screen.queryByRole('textbox', { name: /^Batch count/ })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Concurrency' }));
    expect(screen.getByRole('textbox', { name: /^Batch count/ })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'Items' })).toBeNull();
  });

  it('keeps a draft across a tab switch, marks its tab, and Apply commits it', async () => {
    const user = userEvent.setup();
    const onApply = mount(FOREACH);
    await user.click(screen.getByRole('tab', { name: 'Concurrency' }));
    await user.type(screen.getByRole('textbox', { name: /^Batch count/ }), '4');
    await user.click(screen.getByRole('tab', { name: 'Items' }));
    expect(screen.getByRole('tab', { name: 'Concurrency' })).toHaveAccessibleDescription(
      'Unapplied changes',
    );
    expect(screen.getByRole('tab', { name: 'Items' })).not.toHaveAccessibleDescription(
      'Unapplied changes',
    );
    apply();
    expect(applied(onApply).batchCount).toBe(4);
  });

  it('names the tab a refused field is on, when it is not the open one', async () => {
    const user = userEvent.setup();
    mount(FOREACH);
    await user.click(screen.getByRole('tab', { name: 'Concurrency' }));
    await user.type(screen.getByRole('textbox', { name: /^Batch count/ }), 'abc');
    await user.click(screen.getByRole('tab', { name: 'Items' }));
    apply();
    expect(screen.getByRole('alert').textContent).toMatch(/^On Concurrency: batchCount: /);
    // Out of the schema's bounds rather than unparseable: the same lead.
    await user.click(screen.getByRole('tab', { name: 'Concurrency' }));
    await user.clear(screen.getByRole('textbox', { name: /^Batch count/ }));
    await user.type(screen.getByRole('textbox', { name: /^Batch count/ }), '99');
    apply();
    expect(screen.getByRole('alert').textContent).toMatch(/^batchCount: /);
    await user.click(screen.getByRole('tab', { name: 'Items' }));
    apply();
    expect(screen.getByRole('alert').textContent).toMatch(/^On Concurrency: batchCount: /);
  });

  it('leaves no unapplied mark after an Apply that normalises the value it stores', async () => {
    const user = userEvent.setup();
    const onApply = mount({ ...FOREACH, batchCount: 4 });
    await user.click(screen.getByRole('tab', { name: 'Concurrency' }));
    const batch = screen.getByRole('textbox', { name: /^Batch count/ });
    await user.clear(batch);
    await user.type(batch, '04');
    expect(screen.getByRole('tab', { name: 'Concurrency' })).toHaveAccessibleDescription(
      'Unapplied changes',
    );
    apply();
    expect(applied(onApply).batchCount).toBe(4);
    expect(screen.getByRole('tab', { name: 'Concurrency' })).not.toHaveAccessibleDescription(
      'Unapplied changes',
    );
  });

  it('no longer says membership is edited on the activity (#1597 moved it to the canvas)', () => {
    mount(FOREACH);
    expect(screen.getByText(/^1 activity inside\.$/)).toBeDefined();
    expect(screen.queryByText(/edited on the activity itself/)).toBeNull();
  });

  it('shows a field that is dead on this kind whichever tab is open', async () => {
    const user = userEvent.setup();
    mount({ ...FOREACH, maxRounds: 3 });
    for (const name of ['Items', 'Concurrency', 'Settings']) {
      await user.click(screen.getByRole('tab', { name }));
      expect(screen.getByRole('textbox', { name: /^Max rounds/ })).toBeDefined();
    }
  });
});
