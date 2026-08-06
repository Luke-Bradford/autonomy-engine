import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import { PipelinePanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';
import { clearClipboard } from './clipboard';

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
  render(<PipelinePanel pipelineId="pl_1" onNotice={() => {}} store={store} />);
  return store;
}

describe('PipelinePanel (U16) — params', () => {
  it('renders a row per declared param, seeded from the version', () => {
    mount(version({ params: [{ name: 'topic', type: 'string', required: true }] }));
    expect(screen.getByLabelText('param 1 name')).toHaveValue('topic');
    expect(screen.getByLabelText('param 1 type')).toHaveValue('string');
    expect(screen.getByLabelText('param 1 required')).toBeChecked();
  });

  it('says so plainly when nothing is declared', () => {
    mount(version());
    expect(screen.getAllByText('None declared.')).toHaveLength(2); // params and outputs
  });

  it('"Add param" puts a new row in the store', () => {
    const store = mount(version());
    fireEvent.click(screen.getByRole('button', { name: 'Add param' }));
    expect(store.getState().params).toHaveLength(1);
  });

  it('typing a name writes straight through to the store', () => {
    const store = mount(version({ params: [{ name: 'a', type: 'string', required: false }] }));
    fireEvent.change(screen.getByLabelText('param 1 name'), { target: { value: 'topic' } });
    expect(store.getState().params[0]!.name).toBe('topic');
  });

  it('changing the type keeps a now-mismatched default rather than destroying it', () => {
    // A mis-clicked type must not silently delete authored data; the advisory
    // below is what tells the operator it needs repairing.
    const store = mount(
      version({ params: [{ name: 'a', type: 'string', required: false, default: 'abc' }] }),
    );
    fireEvent.change(screen.getByLabelText('param 1 type'), { target: { value: 'number' } });
    expect(store.getState().params[0]!).toEqual({
      name: 'a',
      type: 'number',
      required: false,
      default: 'abc',
    });
  });

  it('SHOWS a required param’s stored default instead of claiming a run must supply it', () => {
    // W1. `resolveRunParams` reads `hasOwnProperty(p,'default')` before
    // `p.required`, so this param resolves from its default and is never asked
    // for a value. Hiding the field made an API-minted default invisible and
    // un-editable while the panel asserted the opposite of what the engine does.
    mount(
      version({ params: [{ name: 'x', type: 'number', required: true, default: 'not a number' }] }),
    );
    expect(screen.getByLabelText('param 1 default')).toHaveValue('not a number');
    expect(screen.queryByText('A run must supply this param.')).toBeNull();
    expect(screen.getByText(/stored default already satisfies it/)).toBeInTheDocument();
    // ...and the defect reaches it, which the old early-out suppressed.
    expect(screen.getByText("param 'x': expected a finite number")).toBeInTheDocument();
  });

  it('still says a run must supply a required param that has NO default', () => {
    mount(version({ params: [{ name: 'x', type: 'string', required: true }] }));
    expect(screen.getByText('A run must supply this param.')).toBeInTheDocument();
    expect(screen.queryByLabelText('param 1 default')).toBeNull();
  });

  it('a blur that changed nothing does not write — no spurious dirty, no data loss', () => {
    // N1. Tabbing THROUGH the field would otherwise mark an untouched doc dirty,
    // and would DELETE a stored default of '' (legal, and reachable by import)
    // because `coerceDefaultInput` reads blank as "no default".
    const store = mount(
      version({ params: [{ name: 'x', type: 'string', required: false, default: '' }] }),
    );
    fireEvent.blur(screen.getByLabelText('param 1 default'), { target: { value: '' } });

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

    const field = screen.getByLabelText('param 1 default');
    fireEvent.change(field, { target: { value: '9x' } });
    fireEvent.blur(field, { target: { value: '9x' } });
    expect(screen.getByRole('alert')).toBeInTheDocument(); // rejected, nothing stored

    fireEvent.click(screen.getByRole('button', { name: 'remove param 1' }));

    // Row 1 is now `b`, and it shows B's default — not `a`'s abandoned draft.
    expect(screen.getByLabelText('param 1 name')).toHaveValue('b');
    expect(screen.getByLabelText('param 1 default')).toHaveValue('1');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.getState().params[0]!.default).toBe(1);
  });

  it('clearing a param description removes the key rather than storing an empty string', () => {
    const store = mount(
      version({ params: [{ name: 'x', type: 'string', required: false, description: 'why' }] }),
    );
    fireEvent.change(screen.getByLabelText('param 1 description'), { target: { value: '' } });
    expect('description' in store.getState().params[0]!).toBe(false);
  });

  it('setting a param description stores it', () => {
    const store = mount(version({ params: [{ name: 'x', type: 'string', required: false }] }));
    fireEvent.change(screen.getByLabelText('param 1 description'), { target: { value: 'why' } });
    expect(store.getState().params[0]!.description).toBe('why');
  });

  it('ticking Required removes the default field AND the stored default', () => {
    const store = mount(
      version({ params: [{ name: 'a', type: 'string', required: false, default: 'x' }] }),
    );
    fireEvent.click(screen.getByLabelText('param 1 required'));

    expect('default' in store.getState().params[0]!).toBe(false);
    expect(screen.queryByLabelText('param 1 default')).toBeNull();
    expect(screen.getByText('A run must supply this param.')).toBeInTheDocument();
  });

  it('commits a default on blur, TYPED — not as the raw text', () => {
    const store = mount(version({ params: [{ name: 'n', type: 'number', required: false }] }));
    const field = screen.getByLabelText('param 1 default');
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
    fireEvent.blur(screen.getByLabelText('param 1 default'), { target: { value: '' } });
    expect('default' in store.getState().params[0]!).toBe(false);
  });

  it('refuses an unparseable default, keeping the text on screen and the store unchanged', () => {
    const store = mount(version({ params: [{ name: 'n', type: 'number', required: false }] }));
    const field = screen.getByLabelText('param 1 default');
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
    fireEvent.click(screen.getByRole('button', { name: 'remove param 1' }));
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
    expect(screen.getByLabelText('param 1 default')).toHaveValue('aaa');

    fireEvent.click(screen.getByRole('button', { name: 'remove param 1' }));
    expect(screen.getByLabelText('param 1 name')).toHaveValue('second');
    expect(screen.getByLabelText('param 1 default')).toHaveValue('bbb');
  });
});

describe('PipelinePanel (U16) — outputs', () => {
  it('renders a row per declared output', () => {
    mount(version({ outputs: [{ name: 'result', type: 'json' }] }));
    expect(screen.getByLabelText('output 1 name')).toHaveValue('result');
    expect(screen.getByLabelText('output 1 type')).toHaveValue('json');
  });

  it('never offers `secret` as an output type — a declared secret output leaks', () => {
    mount(version({ outputs: [{ name: 'result', type: 'string' }] }));
    const options = Array.from(
      screen.getByLabelText('output 1 type').querySelectorAll('option'),
    ).map((o) => o.value);
    expect(options).not.toContain('secret');
    expect(options).toContain('string');
  });

  it('unchecking Optional REMOVES the key, since absent is what the schema reads as required', () => {
    const store = mount(version({ outputs: [{ name: 'r', type: 'string', optional: true }] }));
    fireEvent.click(screen.getByLabelText('output 1 optional'));
    expect('optional' in store.getState().outputs[0]!).toBe(false);
  });

  it('checking Optional sets it', () => {
    const store = mount(version({ outputs: [{ name: 'r', type: 'string' }] }));
    fireEvent.click(screen.getByLabelText('output 1 optional'));
    expect(store.getState().outputs[0]!.optional).toBe(true);
  });

  it('"Add output" puts a new row in the store', () => {
    const store = mount(version());
    fireEvent.click(screen.getByRole('button', { name: 'Add output' }));
    expect(store.getState().outputs).toHaveLength(1);
  });

  it('clearing the description removes the key rather than storing an empty string', () => {
    const store = mount(
      version({ outputs: [{ name: 'r', type: 'string', description: 'the answer' }] }),
    );
    fireEvent.change(screen.getByLabelText('output 1 description'), { target: { value: '' } });
    expect('description' in store.getState().outputs[0]!).toBe(false);
  });
});

describe('PipelinePanel — Paste (U21)', () => {
  /**
   * Paste lives in the NOTHING-selected panel because that is where an operator
   * is standing when they want it, and it is the only place ⌘V is discoverable.
   */
  function panel() {
    const store = createCanvasStore();
    store.getState().loadVersion(version());
    render(<PipelinePanel pipelineId="pl_1" onNotice={() => {}} store={store} />);
    return store;
  }

  it('pastes what was copied, and says how much', () => {
    clearClipboard();
    const store = createCanvasStore();
    store.getState().loadVersion(version());
    store.getState().setSelection([{ kind: 'node', id: 'n_a' }]);
    store.getState().copySelection('pl_1');
    // Deselect, which is the state this panel is shown in at all.
    store.getState().setSelection([]);

    const notices: string[] = [];
    render(<PipelinePanel pipelineId="pl_1" onNotice={(m) => notices.push(m)} store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));

    expect(store.getState().nodes).toHaveLength(2);
    expect(store.getState().past).toHaveLength(1);
    expect(notices).toEqual(['Pasted 1 activity.']);
  });

  it('is ALWAYS enabled — the refusal is more use said than hidden', () => {
    clearClipboard();
    panel();
    // A greyed button cannot explain WHY it is grey, and "nothing copied yet"
    // and "copied from another pipeline" are different answers.
    expect(screen.getByRole('button', { name: 'Paste' })).toBeEnabled();
  });
});
