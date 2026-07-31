import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import { PipelinePanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';

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

  it('ADVISES about a stored default the run will reject, without blocking anything', () => {
    // The server accepts this doc — gating Save on it would make an imported
    // pipeline holding such a default permanently unsaveable (#748's trap).
    mount(version({ params: [{ name: 'n', type: 'number', required: false, default: 'abc' }] }));
    expect(screen.getByText(/not a finite number/)).toBeInTheDocument();
  });

  it('does not advise about a numeric STRING, which the run coerces fine', () => {
    mount(version({ params: [{ name: 'n', type: 'number', required: false, default: '5' }] }));
    expect(screen.queryByText(/not a finite number/)).toBeNull();
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
