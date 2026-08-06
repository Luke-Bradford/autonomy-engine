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
function mountOver(target: Node, connections: Parameters<typeof NodePanel>[0]['connections'] = []) {
  const store = createCanvasStore();
  store.setState({ nodes: [target] });

  function Harness() {
    const node = useStore(store, (s) => s.nodes.find((n) => n.id === target.id));
    if (!node) return null;
    return (
      <NodePanel
        store={store}
        connections={connections}
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

  it('still renders the generic config editor for a normal (non-call) activity', () => {
    render(
      <NodePanel
        store={createCanvasStore()}
        connections={[]}
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
