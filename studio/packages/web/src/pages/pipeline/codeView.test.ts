import { describe, expect, it } from 'vitest';
import { PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import { createCanvasStore, workingDocOfState } from './canvasStore';
import { checkCodeText, codeViewText } from './codeView';
import { STARTER_TEMPLATES } from './starterTemplates';

/**
 * #1573 OR38 — the Code view's check and its Apply. The round-trip tests are the
 * ticket's "canvas → JSON → canvas is lossless"; the rest pin which refusals
 * block Apply and that each is placed on its line.
 */
function version(overrides: Partial<PipelineVersion> = {}): PipelineVersion {
  return PipelineVersionSchema.parse({
    id: 'plv_1',
    resourceId: 'res_plv1',
    pipelineId: 'pl_1',
    version: 1,
    params: [],
    outputs: [],
    nodes: [
      {
        id: 'n_if',
        type: 'if',
        config: { condition: '${equals(1, 1)}' },
        position: { x: 10, y: 20 },
      },
      { id: 'n_wait', type: 'wait', config: { seconds: 1 }, position: { x: 200, y: 20 } },
    ],
    edges: [{ id: 'e_1', from: 'n_if', to: 'n_wait', on: 'success' }],
    containers: [],
    catalogVersion: 1,
    createdAt: 1,
    ...overrides,
  });
}

/** A doc using every field the view shows. */
const RICH = version({
  description: 'every field',
  annotations: ['nightly', 'finance'],
  params: [{ name: 'mode', type: 'string', required: false, default: 'full' }],
  variables: [{ name: 'count', type: 'number', default: 0, description: 'rows seen' }],
  outputs: [{ name: 'done', type: 'boolean', description: 'finished' }],
  nodes: [
    {
      id: 'n_if',
      type: 'if',
      config: { condition: "${equals(params.mode, 'full')}" },
      position: { x: 10.5, y: -20 },
      description: 'branch on mode',
      policy: { retry: 2, retryIntervalSeconds: 30 },
    },
    { id: 'n_wait', type: 'wait', config: { seconds: 5 }, position: { x: 200, y: 20 } },
  ],
  edges: [{ id: 'e_1', from: 'n_if', to: 'n_wait', on: 'success' }],
  containers: [{ id: 'stage', kind: 'stage', children: ['n_wait'] }],
});

function opened(v: PipelineVersion) {
  const store = createCanvasStore();
  store.getState().loadVersion(v);
  return store;
}

const blocking = (text: string) => checkCodeText(text, []).problems.filter((p) => p.blocking);

/** Replace the first `from` in the text, asserting it was there. */
function edited(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

const lineOf = (text: string, needle: string) =>
  text.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('round-trip: canvas → JSON → canvas', () => {
  const cases: [string, PipelineVersion][] = [
    ['a doc using every field', RICH],
    ...STARTER_TEMPLATES.map((t): [string, PipelineVersion] => [
      `starter template ${t.id}`,
      version({ nodes: t.nodes, edges: t.edges, containers: t.containers }),
    ]),
  ];
  it.each(cases)('%s: the text applies to the doc it came from, as no edit', (_name, v) => {
    const store = opened(v);
    const before = workingDocOfState(store.getState());
    const text = codeViewText(before);
    const check = checkCodeText(text, []);
    expect(check.problems.filter((p) => p.blocking)).toEqual([]);
    expect(check.doc).not.toBeNull();
    expect(store.getState().applyDoc(check.doc!)).toBe(false);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().dirty).toBe(false);
    expect(codeViewText(workingDocOfState(store.getState()))).toBe(text);
  });

  it('shows positions, containers and the general fields', () => {
    const text = codeViewText(workingDocOfState(opened(RICH).getState()));
    const shown = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(shown)).toEqual([
      'description',
      'annotations',
      'params',
      'variables',
      'outputs',
      'nodes',
      'edges',
      'containers',
    ]);
    expect(text).toContain('"x": 10.5');
    expect(shown['containers']).toEqual([
      expect.objectContaining({ id: 'stage', children: ['n_wait'] }),
    ]);
  });
});

describe('Apply', () => {
  it('replaces the doc as one undoable edit', () => {
    const store = opened(RICH);
    const text = codeViewText(workingDocOfState(store.getState()));
    const changed = edited(text, "'full')}", "'delta')}");
    const check = checkCodeText(changed, []);
    expect(store.getState().applyDoc(check.doc!)).toBe(true);
    const ifNode = () => store.getState().nodes.find((n) => n.id === 'n_if')!;
    expect(ifNode().config['condition']).toBe("${equals(params.mode, 'delta')}");
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(ifNode().config['condition']).toBe("${equals(params.mode, 'full')}");
    store.getState().redo();
    expect(ifNode().config['condition']).toBe("${equals(params.mode, 'delta')}");
  });

  it('treats a Format-only or reordered text as no change', () => {
    const store = opened(RICH);
    const doc = workingDocOfState(store.getState());
    // The graph first and the general fields last: the reverse of the view's order.
    const { nodes, edges, containers, ...rest } = doc;
    const reordered = JSON.stringify({ containers, edges, nodes, ...rest });
    expect(store.getState().applyDoc(checkCodeText(reordered, []).doc!)).toBe(false);
    expect(store.getState().past).toHaveLength(0);
  });

  it('lowers a retired type typed into the JSON, as on open', () => {
    const store = opened(RICH);
    const text = codeViewText(workingDocOfState(store.getState()));
    const changed = edited(
      edited(text, '"type": "wait"', '"type": "file_copy"'),
      '"seconds": 5',
      '"source": "in/a.csv", "dest": "out/a.csv"',
    );
    const check = checkCodeText(changed, []);
    expect(check.problems.filter((p) => p.blocking)).toEqual([]);
    store.getState().applyDoc(check.doc!);
    expect(store.getState().nodes.find((n) => n.id === 'n_wait')?.type).toBe('copy_files');
  });
});

describe('what keeps Apply off, and where it is shown', () => {
  const text = codeViewText(workingDocOfState(opened(RICH).getState()));

  it('text that is not JSON, at the line of the mistake', () => {
    const broken = edited(text, '"type": "if",', '"type": "if"');
    const check = checkCodeText(broken, []);
    expect(check.doc).toBeNull();
    expect(check.problems).toEqual([
      expect.objectContaining({ blocking: true, line: lineOf(broken, '"type": "if"') + 1 }),
    ]);
    expect(check.problems[0]!.message).toMatch(/^not valid JSON: /);
  });

  it('a value the write schema refuses, at its path', () => {
    const bad = edited(text, '"x": 10.5', '"x": "left"');
    const [problem, ...rest] = blocking(bad);
    expect(rest).toEqual([]);
    expect(problem).toMatchObject({ line: lineOf(bad, '"x": "left"') });
    expect(problem!.message).toMatch(/^nodes\[0\]\.position\.x: /);
  });

  it('a key the schema would silently drop', () => {
    const bad = edited(text, '"id": "n_wait",', '"id": "n_wait",\n      "colour": "red",');
    expect(blocking(bad)).toEqual([
      {
        message: 'nodes[1].colour: not a field here',
        line: lineOf(bad, '"colour"'),
        blocking: true,
      },
    ]);
  });

  it('a number JSON cannot carry', () => {
    const bad = edited(text, '"x": 10.5', '"x": 1e999');
    expect(blocking(bad)).toEqual([
      {
        message: 'nodes[0].position.x: the number is too large',
        line: lineOf(bad, '1e999'),
        blocking: true,
      },
    ]);
  });

  it('an extra key named like an Object method', () => {
    const bad = edited(text, '"id": "n_wait",', '"id": "n_wait",\n      "toString": 1,');
    expect(blocking(bad).map((p) => p.message)).toEqual(['nodes[1].toString: not a field here']);
  });

  it('an unknown top-level key, the server-stamped ones included', () => {
    const bad = edited(text, '{\n', '{\n  "catalogVersion": 3,\n  "basedOnVersionId": "v",\n');
    expect(blocking(bad).map((p) => [p.message, p.line])).toEqual([
      ['catalogVersion: not a field of the pipeline', 2],
      ['basedOnVersionId: not a field of the pipeline', 3],
    ]);
  });

  it('an unknown activity type, at its type', () => {
    const bad = edited(text, '"type": "wait"', '"type": "wiat"');
    expect(blocking(bad)).toEqual([
      {
        message: "node 'n_wait': type: unknown activity type 'wiat'",
        line: lineOf(bad, '"wiat"'),
        blocking: true,
      },
    ]);
  });

  it('a duplicate node id, a container sharing one, and a duplicate edge id', () => {
    const doc = workingDocOfState(opened(RICH).getState());
    const bad = codeViewText({
      ...doc,
      nodes: [...doc.nodes, { ...doc.nodes[1]!, position: { x: 0, y: 0 } }],
      edges: [...doc.edges, { ...doc.edges[0]! }],
      containers: [{ ...doc.containers[0]!, id: 'n_if' }],
    });
    expect(blocking(bad).map((p) => p.message)).toEqual([
      "node id 'n_wait' is used twice",
      "container id 'n_if' is also a node's id",
      "edge id 'e_1' is used twice",
    ]);
  });

  it('an edge to nothing, at its endpoint', () => {
    const bad = edited(text, '"to": "n_wait"', '"to": "n_gone"');
    expect(blocking(bad)).toEqual([
      {
        message: "edge 'e_1': to: 'n_gone' is not a node or container in this pipeline",
        line: lineOf(bad, '"n_gone"'),
        blocking: true,
      },
    ]);
  });

  it('lets through what the canvas holds as a badge, on its node’s line', () => {
    const bad = edited(text, '"seconds": 5', '"seconds": "${params.nope}"');
    const check = checkCodeText(bad, []);
    expect(check.doc).not.toBeNull();
    expect(check.problems.length).toBeGreaterThan(0);
    expect(check.problems.every((p) => !p.blocking)).toBe(true);
    const nope = check.problems.find((p) => p.message.includes('params.nope'));
    expect(nope).toMatchObject({ line: lineOf(bad, '"id": "n_wait"') - 1 });
  });
});
