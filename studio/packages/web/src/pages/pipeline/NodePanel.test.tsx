import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getActivity, isStructuralCallActivity, type Node } from '@autonomy-studio/shared';
import { NodePanel } from './PipelineCanvas';
import { useStore } from 'zustand';
import { createCanvasStore } from './canvasStore';
import { deriveConfigFields } from './configForm';

// `CallPanel` lists pipelines on mount. This suite is about which PANEL NodePanel
// routes to, not about the call editor's own behaviour (`CallPanel.test.tsx` owns
// that), so the listing is stubbed empty rather than served.
vi.mock('../../api/pipelines', () => ({
  listAllPipelineVersions: () => Promise.resolve([]),
}));

/**
 * Mount the panel over a store holding ONE node, and hand back a reader for that
 * node's stored config — so every assertion below is about what an apply actually
 * WROTE to the doc, never about what the form displayed.
 *
 * The panel's props are read FROM THE STORE on every render, because that is how
 * `PipelineCanvas` feeds it (`useStore(store, s => s.nodes)`, then the selected
 * node's fields). A harness that passed a frozen `config` captured at mount would
 * be a strictly easier problem than the real one: the panel re-seeds its drafts
 * when a new `config` object arrives, and a prop that can never change would
 * quietly certify that re-seed without ever exercising it.
 */
function mountOver(
  target: Node,
  connections: Parameters<typeof NodePanel>[0]['connections'] = [],
  datasets: Parameters<typeof NodePanel>[0]['datasets'] = [],
) {
  const store = createCanvasStore();
  store.setState({ nodes: [target] });

  function Harness() {
    const node = useStore(store, (s) => s.nodes.find((n) => n.id === target.id));
    if (!node) return null;
    return (
      <NodePanel
        store={store}
        connections={connections}
        datasets={datasets}
        nodeId={node.id}
        nodeType={node.type}
        config={node.config}
        connectionId={node.connectionId}
        call={undefined}
      />
    );
  }

  render(<Harness />);
  return {
    store,
    storedConfig: () => store.getState().nodes[0]?.config ?? {},
    apply: () => fireEvent.click(screen.getByRole('button', { name: 'Apply config' })),
  };
}

/** A node at the origin — position is irrelevant to every assertion here. */
const node = (id: string, type: string, config: Record<string, unknown>): Node => ({
  id,
  type,
  config,
  position: { x: 0, y: 0 },
});

const httpNode = (config: Record<string, unknown>): Node => node('n_http', 'http_request', config);

// Named for what it tests, not for the sibling that used to share the file. U5
// replaced the flat `Palette` with `ActivityToolbox` (own file, own spec), and
// `src/palette.test.ts` — the CSS COLOUR-palette test — already owned the word
// "palette" in this package's test names.

// A structural-call node's settings live in `node.call`, so the inspector must
// not offer the generic `node.config` editor for it — that would validate
// `node.config` against `CallConfigSchema` (the `node.call` blob) and always
// fail. #425 replaced the read-only stub that used to stand here with the
// dedicated `CallPanel`.
describe('NodePanel (#4 A9 structural-call routing)', () => {
  it('renders the call editor, not the generic config editor, for an execute_pipeline node', () => {
    render(
      <NodePanel
        store={createCanvasStore()}
        connections={[]}
        datasets={[]}
        nodeId="n_ep"
        nodeType="execute_pipeline"
        config={{}}
        connectionId={undefined}
        call={undefined}
      />,
    );
    expect(isStructuralCallActivity('execute_pipeline')).toBe(true);
    expect(screen.getByRole('heading', { name: 'Call target' })).toBeTruthy();
    // The generic config-JSON editor + Apply are NOT offered.
    expect(screen.queryByLabelText(/Config \(JSON\)/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply config' })).toBeNull();
  });

  // #953 — `Node.call` is an OPTIONAL DISCRIMINANT valid on a node of any type,
  // so the literal `type: 'call_pipeline'` (used across the engine test suite and
  // reachable by import or an API seed) is a call node too. It is not catalogued,
  // so the generic form it used to get derived no fields and its call blob was
  // neither visible nor editable.
  it('renders the call editor for a legacy call_pipeline-typed node carrying a call blob', () => {
    render(
      <NodePanel
        store={createCanvasStore()}
        connections={[]}
        datasets={[]}
        nodeId="n_legacy"
        nodeType="call_pipeline"
        config={{}}
        connectionId={undefined}
        call={{ pipelineVersionId: 'pv_1', params: {} }}
      />,
    );
    expect(isStructuralCallActivity('call_pipeline')).toBe(false);
    expect(screen.getByRole('heading', { name: 'Call target' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply config' })).toBeNull();
  });

  // The exclusion half, and the reason `authorsCallBlob` is not simply
  // "`node.call` is set": `reduce.ts` evaluates the `kind:'control'` forks BEFORE
  // it tests `node.call`, so on an `if` the TYPE wins and the call blob is inert.
  // Offering a call editor there would be a UI that contradicts what the run does.
  it('does NOT route a control-typed node to the call editor, even with a call blob', () => {
    render(
      <NodePanel
        store={createCanvasStore()}
        connections={[]}
        datasets={[]}
        nodeId="n_if"
        nodeType="if"
        config={{ condition: '${params.go}' }}
        connectionId={undefined}
        call={{ pipelineVersionId: 'pv_1', params: {} }}
      />,
    );
    expect(screen.queryByRole('heading', { name: 'Call target' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply config' })).toBeTruthy();
  });

  it('still renders the generic config editor for a normal (non-call) activity', () => {
    render(
      <NodePanel
        store={createCanvasStore()}
        connections={[]}
        datasets={[]}
        nodeId="n_http"
        nodeType="http_request"
        config={{}}
        connectionId={undefined}
        call={undefined}
      />,
    );
    // A normal activity keeps the config editor + Apply button.
    expect(screen.getByRole('button', { name: 'Apply config' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Call target' })).toBeNull();
  });
});

/**
 * #878 — the panel heading names the NODE, not its kind.
 *
 * Both review lenses proved this consumer had no guard: reverting both `<h3>`s to
 * the old `entry?.title ?? nodeType` left the whole suite green. The failure it
 * would have hidden is the exact disagreement `activityLabel`'s docblock exists
 * to prevent — the box reads "HTTP Request 2" and its own panel reads "HTTP
 * Request", with nothing to say they are the same activity.
 */
describe('NodePanel heading (#878)', () => {
  const http = (id: string): Node => ({
    id,
    type: 'http_request',
    config: {},
    position: { x: 0, y: 0 },
  });

  /** Mount the panel over a store holding a WHOLE doc, and open it on one node. */
  function heading(nodes: Node[], nodeId: string): string {
    const store = createCanvasStore();
    store.setState({ nodes });
    const node = nodes.find((n) => n.id === nodeId)!;
    render(
      <NodePanel
        store={store}
        connections={[]}
        datasets={[]}
        nodeId={node.id}
        nodeType={node.type}
        config={node.config}
        connectionId={undefined}
        call={undefined}
      />,
    );
    return screen.getAllByRole('heading', { level: 3 })[0]!.textContent ?? '';
  }

  it('names the node its ordinal, not its kind', () => {
    expect(heading([http('n_1'), http('n_2')], 'n_2')).toBe('HTTP Request 2');
  });

  /* The call arm is a SECOND copy of the heading, behind an early `return` — a
     fix applied to the config arm alone would leave it saying the kind. */
  it('names a structural-call node the same way in its call-editor arm', () => {
    const call: Node = {
      id: 'n_ep',
      type: 'execute_pipeline',
      config: {},
      position: { x: 0, y: 0 },
    };
    expect(heading([http('n_1'), call], 'n_ep')).toBe('Execute Pipeline 1');
  });
});

describe('NodePanel (U7 per-activity config form)', () => {
  it('renders a labelled control per config key instead of one JSON blob', () => {
    mountOver(httpNode({}));

    // The whole point of the ticket: the activity's settings are NAMED on screen,
    // so authoring one no longer means knowing its JSON shape by heart.
    expect(screen.getByLabelText('url')).toBeTruthy();
    expect(screen.getByLabelText('method (optional)')).toBeTruthy();
    expect(screen.getByLabelText('body (optional)')).toBeTruthy();
    // A record has no typed control this ticket, so it authors as JSON — but as
    // its OWN named field, not buried in a blob.
    expect(screen.getByLabelText('headers (optional) — JSON')).toBeTruthy();
    // The blob editor is gone by default.
    expect(screen.queryByLabelText('Config (JSON)')).toBeNull();
  });

  it('writes an edited field into the doc', () => {
    const panel = mountOver(httpNode({ url: 'https://old' }));

    fireEvent.change(screen.getByLabelText('url'), { target: { value: 'https://new' } });
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({ url: 'https://new' });
  });

  it('PRESERVES the outputs contract and any key no field owns', () => {
    // The data-integrity core. `config.outputs` is the F13 contract that
    // `catalog/lower.ts` owns and no `configSchema` declares; `legacyExtra` stands
    // for anything an API-authored or git-imported doc carries that this build's
    // catalog does not know. Storing a `safeParse` output would drop BOTH, because
    // a plain `z.object` strips unknown keys.
    const panel = mountOver(
      httpNode({
        url: 'https://x',
        outputs: [{ name: 'status', type: 'number' }],
        legacyExtra: { keep: true },
      }),
    );

    fireEvent.change(screen.getByLabelText('url'), { target: { value: 'https://y' } });
    panel.apply();

    expect(panel.storedConfig()).toEqual({
      url: 'https://y',
      outputs: [{ name: 'status', type: 'number' }],
      legacyExtra: { keep: true },
    });
  });

  it('drops a key the author clears, rather than writing an empty value', () => {
    const panel = mountOver(httpNode({ url: 'https://x', method: 'POST' }));

    fireEvent.change(screen.getByLabelText('method (optional)'), { target: { value: '' } });
    panel.apply();

    expect(panel.storedConfig()).toEqual({ url: 'https://x' });
    expect('method' in panel.storedConfig()).toBe(false);
  });

  it('reports a field it cannot parse and writes nothing', () => {
    const panel = mountOver(httpNode({ url: 'https://x' }));

    fireEvent.change(screen.getByLabelText('headers (optional) — JSON'), {
      target: { value: '{not json}' },
    });
    panel.apply();

    expect(screen.getByRole('alert').textContent).toMatch(/headers: .*JSON/);
    expect(panel.storedConfig()).toEqual({ url: 'https://x' });
  });

  it('surfaces the activity schema its own refusal, without saving', () => {
    const panel = mountOver(httpNode({ url: 'https://x' }));

    // `url` is `z.string().min(1)`, so clearing it is a schema violation, not a
    // parse failure — a different path to the same "nothing was written".
    fireEvent.change(screen.getByLabelText('url'), { target: { value: '' } });
    panel.apply();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(panel.storedConfig()).toEqual({ url: 'https://x' });
  });

  it('falls back to the JSON editor when a saved value cannot be shown in its control', () => {
    // The kind comes from the SCHEMA, the value from the DOC, and they can
    // legitimately disagree. Rendering an object into `url`'s text box would apply
    // back as "[object Object]" — a corruption caused by OPENING the panel.
    const panel = mountOver(httpNode({ url: { was: 'authored elsewhere' } }));

    expect(screen.getByLabelText('Config (JSON)')).toBeTruthy();
    expect(screen.queryByLabelText('url')).toBeNull();
    expect(screen.getByText(/Saved settings this form cannot show \(url\)/)).toBeTruthy();
    // And the fallback is not a dead end: the JSON editor still applies.
    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://repaired"}' },
    });
    panel.apply();
    expect(panel.storedConfig()).toMatchObject({ url: 'https://repaired' });
  });

  it('offers the JSON editor as an opt-in escape hatch when the form works', () => {
    const panel = mountOver(httpNode({ url: 'https://x' }));

    expect(screen.queryByLabelText('Config (JSON)')).toBeNull();
    fireEvent.click(screen.getByLabelText('Edit as JSON'));
    expect(screen.getByLabelText('Config (JSON)')).toBeTruthy();
    expect(screen.queryByLabelText('url')).toBeNull();

    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://hatch"}' },
    });
    panel.apply();
    expect(panel.storedConfig()).toMatchObject({ url: 'https://hatch' });
  });

  it('does not let one editor revert the other', () => {
    // The two editors hold independent drafts of the same doc. Before the
    // re-seed, applying in JSON mode and then applying the FORM wrote the form's
    // mount-time values back over the JSON edit — the author's work silently
    // undone, with no message and nothing on screen having looked wrong.
    const panel = mountOver(httpNode({ url: 'https://x' }));

    fireEvent.click(screen.getByLabelText('Edit as JSON'));
    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://from-json","method":"POST"}' },
    });
    panel.apply();
    expect(panel.storedConfig()).toMatchObject({ url: 'https://from-json', method: 'POST' });

    // Back to the form: it must now show what JSON just wrote, and applying
    // unchanged must be a no-op rather than a revert.
    fireEvent.click(screen.getByLabelText('Edit as JSON'));
    expect((screen.getByLabelText('url') as HTMLTextAreaElement).value).toBe('https://from-json');
    expect((screen.getByLabelText('method (optional)') as HTMLTextAreaElement).value).toBe('POST');

    panel.apply();
    expect(panel.storedConfig()).toMatchObject({ url: 'https://from-json', method: 'POST' });
  });

  it('hands the form back once an unrenderable value is repaired', () => {
    // The advisory names a field the author can no longer see, so it has to stop
    // naming it the moment they fix it — and the form it was blocking has to
    // become available. Both were stuck when this was computed once at mount.
    const panel = mountOver(httpNode({ url: { was: 'authored elsewhere' } }));

    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://repaired"}' },
    });
    panel.apply();

    expect(screen.queryByText(/Saved settings this form cannot show/)).toBeNull();
    expect(screen.getByLabelText('Edit as JSON')).toBeTruthy();
    expect((screen.getByLabelText('url') as HTMLTextAreaElement).value).toBe('https://repaired');
  });

  it('does not silently drop a stored empty value on an unrelated edit', () => {
    // `file_write.content` is a bare `z.string()` — `''` is a config the SERVER
    // accepts (write an empty file). Opening the panel to change the PATH must not
    // delete it, and must not leave the author unable to apply at all.
    const panel = mountOver(node('n_fw', 'file_write', { path: '/tmp/a', content: '' }));

    fireEvent.change(screen.getByLabelText('path'), { target: { value: '/tmp/b' } });
    panel.apply();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(panel.storedConfig()).toEqual({ path: '/tmp/b', content: '' });
  });

  it('renders an enum as a select over exactly its permitted values', () => {
    mountOver(node('n_llm', 'llm_call', {}));

    // Derived from the SCHEMA, not spelled out here. Writing the five effort
    // levels into this file would duplicate a list the catalog owns, and would
    // then quietly certify the old set on the day one is added — the failure mode
    // where a test enumerates what a component renders and goes stale.
    const derived = deriveConfigFields(getActivity('llm_call')!.configSchema);
    const permitted = derived?.find((f) => f.name === 'reasoningEffort')?.enumOptions;
    expect(permitted?.length, 'reasoningEffort is still an enum').toBeGreaterThan(0);

    const select = screen.getByLabelText('reasoningEffort (optional)') as HTMLSelectElement;
    // The blank leads: an optional enum must offer "not set" as a reachable state.
    expect([...select.options].map((o) => o.value)).toEqual(['', ...permitted!]);
  });

  it('distinguishes an unchecked optional box from an explicit false', () => {
    // `catalog/lower.ts` reads `emitMessages` to decide whether the messages
    // transcript row exists, so an optional box that wrote `false` on every apply
    // would make every node explicit about a choice its author never made.
    const panel = mountOver(node('n_llm', 'llm_call', { prompt: 'hi' }));

    panel.apply();
    expect('emitMessages' in panel.storedConfig()).toBe(false);

    fireEvent.click(screen.getByLabelText('emitMessages (optional)'));
    panel.apply();
    expect(panel.storedConfig()).toMatchObject({ emitMessages: true });
  });

  it('enforces a CROSS-FIELD rule, which no single control could see', () => {
    // `llm_call` requires prompt XOR messages, written as an object-level
    // `.refine`. Validating the assembled object — not each field alone — is what
    // makes that reachable from a form.
    const panel = mountOver(node('n_llm', 'llm_call', { prompt: 'hi' }));

    fireEvent.change(screen.getByLabelText('prompt (optional)'), { target: { value: '' } });
    panel.apply();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(panel.storedConfig()).toEqual({ prompt: 'hi' });
  });

  it('forms a CONTROL activity too, whose schema is a loose pre-check only', () => {
    // Deriving from `configSchema` widened this surface from one activity to the
    // whole catalog, so a control activity is pinned here. `wait.seconds` is a
    // `z.string()` precisely so it can hold a `${}` expression: the form accepts
    // one, and `validateDoc` remains the actual judge at save.
    const panel = mountOver(node('n_wait', 'wait', { seconds: '5' }));

    fireEvent.change(screen.getByLabelText('seconds'), { target: { value: '${params.delay}' } });
    panel.apply();

    expect(panel.storedConfig()).toEqual({ seconds: '${params.delay}' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('authors a list field one value per line', () => {
    const panel = mountOver(node('n_sw', 'switch', { on: '${x}', cases: [] }));

    fireEvent.change(screen.getByLabelText('cases — one per line'), {
      target: { value: 'red\n\ngreen\n' },
    });
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({ cases: ['red', 'green'] });
  });
});

describe('NodePanel — duplicate (U21)', () => {
  it('duplicates the node as it is STORED, config and all', () => {
    const panel = mountOver(httpNode({ url: 'https://example.test/a' }));

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate node' }));

    const nodes = panel.store.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1]!.id).not.toBe('n_http');
    expect(nodes[1]!.config).toEqual({ url: 'https://example.test/a' });
  });

  it('copies what Apply last wrote, not what the form is holding unapplied', () => {
    const panel = mountOver(httpNode({ url: 'https://example.test/a' }));
    fireEvent.change(screen.getByLabelText('url'), {
      target: { value: 'https://example.test/edited' },
    });
    // No apply — the edit is still only in the form's draft state.
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate node' }));

    const nodes = panel.store.getState().nodes;
    expect(nodes[1]!.config).toEqual({ url: 'https://example.test/a' });
  });
});

/**
 * #996 M5 slice 4c (#1139) — the paired binding pickers for a `copy` node.
 *
 * These assert what the DOC ends up holding, not what the selects display,
 * because the property the slice exists for is a document one: a `copy` node is
 * bindable at all, and the doc it produces is `NodeSchema`-valid at every
 * intermediate step.
 */
describe('paired binding pickers (#1139)', () => {
  const conn = (id: string, name: string, kind: 'sqlite' | 'fs') =>
    ({
      id,
      name,
      kind,
      config: {},
      parameters: [],
      secretStatus: 'not_required',
      ownerId: null,
      resourceId: `r_${id}`,
      secretRef: null,
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as Parameters<typeof NodePanel>[0]['connections'][number];

  const dset = (id: string, name: string, connectionId: string, kind: 'table' | 'query') =>
    ({
      id,
      name,
      kind,
      connectionId,
      config: {},
      columns: [],
      parameters: [],
      ownerId: null,
      resourceId: `r_${id}`,
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as Parameters<typeof NodePanel>[0]['datasets'][number];

  const CONNS = [conn('c_src', 'Source store', 'sqlite'), conn('c_fs', 'Files', 'fs')];
  const SETS = [
    dset('d_a', 'people', 'c_src', 'table'),
    dset('d_q', 'recent', 'c_src', 'query'),
    dset('d_other', 'elsewhere', 'c_fs', 'table'),
  ];
  const copyNode = () => node('n_copy', 'copy', {});
  const pick = (label: string, value: string) =>
    fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });

  it('offers FOUR pickers for a copy node, and hides the singular one', () => {
    // The singular picker is hidden rather than shown alongside: `validateDoc`
    // refuses `connectionId` and `connectionIds` on one node.
    mountOver(copyNode(), CONNS, SETS);
    for (const label of [
      'Source connection',
      'Sink connection',
      'Source dataset',
      'Sink dataset',
    ]) {
      expect(screen.getByRole('combobox', { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole('combobox', { name: 'Connection' })).toBeNull();
  });

  it('leaves a SINGLE-connection activity picker exactly as it was', () => {
    mountOver(httpNode({}), CONNS, SETS);
    expect(screen.getByRole('combobox', { name: 'Connection' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Source connection' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Source dataset' })).toBeNull();
  });

  it('filters the connection pickers to the kinds the CATALOG accepts', () => {
    mountOver(copyNode(), CONNS, SETS);
    const options = [...screen.getByRole('combobox', { name: 'Sink connection' }).children].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['', 'c_src']); // the `fs` connection is not offered
  });

  it('narrows the dataset picker to the connection bound to the SAME end', () => {
    // Slice 4a refuses a node/dataset connection disagreement at dispatch
    // (`DATASET_CONNECTION_MISMATCH`), so offering `d_other` here would be
    // offering a binding that cannot run.
    const { store } = mountOver(copyNode(), CONNS, SETS);
    pick('Source connection', 'c_src');
    const options = [...screen.getByRole('combobox', { name: 'Source dataset' }).children].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['', 'd_a', 'd_q']);
    expect(store.getState().nodes[0]?.datasetIds).toBeUndefined();
  });

  it('offers only `table` for the SINK dataset — a query has nothing to write into', () => {
    mountOver(copyNode(), CONNS, SETS);
    pick('Sink connection', 'c_src');
    const options = [...screen.getByRole('combobox', { name: 'Sink dataset' }).children].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['', 'd_a']);
  });

  it('writes the pair to the doc only once BOTH ends are picked', () => {
    const { store } = mountOver(copyNode(), CONNS, SETS);
    pick('Source connection', 'c_src');
    expect(store.getState().nodes[0]?.connectionIds).toBeUndefined();
    pick('Sink connection', 'c_src');
    expect(store.getState().nodes[0]?.connectionIds).toEqual({
      source: 'c_src',
      sink: 'c_src',
    });
  });

  it('says a half-bound pair is not saved, and stops saying it once the pair lands', () => {
    mountOver(copyNode(), CONNS, SETS);
    pick('Source connection', 'c_src');
    expect(screen.getByRole('status').textContent).toContain('not saved');
    pick('Sink connection', 'c_src');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stops saying it when the ONLY picked end is un-picked back to none', () => {
    // The symptom of the phantom `{source: undefined, sink: undefined}` entry:
    // the advisory reads the pending half through a `??`, which an empty object
    // satisfies, so a node the author had returned to fully blank still claimed
    // a half-bound pair was going unsaved.
    mountOver(copyNode(), CONNS, SETS);
    pick('Source connection', 'c_src');
    expect(screen.getByRole('status').textContent).toContain('not saved');
    pick('Source connection', '');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the half-picked end SELECTED — it is store state, not panel state', () => {
    const { store } = mountOver(copyNode(), CONNS, SETS);
    pick('Source connection', 'c_src');
    expect(
      (screen.getByRole('combobox', { name: 'Source connection' }) as HTMLSelectElement).value,
    ).toBe('c_src');
    expect(store.getState().pendingBindings['n_copy']?.connections?.source).toBe('c_src');
  });

  it('still shows a bound resource the allowlist would now reject', () => {
    // A doc can hold a binding this build would not offer. Dropping it from the
    // list makes the select read "— none —" while the doc says otherwise.
    const bound: Node = { ...copyNode(), connectionIds: { source: 'c_fs', sink: 'c_src' } };
    mountOver(bound, CONNS, SETS);
    expect(
      (screen.getByRole('combobox', { name: 'Source connection' }) as HTMLSelectElement).value,
    ).toBe('c_fs');
  });

  it('offers to clear a stray singular connectionId that a paired node may not have', () => {
    // Reachable by import or an API seed. The paired branch hides the picker that
    // would clear it, and `validateDoc` refuses the two together — so without
    // this the doc is unsaveable with no affordance to repair it.
    const stray: Node = { ...copyNode(), connectionId: 'c_src' };
    const { store } = mountOver(stray, CONNS, SETS);
    fireEvent.click(screen.getByRole('button', { name: 'Clear it' }));
    expect(store.getState().nodes[0]?.connectionId).toBeUndefined();
  });
});

/**
 * #1169 — M8 slice 1. A `copy` node's column mapping is an array of objects,
 * which had no typed control and therefore rendered as a raw JSON textarea —
 * the blank box the data-movement spec's §13 exists to remove.
 */
describe('NodePanel (the objectList control, #1169)', () => {
  const copyNode = (config: Record<string, unknown>): Node => ({
    id: 'n_copy',
    type: 'copy',
    position: { x: 0, y: 0 },
    config,
  });

  const oneRow = [{ source: 'name', sink: 'full_name', type: 'string', onError: 'fail' }];

  it('names every cell of every row, instead of one JSON blob for the whole mapping', () => {
    mountOver(copyNode({ mapping: oneRow, mode: 'append' }));

    expect(screen.getByLabelText('mapping row 1 source (optional)')).toBeTruthy();
    expect(screen.getByLabelText('mapping row 1 sink')).toBeTruthy();
    expect(screen.getByLabelText('mapping row 1 type')).toBeTruthy();
    // The JSON textarea it replaces — for the FIELD, and for the whole config.
    expect(screen.queryByLabelText('mapping — JSON')).toBeNull();
    expect(screen.queryByLabelText('Config (JSON)')).toBeNull();
  });

  it('writes an edited cell into the row it belongs to, leaving its siblings alone', () => {
    const panel = mountOver(
      copyNode({
        mapping: [...oneRow, { source: 'age', sink: 'age', type: 'integer', onError: 'fail' }],
        mode: 'append',
      }),
    );

    fireEvent.change(screen.getByLabelText('mapping row 2 sink'), {
      target: { value: 'years' },
    });
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [
        { source: 'name', sink: 'full_name', type: 'string', onError: 'fail' },
        { source: 'age', sink: 'years', type: 'integer', onError: 'fail' },
      ],
    });
  });

  it('appends a row and stores it once its required columns are filled', () => {
    const panel = mountOver(copyNode({ mapping: oneRow, mode: 'append' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add mapping row' }));
    fireEvent.change(screen.getByLabelText('mapping row 2 source (optional)'), {
      target: { value: 'age' },
    });
    fireEvent.change(screen.getByLabelText('mapping row 2 sink'), { target: { value: 'years' } });
    fireEvent.change(screen.getByLabelText('mapping row 2 type'), {
      target: { value: 'integer' },
    });
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [oneRow[0], { source: 'age', sink: 'years', type: 'integer' }],
    });
  });

  it('removes the row the author asked for, not the one that shifts into its place', () => {
    const panel = mountOver(
      copyNode({
        mapping: [...oneRow, { source: 'age', sink: 'years', type: 'integer', onError: 'fail' }],
        mode: 'append',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'remove mapping row 1' }));
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [{ source: 'age', sink: 'years', type: 'integer', onError: 'fail' }],
    });
  });

  /**
   * The two tests above each exercise a DEGENERATE index — the edit writes row 2
   * of 2, the removal drops row 1 of 2 — so a control that had hardcoded either
   * index would pass both. Verified by mutation: `i === index` rewritten to
   * `i === 1`, and `i !== index` to `i !== 0`, left all of them green. Three
   * rows, acting on one that is neither first nor last, is what actually pins
   * the row a gesture lands on to the row the author aimed at.
   */
  const threeRows = [
    { source: 'name', sink: 'full_name', type: 'string', onError: 'fail' },
    { source: 'age', sink: 'years', type: 'integer', onError: 'fail' },
    { source: 'city', sink: 'town', type: 'string', onError: 'fail' },
  ];

  it('edits the row the cell belongs to when it is neither the first nor the second', () => {
    const panel = mountOver(copyNode({ mapping: threeRows, mode: 'append' }));

    fireEvent.change(screen.getByLabelText('mapping row 3 sink'), {
      target: { value: 'municipality' },
    });
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [threeRows[0], threeRows[1], { ...threeRows[2], sink: 'municipality' }],
    });
  });

  it('removes the MIDDLE row, leaving the ones on either side of it', () => {
    const panel = mountOver(copyNode({ mapping: threeRows, mode: 'append' }));

    fireEvent.click(screen.getByRole('button', { name: 'remove mapping row 2' }));
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({ mapping: [threeRows[0], threeRows[2]] });
  });

  it('refuses a mapping whose LAST row was removed, rather than saving a copy that moves nothing', () => {
    // #1172. `mapping` is required, so `parseFieldInput` writes `[]` rather than
    // omitting the key (deliberately — omitting it fails every apply with
    // "expected array, received undefined" on a panel the author may only have
    // opened to change something else). That made deleting the last row a
    // two-click route to a version that mints clean and fails hours later when
    // a schedule fires it. `mappingArray`'s `.min(1)` now refuses it here, where
    // the author is standing. `Remove` is NOT disabled on the last row: a
    // disabled button hides its reason, and the refusal names it.
    const panel = mountOver(copyNode({ mapping: oneRow, mode: 'append' }));

    fireEvent.click(screen.getByRole('button', { name: 'remove mapping row 1' }));
    panel.apply();

    expect(screen.getByText(/a copy maps no columns/)).toBeTruthy();
    expect(panel.storedConfig()).toMatchObject({ mapping: oneRow });
  });

  it("lets the activity's own cross-row rule refuse a mapping the cells each accept", () => {
    // Two rows writing one sink column is silent LAST-WINS into the operator's
    // store. No single cell can see it; `refineMapping` can, and the panel must
    // surface that rather than save.
    const panel = mountOver(copyNode({ mapping: oneRow, mode: 'append' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add mapping row' }));
    fireEvent.change(screen.getByLabelText('mapping row 2 source (optional)'), {
      target: { value: 'other' },
    });
    fireEvent.change(screen.getByLabelText('mapping row 2 sink'), {
      target: { value: 'full_name' },
    });
    fireEvent.change(screen.getByLabelText('mapping row 2 type'), { target: { value: 'string' } });
    panel.apply();

    expect(screen.getByText(/duplicate sink column/)).toBeTruthy();
    expect(panel.storedConfig()).toMatchObject({ mapping: oneRow });
  });

  it('keeps the derived form for an llm_call whose history is the expression its save gate demands', () => {
    // The regression the strictness gate exists to stop. `history` is typed
    // `z.array(...)` but `validateDoc` refuses any non-string value, so a row
    // control would find a STRING there, refuse to render it, and take the whole
    // node into the JSON editor — this ticket's own defect, on the catalog's
    // most-used activity.
    mountOver({
      id: 'n_llm',
      type: 'llm_call',
      position: { x: 0, y: 0 },
      config: { model: 'claude-opus-5', prompt: 'hi', history: '${nodes.a.outputs.turns}' },
    });

    expect(screen.getByLabelText('prompt (optional)')).toBeTruthy();
    expect(screen.queryByLabelText('Config (JSON)')).toBeNull();
  });
});

describe('NodePanel (Auto-map and the unmapped advisory, #1170)', () => {
  type Datasets = Parameters<typeof NodePanel>[0]['datasets'];
  type Column = Datasets[number]['columns'][number];

  const col = (name: string, type = 'string', nullable = true): Column =>
    ({ name, type, nullable }) as unknown as Column;

  const dset = (id: string, name: string, columns: Column[]): Datasets[number] =>
    ({
      id,
      name,
      kind: 'table',
      connectionId: 'c_src',
      config: {},
      columns,
      parameters: [],
      ownerId: null,
      resourceId: `r_${id}`,
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as Datasets[number];

  const copyNode = (config: Record<string, unknown>, bound = true): Node =>
    ({
      id: 'n_copy',
      type: 'copy',
      position: { x: 0, y: 0 },
      config,
      ...(bound ? { datasetIds: { source: 'd_src', sink: 'd_sink' } } : {}),
    }) as unknown as Node;

  const ROW = { source: 'name', sink: 'full_name', type: 'string', onError: 'fail' };

  const mount = (
    config: Record<string, unknown>,
    sets: Datasets = [
      dset('d_src', 'people', [col('id', 'integer'), col('name')]),
      dset('d_sink', 'staff', [col('id', 'integer'), col('name')]),
    ],
    bound = true,
  ) => mountOver(copyNode(config, bound), [], sets);

  const autoMap = () => fireEvent.click(screen.getByRole('button', { name: 'Auto-map columns' }));

  it('fills the mapping from the two bound datasets’ declared columns', () => {
    const panel = mount({ mapping: [ROW], mode: 'append' });

    autoMap();
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [
        ROW,
        { source: 'id', sink: 'id', type: 'integer', onError: 'fail' },
        { source: 'name', sink: 'name', type: 'string', onError: 'fail' },
      ],
    });
  });

  it('writes into the DRAFT, so nothing is stored until Apply', () => {
    // `ExpressionPicker`'s precedent: a computed value goes into the draft and
    // the author commits it, which is what puts it through `schemaIssues`.
    const panel = mount({ mapping: [ROW], mode: 'append' });

    autoMap();

    expect(panel.storedConfig()).toMatchObject({ mapping: [ROW] });
  });

  it('is ADDITIVE — it never overwrites a hand-authored expression row', () => {
    const expressionRow = { expression: '${params.batch}', sink: 'name', type: 'string', onError: 'fail' };
    const panel = mount({ mapping: [expressionRow], mode: 'append' });

    autoMap();
    panel.apply();

    const mapping = (panel.storedConfig() as { mapping: unknown[] }).mapping;
    expect(mapping[0]).toMatchObject(expressionRow);
    // `name` was claimed by the expression row, so only `id` is added.
    expect(mapping).toHaveLength(2);
    expect(mapping[1]).toMatchObject({ source: 'id', sink: 'id' });
  });

  it('is disabled until BOTH datasets are bound, and says so', () => {
    mount({ mapping: [ROW], mode: 'append' }, undefined, false);

    expect(screen.getByRole('button', { name: 'Auto-map columns' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByText(/Bind a source and a sink dataset/)).toBeTruthy();
  });

  it('names a NOT NULL sink column nothing writes apart from one merely not copied', () => {
    mount({ mapping: [ROW], mode: 'append' }, [
      dset('d_src', 'people', [col('name')]),
      dset('d_sink', 'staff', [col('id', 'integer', false), col('note')]),
    ]);

    expect(screen.getByText(/The sink requires a value for id/)).toBeTruthy();
    expect(screen.getByText(/Not copied: note\./)).toBeTruthy();
  });

  it('says a row names a sink column the bound dataset does not declare', () => {
    // The state the additive rule creates: auto-map, then re-bind the sink.
    mount({ mapping: [{ ...ROW, sink: 'gone' }], mode: 'append' }, [
      dset('d_src', 'people', [col('name')]),
      dset('d_sink', 'staff', [col('name')]),
    ]);

    expect(screen.getByText(/gone is not declared by the sink dataset/)).toBeTruthy();
  });

  it('names the source columns the mapping does not read', () => {
    mount({ mapping: [ROW], mode: 'append' }, [
      dset('d_src', 'people', [col('name'), col('age', 'integer')]),
      dset('d_sink', 'staff', [col('full_name')]),
    ]);

    expect(screen.getByText(/Not read from the source: age\./)).toBeTruthy();
  });

  it('reports a press that matched nothing instead of silently doing nothing', () => {
    mount({ mapping: [ROW], mode: 'append' }, [
      dset('d_src', 'people', [col('name')]),
      dset('d_sink', 'staff', [col('other')]),
    ]);

    autoMap();

    expect(screen.getByText(/No new columns matched\./)).toBeTruthy();
    expect(screen.getByText(/other had no source column of that name/)).toBeTruthy();
  });

  it('says which side declares no columns, rather than "nothing matched"', () => {
    // `columns: []` is a deliberately authorable state, so it gets its own line.
    mount({ mapping: [ROW], mode: 'append' }, [
      dset('d_src', 'people', []),
      dset('d_sink', 'staff', [col('name')]),
    ]);

    autoMap();

    expect(screen.getByText(/people declares no columns/)).toBeTruthy();
  });

  it('hides the aids in JSON mode, which edits a different draft', () => {
    mount({ mapping: [ROW], mode: 'append' });

    fireEvent.click(screen.getByLabelText('Edit as JSON'));

    expect(screen.queryByRole('button', { name: 'Auto-map columns' })).toBeNull();
  });
});
