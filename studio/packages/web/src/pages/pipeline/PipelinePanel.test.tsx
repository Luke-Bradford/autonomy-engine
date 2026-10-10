import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import { PipelinePanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';
import { FORM_SECTION_HINTS } from '../../lib/form/sectionHints';
import { labelProblem } from '../../testing/sentenceCase';

function version(overrides: Partial<PipelineVersion> = {}): PipelineVersion {
  return PipelineVersionSchema.parse({
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
    ...overrides,
  });
}

function mount(v: PipelineVersion) {
  const store = createCanvasStore();
  store.getState().loadVersion(v);
  render(<PipelinePanel store={store} />);
  return store;
}

describe('PipelinePanel (U16) — params', () => {
  it('renders a row per declared param, seeded from the version', () => {
    mount(version({ params: [{ name: 'topic', type: 'string', required: true }] }));
    expect(screen.getByLabelText('Parameter 1 name')).toHaveValue('topic');
    expect(screen.getByLabelText('Parameter 1 type')).toHaveValue('string');
    expect(screen.getByLabelText('Parameter 1 required')).toBeChecked();
  });

  it('says so plainly when nothing is declared', () => {
    mount(version());
    // params, variables, outputs and (#1 F8a) annotations
    expect(screen.getAllByText('None declared.')).toHaveLength(4);
  });

  it('"Add parameter" puts a new row in the store', () => {
    const store = mount(version());
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(store.getState().params).toHaveLength(1);
  });

  it('typing a name writes straight through to the store', () => {
    const store = mount(version({ params: [{ name: 'a', type: 'string', required: false }] }));
    fireEvent.change(screen.getByLabelText('Parameter 1 name'), { target: { value: 'topic' } });
    expect(store.getState().params[0]!.name).toBe('topic');
  });

  it('changing the type keeps a now-mismatched default rather than destroying it', () => {
    // A mis-clicked type must not silently delete authored data; the advisory
    // below is what tells the operator it needs repairing.
    const store = mount(
      version({ params: [{ name: 'a', type: 'string', required: false, default: 'abc' }] }),
    );
    fireEvent.change(screen.getByLabelText('Parameter 1 type'), { target: { value: 'number' } });
    expect(store.getState().params[0]!).toEqual({
      name: 'a',
      type: 'number',
      required: false,
      default: 'abc',
    });
  });

  it('a string default carried into a json param shows QUOTED, and a blur leaves it alone', () => {
    // #844 — unquoted, `{"a":1}` read as the object a run never receives.
    const store = mount(
      version({ params: [{ name: 'a', type: 'string', required: false, default: '{"a":1}' }] }),
    );
    fireEvent.change(screen.getByLabelText('Parameter 1 type'), { target: { value: 'json' } });
    const field = screen.getByLabelText('Parameter 1 default');
    expect(field).toHaveValue('"{\\"a\\":1}"');
    // Identity, not equality: the no-op guard compares the field against the
    // SAME formatting, so an untouched blur must not write at all.
    const before = store.getState().params[0];
    fireEvent.blur(field);
    expect(store.getState().params[0]).toBe(before);
    expect(before!.default).toBe('{"a":1}');
  });

  it('notes a non-identifier name and a ${} default on the row, without blocking anything', () => {
    mount(
      version({
        params: [{ name: 'a.b', type: 'string', required: false, default: 'id-${run.runId}' }],
      }),
    );
    expect(screen.getByText(/'a\.b' is not a plain identifier/)).toBeInTheDocument();
    expect(screen.getByText(/used exactly as written/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('holds the DEFAULT note back while the field shows a parse error, but not the name note', () => {
    mount(version({ params: [{ name: 'a b', type: 'json', required: false, default: '${x}' }] }));
    expect(screen.getByText(/used exactly as written/)).toBeInTheDocument();
    const field = screen.getByLabelText('Parameter 1 default');
    fireEvent.change(field, { target: { value: '{' } });
    fireEvent.blur(field);
    expect(screen.getByRole('alert')).toHaveTextContent('not valid JSON (line 1');
    expect(screen.queryByText(/used exactly as written/)).toBeNull();
    expect(screen.getByText(/'a b' is not a plain identifier/)).toBeInTheDocument();
  });

  it('SHOWS a required param’s stored default instead of claiming a run must supply it', () => {
    // W1. `resolveRunParams` reads `hasOwnProperty(p,'default')` before
    // `p.required`, so this param resolves from its default and is never asked
    // for a value. Hiding the field made an API-minted default invisible and
    // un-editable while the panel asserted the opposite of what the engine does.
    mount(
      version({ params: [{ name: 'x', type: 'number', required: true, default: 'not a number' }] }),
    );
    expect(screen.getByLabelText('Parameter 1 default')).toHaveValue('not a number');
    expect(screen.queryByText('A run must supply this parameter.')).toBeNull();
    expect(screen.getByText(/stored default already satisfies it/)).toBeInTheDocument();
    // ...and the defect reaches it, which the old early-out suppressed.
    expect(screen.getByText("param 'x': expected a finite number")).toBeInTheDocument();
  });

  it('still says a run must supply a required param that has NO default', () => {
    mount(version({ params: [{ name: 'x', type: 'string', required: true }] }));
    expect(screen.getByText('A run must supply this parameter.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Parameter 1 default')).toBeNull();
  });

  it('a blur that changed nothing does not write — no spurious dirty, no data loss', () => {
    // N1. Tabbing THROUGH the field would otherwise mark an untouched doc dirty,
    // and would DELETE a stored default of '' (legal, and reachable by import)
    // because `coerceDefaultInput` reads blank as "no default".
    const store = mount(
      version({ params: [{ name: 'x', type: 'string', required: false, default: '' }] }),
    );
    fireEvent.blur(screen.getByLabelText('Parameter 1 default'), { target: { value: '' } });

    expect(store.getState().dirty).toBe(false);
    expect('default' in store.getState().params[0]!).toBe(true);
    expect(store.getState().params[0]!.default).toBe('');
  });

  it('a FAILED commit does not follow a removal onto a different param', () => {
    // W2. Rows are index-keyed. With two params whose defaults FORMAT alike, a
    // compare of the formatted string saw no change when a removal shifted the
    // second param into row 1 — so the first param's rejected draft stayed on
    // screen and the next successful blur wrote it onto a param the operator
    // never edited. Identity of the param object is what actually changed.
    const store = mount(
      version({
        params: [
          { name: 'a', type: 'number', required: false, default: 1 },
          { name: 'b', type: 'number', required: false, default: 1 },
        ],
      }),
    );

    const field = screen.getByLabelText('Parameter 1 default');
    fireEvent.change(field, { target: { value: '9x' } });
    fireEvent.blur(field, { target: { value: '9x' } });
    expect(screen.getByRole('alert')).toBeInTheDocument(); // rejected, nothing stored

    fireEvent.click(screen.getByRole('button', { name: 'Remove parameter 1' }));

    // Row 1 is now `b`, and it shows B's default — not `a`'s abandoned draft.
    expect(screen.getByLabelText('Parameter 1 name')).toHaveValue('b');
    expect(screen.getByLabelText('Parameter 1 default')).toHaveValue('1');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.getState().params[0]!.default).toBe(1);
  });

  it('clearing a param description removes the key rather than storing an empty string', () => {
    const store = mount(
      version({ params: [{ name: 'x', type: 'string', required: false, description: 'why' }] }),
    );
    fireEvent.change(screen.getByLabelText('Parameter 1 description'), { target: { value: '' } });
    expect('description' in store.getState().params[0]!).toBe(false);
  });

  it('setting a param description stores it', () => {
    const store = mount(version({ params: [{ name: 'x', type: 'string', required: false }] }));
    fireEvent.change(screen.getByLabelText('Parameter 1 description'), { target: { value: 'why' } });
    expect(store.getState().params[0]!.description).toBe('why');
  });

  it('ticking Required removes the default field AND the stored default', () => {
    const store = mount(
      version({ params: [{ name: 'a', type: 'string', required: false, default: 'x' }] }),
    );
    fireEvent.click(screen.getByLabelText('Parameter 1 required'));

    expect('default' in store.getState().params[0]!).toBe(false);
    expect(screen.queryByLabelText('Parameter 1 default')).toBeNull();
    expect(screen.getByText('A run must supply this parameter.')).toBeInTheDocument();
  });

  describe('#844 4c — the empty-string default', () => {
    // Blank means "no default", so without this control an optional string
    // param could not be given `''` — the value that makes `${params.x}`
    // resolve to nothing rather than be absent from the run's context.
    const box = () => screen.queryByLabelText('Parameter 1 empty-string default');

    it('ticking it stores `default: ""` — the KEY, not its absence', () => {
      const store = mount(version({ params: [{ name: 's', type: 'string', required: false }] }));
      expect(box()).not.toBeChecked();
      fireEvent.click(box()!);

      const p = store.getState().params[0]!;
      expect('default' in p).toBe(true);
      expect(p.default).toBe('');
      expect(box()).toBeChecked();
    });

    it('a stored `""` shows ticked, and unticking removes the key', () => {
      const store = mount(
        version({ params: [{ name: 's', type: 'string', required: false, default: '' }] }),
      );
      expect(box()).toBeChecked();
      fireEvent.click(box()!);

      expect('default' in store.getState().params[0]!).toBe(false);
      expect(box()).not.toBeChecked();
    });

    it('is offered only while the field is blank, and only for a string', () => {
      mount(
        version({
          params: [
            { name: 's', type: 'string', required: false, default: 'x' },
            { name: 'n', type: 'number', required: false },
          ],
        }),
      );
      expect(box()).toBeNull();
      expect(screen.queryByLabelText('Parameter 2 empty-string default')).toBeNull();

      fireEvent.change(screen.getByLabelText('Parameter 1 default'), { target: { value: '' } });
      expect(box()).not.toBeChecked();
    });

    it('ticking it while the cleared field is uncommitted lands on `""`', () => {
      // The pointer blurs the field before the click: that blur commits the
      // blank (removing 'x'), then the tick stores `''`. The final state is the
      // one the operator asked for, not whichever write happened to win.
      const store = mount(
        version({ params: [{ name: 's', type: 'string', required: false, default: 'x' }] }),
      );
      const field = screen.getByLabelText('Parameter 1 default');
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.blur(field, { target: { value: '' } });
      fireEvent.click(box()!);

      expect(store.getState().params[0]!.default).toBe('');
      expect(field).toHaveValue('');
    });

    it('unticking it on a REQUIRED param makes the param truly required', () => {
      const store = mount(
        version({ params: [{ name: 's', type: 'string', required: true, default: '' }] }),
      );
      fireEvent.click(box()!);

      expect('default' in store.getState().params[0]!).toBe(false);
      expect(screen.getByText('A run must supply this parameter.')).toBeInTheDocument();
    });
  });

  it('commits a default on blur, TYPED — not as the raw text', () => {
    const store = mount(version({ params: [{ name: 'n', type: 'number', required: false }] }));
    const field = screen.getByLabelText('Parameter 1 default');
    fireEvent.change(field, { target: { value: '42' } });
    // Still uncommitted while typing: half-typed JSON is not JSON.
    expect('default' in store.getState().params[0]!).toBe(false);

    fireEvent.blur(field, { target: { value: '42' } });
    expect(store.getState().params[0]!.default).toBe(42);
  });

  it('blanking the default REMOVES the key rather than storing undefined', () => {
    const store = mount(
      version({ params: [{ name: 'n', type: 'number', required: false, default: 7 }] }),
    );
    fireEvent.blur(screen.getByLabelText('Parameter 1 default'), { target: { value: '' } });
    expect('default' in store.getState().params[0]!).toBe(false);
  });

  it('refuses an unparseable default, keeping the text on screen and the store unchanged', () => {
    const store = mount(version({ params: [{ name: 'n', type: 'number', required: false }] }));
    const field = screen.getByLabelText('Parameter 1 default');
    fireEvent.change(field, { target: { value: 'abc' } });
    fireEvent.blur(field, { target: { value: 'abc' } });

    expect('default' in store.getState().params[0]!).toBe(false);
    expect(field).toHaveValue('abc'); // the operator's text is not reverted
    expect(screen.getByRole('alert')).toHaveTextContent('expected a number');
  });

  it("names a stored default the run would reject, in the SERVER's words (#843)", () => {
    // The row shows the same sentence the doc-level badge does, because both
    // come from `paramDefaultDefect` — so an operator reading "Save is off
    // because of this" can find the field it is about.
    mount(version({ params: [{ name: 'n', type: 'number', required: false, default: 'abc' }] }));
    expect(screen.getByText("param 'n': expected a finite number")).toBeInTheDocument();
  });

  it('says nothing about a numeric STRING, which the run coerces fine', () => {
    mount(version({ params: [{ name: 'n', type: 'number', required: false, default: '5' }] }));
    expect(screen.queryByText(/expected a finite number/)).toBeNull();
  });

  it('Remove drops the row', () => {
    const store = mount(
      version({
        params: [
          { name: 'a', type: 'string', required: false },
          { name: 'b', type: 'string', required: false },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove parameter 1' }));
    expect(store.getState().params.map((p) => p.name)).toEqual(['b']);
  });

  /**
   * The rows are keyed by index, so removing one SHIFTS a different param into
   * a row that already holds draft text for the old one. Without the
   * render-phase resync in `ParamRow`, row 1 would keep showing `first`'s
   * default after `first` is gone.
   */
  it('re-syncs a row whose param changed underneath it after a removal', () => {
    mount(
      version({
        params: [
          { name: 'first', type: 'string', required: false, default: 'aaa' },
          { name: 'second', type: 'string', required: false, default: 'bbb' },
        ],
      }),
    );
    expect(screen.getByLabelText('Parameter 1 default')).toHaveValue('aaa');

    fireEvent.click(screen.getByRole('button', { name: 'Remove parameter 1' }));
    expect(screen.getByLabelText('Parameter 1 name')).toHaveValue('second');
    expect(screen.getByLabelText('Parameter 1 default')).toHaveValue('bbb');
  });
});

describe('PipelinePanel (U16) — outputs', () => {
  it('renders a row per declared output', () => {
    mount(version({ outputs: [{ name: 'result', type: 'json' }] }));
    expect(screen.getByLabelText('Output 1 name')).toHaveValue('result');
    expect(screen.getByLabelText('Output 1 type')).toHaveValue('json');
  });

  it('never offers `secret` as an output type — a declared secret output leaks', () => {
    mount(version({ outputs: [{ name: 'result', type: 'string' }] }));
    const options = Array.from(
      screen.getByLabelText('Output 1 type').querySelectorAll('option'),
    ).map((o) => o.value);
    expect(options).not.toContain('secret');
    expect(options).toContain('string');
  });

  it('names each type, and stores the value (#1396)', () => {
    mount(version({ outputs: [{ name: 'result', type: 'json' }] }));
    const select = screen.getByLabelText('Output 1 type') as HTMLSelectElement;
    const named = Array.from(select.options).map((o) => [o.value, o.textContent]);
    expect(named).toContainEqual(['json', 'JSON']);
    expect(named).toContainEqual(['boolean', 'Boolean']);
    expect(select).toHaveValue('json');
  });

  it('unchecking Optional REMOVES the key, since absent is what the schema reads as required', () => {
    const store = mount(version({ outputs: [{ name: 'r', type: 'string', optional: true }] }));
    fireEvent.click(screen.getByLabelText('Output 1 optional'));
    expect('optional' in store.getState().outputs[0]!).toBe(false);
  });

  it('checking Optional sets it', () => {
    const store = mount(version({ outputs: [{ name: 'r', type: 'string' }] }));
    fireEvent.click(screen.getByLabelText('Output 1 optional'));
    expect(store.getState().outputs[0]!.optional).toBe(true);
  });

  it('"Add output" puts a new row in the store', () => {
    const store = mount(version());
    // #844 — outputs are the dock's second tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add output' }));
    expect(store.getState().outputs).toHaveLength(1);
  });

  it('clearing the description removes the key rather than storing an empty string', () => {
    const store = mount(
      version({ outputs: [{ name: 'r', type: 'string', description: 'the answer' }] }),
    );
    fireEvent.change(screen.getByLabelText('Output 1 description'), { target: { value: '' } });
    expect('description' in store.getState().outputs[0]!).toBe(false);
  });
});

describe('PipelinePanel (#844 V3) — variables', () => {
  /** Mount with the Variables tab open: role queries skip a hidden tab panel. */
  function mountVariables(v: PipelineVersion) {
    const store = mount(v);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    return store;
  }

  it('is its own tab, between Parameters and Outputs', () => {
    mount(version());
    // By accessible name: Fluent's Tab renders its label twice in the DOM.
    const tabs = screen.getAllByRole('tab');
    expect(
      ['Parameters', 'Variables', 'Outputs'].map((name) =>
        tabs.indexOf(screen.getByRole('tab', { name })),
      ),
    ).toEqual([0, 1, 2]);
  });

  it('renders a row per declared variable, its default shown as text', () => {
    mountVariables(version({ variables: [{ name: 'rows', type: 'array', default: [1, 2] }] }));
    expect(screen.getByLabelText('Variable 1 name')).toHaveValue('rows');
    expect(screen.getByLabelText('Variable 1 type')).toHaveValue('array');
    expect(screen.getByLabelText('Variable 1 default')).toHaveValue('[1,2]');
  });

  it('"Add variable" puts a row in the store that states its starting value', () => {
    const store = mountVariables(version());
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    expect(store.getState().variables).toEqual([{ name: 'var_1', type: 'string', default: '' }]);
  });

  it('offers exactly the variable types — no json, no secret', () => {
    mountVariables(version({ variables: [{ name: 'v', type: 'string', default: '' }] }));
    const options = [...(screen.getByLabelText('Variable 1 type') as HTMLSelectElement).options];
    expect(options.map((o) => o.value)).toEqual(['string', 'number', 'boolean', 'array']);
  });

  it('commits a TYPED default on blur', () => {
    const store = mountVariables(
      version({ variables: [{ name: 'n', type: 'number', default: 0 }] }),
    );
    const field = screen.getByLabelText('Variable 1 default');
    fireEvent.change(field, { target: { value: '12' } });
    fireEvent.blur(field);
    expect(store.getState().variables[0]!.default).toBe(12);
  });

  it('refuses a blank number default, keeping the stored value', () => {
    const store = mountVariables(
      version({ variables: [{ name: 'n', type: 'number', default: 3 }] }),
    );
    const field = screen.getByLabelText('Variable 1 default');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(screen.getByRole('alert')).toHaveTextContent('a number variable needs a starting value');
    expect(store.getState().variables[0]!.default).toBe(3);
  });

  it('a blank STRING default is the empty string, not an error', () => {
    const store = mountVariables(
      version({ variables: [{ name: 's', type: 'string', default: 'x' }] }),
    );
    const field = screen.getByLabelText('Variable 1 default');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(store.getState().variables[0]!.default).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a type change converts the default it can, so the doc never holds a mismatch', () => {
    const store = mountVariables(
      version({ variables: [{ name: 'n', type: 'number', default: 5 }] }),
    );
    fireEvent.change(screen.getByLabelText('Variable 1 type'), { target: { value: 'string' } });
    expect(store.getState().variables[0]).toEqual({ name: 'n', type: 'string', default: '5' });
  });

  it('an untouched blur REPAIRS an imported default the gate refuses', () => {
    // `"5"` under `number` shows as `5`. Skipping the no-op blur, as a param
    // row does, would leave the field and the badge disagreeing for good.
    const store = mountVariables(
      version({ variables: [{ name: 'n', type: 'number', default: '5' }] }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      "variable 'n' default must be a number, got string",
    );
    fireEvent.blur(screen.getByLabelText('Variable 1 default'));
    expect(store.getState().variables[0]!.default).toBe(5);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an untouched blur of a LEGAL default writes nothing', () => {
    const store = mountVariables(
      version({ variables: [{ name: 'n', type: 'number', default: 5 }] }),
    );
    fireEvent.blur(screen.getByLabelText('Variable 1 default'));
    expect(store.getState().dirty).toBe(false);
  });

  it('names an unaddressable name on the row, in the save gate’s words', () => {
    mountVariables(version({ variables: [{ name: 'a-b', type: 'string', default: '' }] }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      "variable 'a-b' cannot be referenced as ${vars.<name>}",
    );
  });

  it('Remove drops the row', () => {
    const store = mountVariables(
      version({
        variables: [
          { name: 'a', type: 'string', default: '' },
          { name: 'b', type: 'string', default: '' },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove variable 1' }));
    expect(store.getState().variables.map((v) => v.name)).toEqual(['b']);
  });
});

describe('PipelinePanel — no prose, no Paste bar (#1477 OR29)', () => {
  it('opens on its tabs, with no instructions paragraph and no Paste button', () => {
    mount(version());
    expect(screen.queryByText(/Select a node or an edge/)).toBeNull();
    // Paste moved to the dock header (`DockPasteButton`), where a folded or
    // filled dock still offers it.
    expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull();
    expect(screen.getByRole('tablist', { name: 'Pipeline properties' })).toBeVisible();
  });
});

describe('PipelinePanel (#1 F8a) — General', () => {
  function mountGeneral(v: PipelineVersion) {
    const store = mount(v);
    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    return store;
  }

  it('is the LAST tab, so the dock still opens on Parameters', () => {
    mount(version());
    const tabs = screen.getAllByRole('tab');
    expect(
      ['Parameters', 'Variables', 'Outputs', 'General'].map((name) =>
        tabs.indexOf(screen.getByRole('tab', { name })),
      ),
    ).toEqual([0, 1, 2, 3]);
  });

  it('shows the version’s description and one row per annotation', () => {
    mountGeneral(version({ description: 'Nightly load', annotations: ['prod', 'finance'] }));
    expect(screen.getByLabelText('Pipeline description')).toHaveValue('Nightly load');
    expect(screen.getByLabelText('Annotation 1')).toHaveValue('prod');
    expect(screen.getByLabelText('Annotation 2')).toHaveValue('finance');
  });

  // #1413 — the General and Annotations sections each say what they hold, as
  // the section's accessible description, like every Section.
  it('names each section and describes it with its hint', () => {
    mountGeneral(version());
    expect(screen.getByRole('group', { name: 'General' })).toHaveAccessibleDescription(
      FORM_SECTION_HINTS.pipeline.general,
    );
    expect(screen.getByRole('group', { name: 'Annotations' })).toHaveAccessibleDescription(
      FORM_SECTION_HINTS.pipeline.annotations,
    );
  });

  it('writes edits straight to the store — no draft that an undo could leave stale', () => {
    const store = mountGeneral(version({ annotations: ['prod'] }));
    fireEvent.change(screen.getByLabelText('Pipeline description'), {
      target: { value: 'Nightly' },
    });
    fireEvent.change(screen.getByLabelText('Annotation 1'), { target: { value: 'staging' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
    expect(store.getState().description).toBe('Nightly');
    expect(store.getState().annotations).toEqual(['staging', '']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove annotation 1' }));
    expect(store.getState().annotations).toEqual(['']);
    act(() => store.getState().undo());
    expect(screen.getByLabelText('Annotation 1')).toHaveValue('staging');
  });
});

describe('PipelinePanel — declarations are a compact table (#1477 OR29)', () => {
  const headers = (table: HTMLElement) =>
    Array.from(table.querySelectorAll('th'), (th) => th.textContent ?? '');

  it('params read as a table: headers once, a row per param, no per-row visible labels', () => {
    mount(
      version({
        params: [
          { name: 'a', type: 'string', required: false },
          { name: 'b', type: 'number', required: false },
        ],
      }),
    );
    const table = screen.getByRole('table', { name: 'Parameters' });
    expect(headers(table)).toEqual([
      'Name',
      'Type',
      'Required',
      'Default',
      'Description',
      'Actions',
    ]);
    expect(table.querySelectorAll('tbody > tr')).toHaveLength(2);
    // The headers say what each cell is; the cells carry no label text of their own.
    expect(table.querySelector('tbody label:not(.contract-check)')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Parameter 2 name' })).toHaveValue('b');
    // The Default column's hint is in the section's `?` now.
    expect(screen.getByRole('group', { name: 'Parameters' })).toHaveAccessibleDescription(
      /Leave a default blank for no default\./,
    );
  });

  it("a row's notes sit on a row of their own, spanning the table, and only when there are any", () => {
    mount(
      version({
        params: [
          { name: 'ok', type: 'string', required: false },
          { name: 'a b', type: 'string', required: false },
        ],
      }),
    );
    const table = screen.getByRole('table', { name: 'Parameters' });
    const notes = table.querySelectorAll('tr.row-table__notes');
    expect(notes).toHaveLength(1);
    const cell = notes[0]!.querySelector('td')!;
    expect(cell.colSpan).toBe(6);
    expect(cell).toHaveTextContent(/'a b' is not a plain identifier/);
    // It follows the row it is about.
    expect(notes[0]!.previousElementSibling).toContainElement(
      screen.getByRole('textbox', { name: 'Parameter 2 name' }),
    );
  });

  it('variables and outputs carry their own columns', () => {
    mount(
      version({
        variables: [{ name: 'n', type: 'number', default: 0 }],
        outputs: [{ name: 'o', type: 'string' }],
      }),
    );
    expect(headers(screen.getByRole('table', { name: 'Variables', hidden: true }))).toEqual([
      'Name',
      'Type',
      'Default',
      'Description',
      'Actions',
    ]);
    expect(headers(screen.getByRole('table', { name: 'Outputs', hidden: true }))).toEqual([
      'Name',
      'Type',
      'Optional',
      'Description',
      'Actions',
    ]);
  });
});

/**
 * #1594 OR40 S4b — every control on every tab of the pipeline's properties is
 * named in words: "Parameter 1 name", "Remove annotation 1", never the key
 * (`param 1 name`) and never with a trailing colon or period.
 */
describe('PipelinePanel (#1594 OR40 S4b) — control names', () => {
  /** Each control's name, as its `aria-label`, its `<label>` or its own text gives it. */
  function controlNames(): string[] {
    const names: string[] = [];
    document.querySelectorAll('[role="tabpanel"] [aria-label]').forEach((el) => {
      names.push(el.getAttribute('aria-label') ?? '');
    });
    document.querySelectorAll('[role="tabpanel"] :is(input, select, textarea)').forEach((el) => {
      (el as HTMLInputElement).labels?.forEach((l) => names.push(l.textContent?.trim() ?? ''));
    });
    document.querySelectorAll('[role="tabpanel"] button').forEach((el) => {
      if (!el.hasAttribute('aria-label')) names.push(el.textContent?.trim() ?? '');
    });
    return names.filter((n) => n !== '');
  }

  it.each(['Parameters', 'Variables', 'Outputs', 'General'])('%s', (tab) => {
    mount(
      version({
        params: [
          { name: 'topic', type: 'string', required: false },
          { name: 'note', type: 'string', required: false, default: '' },
        ],
        variables: [{ name: 'rows', type: 'number', default: 0 }],
        outputs: [{ name: 'answer', type: 'string' }],
        description: 'Nightly load',
        annotations: ['prod'],
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    const names = controlNames();
    expect(names.length).toBeGreaterThan(2);
    expect(names.map((n) => [n, labelProblem(n)]).filter(([, p]) => p !== null)).toEqual([]);
  });
});
