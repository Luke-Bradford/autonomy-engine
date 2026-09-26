import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import {
  getActivity,
  isStructuralCallActivity,
  type Node,
  type Param,
} from '@autonomy-studio/shared';
import { NodePanel } from './PipelineCanvas';
import { useStore } from 'zustand';
import { createCanvasStore } from './canvasStore';
import { deriveConfigFields } from './configForm';
import { subjectKey } from './containerRules';
import { SubjectIssuesContext } from './issueContext';

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
  params: Param[] = [],
) {
  const store = createCanvasStore();
  store.setState({ nodes: [target], params });

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
/** `agent_task` keeps a top-level `json` field (`outputSchema`) now that `headers` is rows. */
const agentNode = (config: Record<string, unknown>): Node => node('n_agent', 'agent_task', config);
/** The shared editor's mode toggle (#1088) — one button whose caption names the mode it goes TO. */
const toJson = () => screen.getByRole('button', { name: 'Edit as JSON' });
const toFields = () => screen.getByRole('button', { name: 'Edit as fields' });

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
    // #1312 — the early return keeps the run policy section: retry applies to a
    // call, and a secure flag refused on one must be explained where it is set.
    expect(screen.getByRole('group', { name: 'Run policy' })).toBeTruthy();
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
    // A record of headers authors as ROWS (#852), under its own name.
    expect(screen.getByRole('group', { name: 'headers (optional)' })).toBeTruthy();
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
    const panel = mountOver(agentNode({ task: 'x' }));

    fireEvent.change(screen.getByLabelText('outputSchema (optional) — JSON'), {
      target: { value: '{not json}' },
    });
    panel.apply();

    expect(screen.getByRole('alert').textContent).toMatch(/outputSchema: .*JSON/);
    expect(panel.storedConfig()).toEqual({ task: 'x' });
  });

  it('authors headers as rows, and a secret header as a secret NAME (#852)', () => {
    const panel = mountOver(httpNode({ url: 'https://x', headers: { 'X-Keep': '1' } }));

    // The stored record renders as a row, so an apply that touches it keeps it.
    expect((screen.getByLabelText('headers row 1 key') as HTMLTextAreaElement).value).toBe(
      'X-Keep',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add headers row' }));
    fireEvent.change(screen.getByLabelText('headers row 2 key'), { target: { value: 'X-New' } });
    fireEvent.change(screen.getByLabelText('headers row 2 value'), { target: { value: 'v' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add secretHeaders row' }));
    fireEvent.change(screen.getByLabelText('secretHeaders row 1 key'), {
      target: { value: 'Authorization' },
    });
    fireEvent.change(screen.getByLabelText('secretHeaders row 1 secret name'), {
      target: { value: 'api-token' },
    });
    panel.apply();

    expect(panel.storedConfig()).toEqual({
      url: 'https://x',
      headers: { 'X-Keep': '1', 'X-New': 'v' },
      secretHeaders: { Authorization: { $secret: 'api-token' } },
    });
  });

  it('refuses a duplicate header name rather than letting one row overwrite the other', () => {
    const panel = mountOver(httpNode({ url: 'https://x', headers: { 'X-A': '1' } }));

    fireEvent.click(screen.getByRole('button', { name: 'Add headers row' }));
    fireEvent.change(screen.getByLabelText('headers row 2 key'), { target: { value: 'X-A' } });
    fireEvent.change(screen.getByLabelText('headers row 2 value'), { target: { value: '2' } });
    panel.apply();

    expect(screen.getByRole('alert').textContent).toMatch(/headers: row 2: duplicate key 'X-A'/);
    expect(panel.storedConfig()).toEqual({ url: 'https://x', headers: { 'X-A': '1' } });
  });

  it('sends a malformed secret marker to the JSON editor instead of repairing it', () => {
    mountOver(httpNode({ url: 'https://x', secretHeaders: { A: { $secret: 'x', extra: 1 } } }));

    expect(screen.getByLabelText('Config (JSON)')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'secretHeaders (optional)' })).toBeNull();
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
    fireEvent.click(toJson());
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

    fireEvent.click(toJson());
    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://from-json","method":"POST"}' },
    });
    panel.apply();
    expect(panel.storedConfig()).toMatchObject({ url: 'https://from-json', method: 'POST' });

    // Back to the form: it must now show what JSON just wrote, and applying
    // unchanged must be a no-op rather than a revert.
    fireEvent.click(toFields());
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
    expect(toJson()).toBeTruthy();
    expect((screen.getByLabelText('url') as HTMLTextAreaElement).value).toBe('https://repaired');
  });

  it('lets a forced JSON editor hand back the form once the draft is repaired, and not before', () => {
    // The shared toggle is offered even while an unrenderable value forces JSON,
    // because it is the way back WITHOUT an Apply: it parses the draft and
    // refuses — naming the field — while the value still has no control.
    mountOver(httpNode({ url: { was: 'authored elsewhere' } }));

    fireEvent.click(toFields());
    expect(screen.getByRole('alert').textContent).toMatch(/no form control: url/);
    expect(screen.getByLabelText('Config (JSON)')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://repaired"}' },
    });
    fireEvent.click(toFields());
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('url') as HTMLTextAreaElement).value).toBe('https://repaired');
  });

  // #1088 — the mode toggle is the shared one (`useConfigEditor`), so it COMMITS
  // the draft it leaves. Before, it only flipped a flag: a field edit was absent
  // from the JSON it opened, and Apply there then stored the config WITHOUT it —
  // a silent drop of work the author could see a moment earlier.
  it('carries an unapplied field edit into the JSON it opens', () => {
    const panel = mountOver(httpNode({ url: 'https://x' }));

    fireEvent.change(screen.getByLabelText('url'), { target: { value: 'https://typed' } });
    fireEvent.click(toJson());
    expect(
      JSON.parse((screen.getByLabelText('Config (JSON)') as HTMLTextAreaElement).value),
    ).toEqual({ url: 'https://typed' });

    panel.apply();
    expect(panel.storedConfig()).toEqual({ url: 'https://typed' });
  });

  it('carries an unapplied JSON edit back into the form', () => {
    const panel = mountOver(httpNode({ url: 'https://x' }));

    fireEvent.click(toJson());
    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://from-json","method":"PUT"}' },
    });
    fireEvent.click(toFields());

    expect((screen.getByLabelText('url') as HTMLTextAreaElement).value).toBe('https://from-json');
    expect((screen.getByLabelText('method (optional)') as HTMLTextAreaElement).value).toBe('PUT');
    panel.apply();
    expect(panel.storedConfig()).toEqual({ url: 'https://from-json', method: 'PUT' });
  });

  it('keeps an unparseable JSON draft on screen rather than hiding it behind the form', () => {
    mountOver(httpNode({ url: 'https://x' }));

    fireEvent.click(toJson());
    fireEvent.change(screen.getByLabelText('Config (JSON)'), { target: { value: '{"url":' } });
    fireEvent.click(toFields());

    expect(screen.getByRole('alert').textContent).toMatch(/Invalid config JSON/);
    expect((screen.getByLabelText('Config (JSON)') as HTMLTextAreaElement).value).toBe('{"url":');
  });

  it('refuses to open JSON over a field that will not read back, and names it', () => {
    // The textarea opens on what Apply would write, so a control that cannot be
    // read has no such value — opening anyway would show a config silently
    // missing the author's edit.
    mountOver(agentNode({ task: 'x' }));

    fireEvent.change(screen.getByLabelText('outputSchema (optional) — JSON'), {
      target: { value: '{not json}' },
    });
    fireEvent.click(toJson());

    expect(screen.getByRole('alert').textContent).toMatch(/outputSchema: .*JSON/);
    expect(screen.queryByLabelText('Config (JSON)')).toBeNull();
  });

  it('does not let the JSON editor invent an outputs contract the node never had', () => {
    const panel = mountOver(httpNode({ url: 'https://x' }));

    fireEvent.click(toJson());
    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://y","outputs":[{"name":"s","type":"string"}]}' },
    });
    panel.apply();

    expect(panel.storedConfig()).toEqual({ url: 'https://y' });
  });

  it('never lets the JSON editor touch the outputs contract, which U16 owns', () => {
    // Neither editor holds `outputs`, so Apply puts the stored one back — and a
    // copy typed into the JSON is neither stored nor shown to a `.strict()`
    // schema as an unknown key.
    const outputs = [{ name: 'status', type: 'number' }];
    const panel = mountOver(httpNode({ url: 'https://x', outputs }));

    fireEvent.click(toJson());
    expect((screen.getByLabelText('Config (JSON)') as HTMLTextAreaElement).value).not.toMatch(
      /outputs/,
    );
    fireEvent.change(screen.getByLabelText('Config (JSON)'), {
      target: { value: '{"url":"https://y","outputs":[]}' },
    });
    panel.apply();

    expect(panel.storedConfig()).toEqual({ url: 'https://y', outputs });
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

  // #1347. The middle row again, for the same reason as above: a move that
  // hardcoded either neighbour would pass on a two-row list.
  it('moves the MIDDLE row up, swapping it with the row above and no other', () => {
    const panel = mountOver(copyNode({ mapping: threeRows, mode: 'append' }));

    fireEvent.click(screen.getByRole('button', { name: 'move mapping row 2 up' }));
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [threeRows[1], threeRows[0], threeRows[2]],
    });
  });

  it('moves the MIDDLE row down, swapping it with the row below and no other', () => {
    const panel = mountOver(copyNode({ mapping: threeRows, mode: 'append' }));

    fireEvent.click(screen.getByRole('button', { name: 'move mapping row 2 down' }));
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [threeRows[0], threeRows[2], threeRows[1]],
    });
  });

  it('keeps focus on the row it moved, so a second press moves it again', () => {
    // The buttons are index-keyed, so without this the focused `move row 2 up`
    // would be the row that just shifted DOWN, and a second press would undo
    // the first. At the top the `up` is disabled, so focus takes `down`.
    const panel = mountOver(copyNode({ mapping: threeRows, mode: 'append' }));

    fireEvent.click(screen.getByRole('button', { name: 'move mapping row 3 up' }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'move mapping row 2 up' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'move mapping row 2 up' }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'move mapping row 1 down' }),
    );
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [threeRows[2], threeRows[0], threeRows[1]],
    });
  });

  it('offers no move past either end of the list', () => {
    mountOver(copyNode({ mapping: threeRows, mode: 'append' }));

    const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(button('move mapping row 1 up').disabled).toBe(true);
    expect(button('move mapping row 1 down').disabled).toBe(false);
    expect(button('move mapping row 3 up').disabled).toBe(false);
    expect(button('move mapping row 3 down').disabled).toBe(true);
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
    // store. No single cell can see it; `copyMappingShapeIssues` can, and the panel must
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
    const expressionRow = {
      expression: '${params.batch}',
      sink: 'name',
      type: 'string',
      onError: 'fail',
    };
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

    fireEvent.click(toJson());

    expect(screen.queryByRole('button', { name: 'Auto-map columns' })).toBeNull();
  });

  it('names the sink column that matched more than one source column', () => {
    // Counted would be useless: the author has to pick the source column by
    // hand and cannot without knowing which sink column is stuck.
    mount({ mapping: [ROW], mode: 'append' }, [
      dset('d_src', 'people', [col('name'), col('NAME')]),
      dset('d_sink', 'staff', [col('Name')]),
    ]);

    autoMap();

    expect(screen.getByText(/Name matched more than one source column/)).toBeTruthy();
  });

  it('counts the columns an existing row already claims', () => {
    mount(
      { mapping: [{ source: 'id', sink: 'id', type: 'integer', onError: 'fail' }], mode: 'append' },
      [
        dset('d_src', 'people', [col('id', 'integer')]),
        dset('d_sink', 'staff', [col('id', 'integer')]),
      ],
    );

    autoMap();

    expect(screen.getByText(/1 already mapped/)).toBeTruthy();
  });

  it('says two rows differing only by case write the same sink column', () => {
    // `copyMappingShapeIssues` dedupes sinks EXACTLY, so it lets this pair through; the
    // store refuses it at dispatch, on a version that is already immutable.
    mount(
      {
        mapping: [
          { source: 'a', sink: 'id', type: 'integer', onError: 'fail' },
          { source: 'b', sink: 'ID', type: 'integer', onError: 'fail' },
        ],
        mode: 'append',
      },
      [
        dset('d_src', 'people', [col('a'), col('b')]),
        dset('d_sink', 'staff', [col('id', 'integer')]),
      ],
    );

    expect(screen.getByText(/id and ID differ only by case/)).toBeTruthy();
  });

  it('drops the auto-map line once the draft it describes is applied', () => {
    const panel = mount({ mapping: [ROW], mode: 'append' });

    autoMap();
    expect(screen.getByText(/Apply config to save/)).toBeTruthy();

    panel.apply();

    expect(screen.queryByText(/Apply config to save/)).toBeNull();
  });
});

/**
 * #1178 — the expression picker on a mapping row's cells (§13, item 3 of #1170).
 *
 * The picker used to probe a candidate by TOP-LEVEL config field name, so a cell
 * (`mapping[1].expression`) had no way to ask about itself and was given no
 * picker at all. Every assertion here is about which references a CELL is
 * offered and where a chosen one lands — never about the list's markup.
 */
describe('the expression picker on a mapping cell (#1178)', () => {
  const copyNode = (config: Record<string, unknown>): Node => ({
    id: 'n_copy',
    type: 'copy',
    position: { x: 0, y: 0 },
    config,
  });
  const params: Param[] = [{ name: 'limit', type: 'number', required: true }];
  const rows = [
    { source: 'name', sink: 'full_name', type: 'string', onError: 'fail' },
    { expression: 'fixed', sink: 'tag', type: 'string', onError: 'fail' },
    { source: 'city', sink: 'town', type: 'string', onError: 'fail' },
  ];
  const open = (cell: string) =>
    fireEvent.click(screen.getByRole('button', { name: `Insert reference into ${cell}` }));
  const offered = () => screen.queryByRole('button', { name: /^limit/ });

  it("writes a chosen reference into THAT row's expression, and no other row", () => {
    const panel = mountOver(copyNode({ mapping: rows, mode: 'append' }), [], [], params);

    fireEvent.change(screen.getByLabelText('mapping row 2 expression (optional)'), {
      target: { value: '' },
    });
    open('mapping row 2 expression');
    fireEvent.click(screen.getByRole('button', { name: /^limit/ }));
    panel.apply();

    expect(panel.storedConfig()).toMatchObject({
      mapping: [rows[0], { ...rows[1], expression: '${params.limit}' }, rows[2]],
    });
  });

  it('offers references to a draft row that carries a complaint of its own', () => {
    // The stored doc has three rows; the fourth is unapplied, and mid-edit it
    // repeats row 2's sink. Compared against the STORED doc, every candidate
    // would carry that duplicate-sink complaint as a NEW issue and be refused for
    // a problem the reference did not cause — so the list would be empty.
    mountOver(copyNode({ mapping: rows, mode: 'append' }), [], [], params);

    fireEvent.click(screen.getByRole('button', { name: 'Add mapping row' }));
    fireEvent.change(screen.getByLabelText('mapping row 4 sink'), { target: { value: 'tag' } });
    open('mapping row 4 expression');
    fireEvent.click(screen.getByRole('button', { name: /^limit/ }));

    expect(
      (screen.getByLabelText('mapping row 4 expression (optional)') as HTMLTextAreaElement).value,
    ).toBe('${params.limit}');
  });

  it('offers nothing to a column-name cell, which §8 holds to a literal', () => {
    // `sink` refuses any `${}` at save (`validateCopyMappingIdentifiers`). Both
    // mode probes carry that refusal equally, so the field reads as a template —
    // and an unfiltered template list would offer references that are ALL refused.
    mountOver(copyNode({ mapping: rows, mode: 'append' }), [], [], params);
    // Already holding a refused `${}`: the refusal must not become the BASELINE
    // a candidate is compared against, or every candidate would pass as "no new
    // issue".
    fireEvent.change(screen.getByLabelText('mapping row 3 sink'), {
      target: { value: '${run.runId}' },
    });

    open('mapping row 3 sink');

    expect(offered()).toBeNull();
    expect(screen.getByText(/No reference in this pipeline fits mapping row 3 sink/)).toBeTruthy();
  });

  it('offers nothing to the expression of a row that already reads a source column', () => {
    // `source` XOR `expression`: any reference here is refused at save.
    mountOver(copyNode({ mapping: rows, mode: 'append' }), [], [], params);

    open('mapping row 1 expression');

    expect(offered()).toBeNull();
  });

  it('closes an open list when an earlier row is removed, rather than aim it at the next row', () => {
    // Row 2's list is resolved against row 2. Removing row 1 slides row 3 (which
    // reads a `source`, so its expression is XOR-refused) into that slot; a list
    // still open there would write a reference into a row it never checked.
    mountOver(copyNode({ mapping: rows, mode: 'append' }), [], [], params);

    open('mapping row 2 expression');
    expect(offered()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'remove mapping row 1' }));

    expect(offered()).toBeNull();
  });

  it('closes an open list when its row is moved, since the count alone does not change (#1347)', () => {
    // Moving row 1 down puts row 2 in row 1's slot with the list count
    // unchanged. A list keyed on the count alone would stay open there, aimed at
    // a row it was never resolved against.
    mountOver(copyNode({ mapping: rows, mode: 'append' }), [], [], params);

    open('mapping row 2 expression');
    expect(offered()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'move mapping row 1 down' }));

    expect(offered()).toBeNull();
  });

  it("offers nothing to an llm_call tool's cells, none of which take a pipeline reference", () => {
    // `llm_call.tools` is the other row list, so its text cells gained the picker
    // too. Every one refuses a pipeline reference at save — `name` must be an
    // identifier, `description` refuses templates, and `expression` is scoped to
    // `${tool.args.*}` — so an unfiltered list here would be all false offers.
    mountOver(
      node('n_llm', 'llm_call', {
        prompt: 'hi',
        tools: [
          {
            name: 'lookup',
            description: 'Look a word up',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
            },
            expression: '${tool.args.q}',
          },
        ],
      }),
      [],
      [],
      params,
    );

    for (const cell of ['name', 'description', 'expression']) {
      open(`tools row 1 ${cell}`);
      expect(offered(), cell).toBeNull();
      fireEvent.keyDown(
        screen.getByRole('button', { name: `Insert reference into tools row 1 ${cell}` }),
        {
          key: 'Escape',
        },
      );
    }
    // …while a plain field on the same node is still offered it.
    open('prompt');
    expect(offered()).toBeTruthy();
  });

  it("offers a message's content the references its prompt would take (#852 item 3)", () => {
    // Dispatch substitutes into `messages[].content` exactly as into `prompt`,
    // so a row cell offering less than the field it replaces would be a
    // regression wearing a nicer control.
    mountOver(
      node('n_llm', 'llm_call', { messages: [{ role: 'user', content: 'hi' }] }),
      [],
      [],
      params,
    );

    open('messages row 1 content');

    expect(offered()).toBeTruthy();
  });
});

/**
 * #1304 — per-dispatch overrides get an editor. The assertions read the DOC, as
 * the binding suite's do. The gate that refuses a bad override runs only at
 * dispatch, so the rows' flags are the author's only warning before a run.
 */
describe('parameter override editor (#1304)', () => {
  const fsConn = (parameters: string[]) =>
    ({
      id: 'c_fs',
      name: 'Files',
      kind: 'fs',
      config: { roots: ['/data'], maxBytes: 1000 },
      parameters,
      secretStatus: 'not_required',
      ownerId: null,
      resourceId: 'r_c_fs',
      secretRef: null,
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as Parameters<typeof NodePanel>[0]['connections'][number];
  const csv = (parameters: string[]) =>
    ({
      id: 'd_csv',
      name: 'people.csv',
      kind: 'delimited',
      connectionId: 'c_fs',
      config: { path: 'in.csv' },
      columns: [],
      parameters,
      ownerId: null,
      resourceId: 'r_d_csv',
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as Parameters<typeof NodePanel>[0]['datasets'][number];
  const lookup = (extra: Partial<Node> = {}): Node =>
    ({
      ...node('n_look', 'lookup', {}),
      connectionId: 'c_fs',
      datasetIds: { source: 'd_csv' },
      ...extra,
    }) as Node;
  const docNode = (store: ReturnType<typeof createCanvasStore>) => store.getState().nodes[0]!;
  const addOverride = (group: string, key: string) => {
    const fieldset = screen.getByRole('group', { name: group });
    fireEvent.change(within(fieldset).getByRole('combobox', { name: /Add .* override/ }), {
      target: { value: key },
    });
    fireEvent.click(within(fieldset).getByRole('button', { name: 'Add override' }));
  };

  it('adds a connection override from the allowlist, starting at the stored value', () => {
    const { store } = mountOver(lookup(), [fsConn(['maxBytes'])], [csv(['path'])]);
    addOverride('Connection overrides', 'maxBytes');
    expect(docNode(store).connectionParams).toEqual({ maxBytes: 1000 });
    // A number field's text is COERCED as it is written, so dispatch's re-validation sees a number.
    fireEvent.change(screen.getByRole('textbox', { name: 'maxBytes' }), {
      target: { value: '2048' },
    });
    expect(docNode(store).connectionParams).toEqual({ maxBytes: 2048 });
  });

  it('writes a dataset end’s override, and keeps a whole ${} verbatim', () => {
    const { store } = mountOver(lookup(), [fsConn([])], [csv(['path'])]);
    addOverride('Source dataset overrides', 'path');
    fireEvent.change(screen.getByRole('textbox', { name: 'path' }), {
      target: { value: '${params.file}' },
    });
    expect(docNode(store).datasetParams).toEqual({ source: { path: '${params.file}' } });
  });

  it('removing the last row clears the field outright', () => {
    const { store } = mountOver(lookup({ connectionParams: { maxBytes: 5 } }), [
      fsConn(['maxBytes']),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove override maxBytes' }));
    expect('connectionParams' in docNode(store)).toBe(false);
  });

  it('keeps a half-typed number on screen and flags it, rather than snapping it back', () => {
    const { store } = mountOver(lookup({ connectionParams: { maxBytes: 5 } }), [
      fsConn(['maxBytes']),
    ]);
    const input = screen.getByRole('textbox', { name: 'maxBytes' });
    // `12.50` already stores the number 12.5. Rendering the STORED value back
    // would snap the input to `12.5` while the operator is still typing.
    fireEvent.change(input, { target: { value: '12.50' } });
    expect((input as HTMLInputElement).value).toBe('12.50');
    expect(docNode(store).connectionParams).toEqual({ maxBytes: 12.5 });
    fireEvent.change(input, { target: { value: '12x' } });
    expect((input as HTMLInputElement).value).toBe('12x');
    expect(docNode(store).connectionParams).toEqual({ maxBytes: '12x' });
    expect(screen.getByText(/must be a number/)).toBeTruthy();
  });

  it('undo restores the ROW, not only the doc — the draft follows a store change it did not make', () => {
    const { store } = mountOver(lookup({ connectionParams: { maxBytes: 5 } }), [
      fsConn(['maxBytes']),
    ]);
    const input = screen.getByRole('textbox', { name: 'maxBytes' });
    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.change(input, { target: { value: '64' } });
    act(() => store.getState().undo());
    // One burst, one undo step, and the input shows the value undo restored.
    expect(docNode(store).connectionParams).toEqual({ maxBytes: 5 });
    expect((input as HTMLInputElement).value).toBe('5');
  });

  it('flags a stored override the connection does not declare — a run would refuse it', () => {
    mountOver(lookup({ connectionParams: { maxEntries: 5 } }), [fsConn(['maxBytes'])]);
    expect(screen.getByText(/Files does not declare `maxEntries`/)).toBeTruthy();
  });

  it('says why nothing can be added when the allowlist is empty', () => {
    mountOver(lookup(), [fsConn([])], [csv([])]);
    const group = screen.getByRole('group', { name: 'Connection overrides' });
    expect(within(group).getByText(/Files declares no overridable settings/)).toBeTruthy();
    expect(within(group).queryByRole('button', { name: 'Add override' })).toBeNull();
  });

  it('a bound resource this workspace does not list gets no false flags and no Add', () => {
    mountOver(lookup({ connectionParams: { maxBytes: 5 } }), [], [csv(['path'])]);
    const group = screen.getByRole('group', { name: 'Connection overrides' });
    expect(within(group).getByText(/not one this workspace lists/)).toBeTruthy();
    expect(within(group).queryByText(/does not declare/)).toBeNull();
    expect(within(group).queryByRole('button', { name: 'Add override' })).toBeNull();
  });

  it('shows no editor for an end the node does not bind', () => {
    mountOver(lookup({ connectionId: undefined, datasetIds: undefined }), [fsConn(['maxBytes'])]);
    expect(screen.queryByRole('group', { name: 'Connection overrides' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Source dataset overrides' })).toBeNull();
  });

  it('no editor on an activity that takes no connection, even with a stray one', () => {
    // An import or API seed can leave a `connectionId` on a `wait`. Its picker is
    // hidden, so an overrides card under it would offer edits to a binding the
    // panel gives no way to see or clear.
    mountOver({ ...node('n_wait', 'wait', {}), connectionId: 'c_fs' } as Node, [
      fsConn(['maxBytes']),
    ]);
    expect(screen.queryByRole('group', { name: 'Connection overrides' })).toBeNull();
  });

  it('unbinding the connection in the panel takes its overrides with it', () => {
    const { store } = mountOver(lookup({ connectionParams: { maxBytes: 5 } }), [
      fsConn(['maxBytes']),
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Connection' }), {
      target: { value: '' },
    });
    expect('connectionParams' in docNode(store)).toBe(false);
    expect(screen.queryByRole('group', { name: 'Connection overrides' })).toBeNull();
  });
});

describe('NodePanel — run policy (#1312)', () => {
  it('offers the run policy section on an ordinary activity, writing to node.policy', () => {
    const { store } = mountOver(httpNode({ url: 'https://example.test' }));
    const section = screen.getByRole('group', { name: 'Run policy' });
    fireEvent.click(within(section).getByLabelText('Secure output'));
    expect(store.getState().nodes[0]?.policy).toEqual({ secureOutput: true });
    // Straight to the store: the config form's Apply is not involved.
    expect(store.getState().nodes[0]?.config).toEqual({ url: 'https://example.test' });
  });
});

describe('NodePanel — the issues on this node (#863)', () => {
  it("lists this node's issues, leaving its own policy refusals to PolicyEditor", () => {
    const target: Node = { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } };
    const store = createCanvasStore();
    store.setState({ nodes: [target] });
    render(
      <SubjectIssuesContext.Provider
        value={
          new Map([
            [
              subjectKey('node', 'n_a'),
              [
                { raw: 'nodes.n_a.config.url: bad ref', text: 'readable bad ref' },
                { raw: "node 'n_a': policy.retry: nope", text: 'readable policy refusal' },
              ],
            ],
          ])
        }
      >
        <NodePanel
          store={store}
          connections={[]}
          datasets={[]}
          nodeId="n_a"
          nodeType="http_request"
          config={{}}
          connectionId={undefined}
          call={undefined}
        />
      </SubjectIssuesContext.Provider>,
    );
    // COUNTED like the canvas badge (2), listed once: the policy refusal is
    // pointed at rather than repeated.
    expect(screen.getByText('2 validation issues')).toBeTruthy();
    expect(screen.getByText('readable bad ref')).toBeTruthy();
    expect(screen.queryByText('readable policy refusal')).toBeNull();
    expect(screen.getByText('1 more under Run policy, below.')).toBeTruthy();
  });

  it('shows no issue section for a node with none', () => {
    const target: Node = { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } };
    mountOver(target);
    expect(screen.queryByText(/validation issue/)).toBeNull();
  });
});
