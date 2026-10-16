import { describe, expect, it } from 'vitest';
import type { Container, Node } from '../../schemas/pipeline.js';
import { copyFilesConfigSchema } from '../copy-files-config.js';
import { getMetadataConfigSchema } from '../get-metadata-config.js';
import { getActivity } from '../registry.js';
import { RETIRED_LOWERINGS, lowerRetiredTypes, splitDestination } from '../retired.js';

const fileNode = (type: string, config: Record<string, unknown>, extra: Partial<Node> = {}): Node =>
  ({
    id: 'n1',
    type,
    config,
    connectionId: 'conn_fs',
    position: { x: 10, y: 20 },
    ...extra,
  }) as Node;

// The C1b cases are about one node; a doc with no containers is their whole world.
const lowerNodes = (nodes: Node[]) => lowerRetiredTypes({ nodes, containers: [] }).nodes;

describe('#1600 C1b — splitDestination', () => {
  it.each([
    ['out/a.csv', { folder: 'out', name: 'a.csv' }],
    ['/data/out/a.csv', { folder: '/data/out', name: 'a.csv' }],
    ['/a.csv', { folder: '/', name: 'a.csv' }],
    ['a.csv', { folder: undefined, name: 'a.csv' }],
    ['${root}/out/a.csv', { folder: '${root}/out', name: 'a.csv' }],
    ['/data/${day}/a.csv', { folder: '/data/${day}', name: 'a.csv' }],
    ['out/a_${day}.csv', { folder: 'out', name: 'a_${day}.csv' }],
    ['report_${day}.csv', { folder: undefined, name: 'report_${day}.csv' }],
    ["out/a${concat('x/', name)}", { folder: 'out', name: "a${concat('x/', name)}" }],
    ['out/$${x}/a.csv', { folder: 'out/$${x}', name: 'a.csv' }],
    ['$${x}.csv', { folder: undefined, name: '$${x}.csv' }],
  ])('%s', (dest, expected) => {
    expect(splitDestination(dest)).toEqual(expected);
  });

  it('refuses a name that begins with an expression, which may resolve absolute or to a number', () => {
    expect(splitDestination('${pipeline.parameters.dest}')).toBeUndefined();
    expect(splitDestination('${a}${b}')).toBeUndefined();
    expect(splitDestination('out/${name}')).toBeUndefined();
    expect(splitDestination('out/${name}.csv')).toBeUndefined();
  });

  it('refuses a folder that is one bare expression, which may resolve empty or to a number', () => {
    expect(splitDestination('${dir}/a.csv')).toBeUndefined();
  });

  it('refuses an unterminated expression', () => {
    expect(splitDestination('out/a${unterminated')).toBeUndefined();
  });
});

describe('#1600 C1b — lowerRetiredTypes', () => {
  it('file_copy becomes Copy · Files as-is, one file, After copy Keep', () => {
    const node = fileNode(
      'file_copy',
      { source: 'in/a.csv', dest: '/data/out/a.csv', outputs: [] },
      { description: 'd', policy: { retry: 2 }, userProperties: [{ name: 'k', value: 'v' }] },
    );
    const [lowered] = lowerNodes([node]);
    expect(lowered).toEqual({
      id: 'n1',
      type: 'copy_files',
      position: { x: 10, y: 20 },
      description: 'd',
      policy: { retry: 2 },
      userProperties: [{ name: 'k', value: 'v' }],
      connectionIds: { source: 'conn_fs', sink: 'conn_fs' },
      config: {
        pathType: 'file',
        sourcePath: 'in/a.csv',
        sinkFolder: '/data/out',
        sinkFileName: 'a.csv',
        afterCopy: 'keep',
        ifExists: 'overwrite',
        outputs: getActivity('copy_files')!.outputs,
      },
    });
    expect(lowered).not.toHaveProperty('connectionId');
    // A copy, not the registry's own objects.
    const declared = lowered!.config['outputs'] as object[];
    expect(declared).not.toBe(getActivity('copy_files')!.outputs);
    expect(declared[0]).not.toBe(getActivity('copy_files')!.outputs[0]);
    const config = { ...lowered!.config };
    delete config['outputs'];
    expect(copyFilesConfigSchema.safeParse(config).success).toBe(true);
  });

  it('file_move becomes the same with After copy Delete source', () => {
    const [lowered] = lowerNodes([fileNode('file_move', { source: 'a', dest: 'b' })]);
    expect(lowered!.type).toBe('copy_files');
    expect(lowered!.config).toMatchObject({ afterCopy: 'delete', sinkFileName: 'b' });
    expect(lowered!.config).not.toHaveProperty('sinkFolder');
  });

  it('keeps an inactive node inactive, and an unbound one unbound', () => {
    const [lowered] = lowerNodes([
      fileNode(
        'file_copy',
        { source: 'a', dest: 'b' },
        { connectionId: undefined, state: 'inactive' },
      ),
    ]);
    expect(lowered!.type).toBe('copy_files');
    expect(lowered!.state).toBe('inactive');
    expect(lowered).not.toHaveProperty('connectionIds');
  });

  it.each([
    [
      'connection parameters, which a paired node refuses',
      { connectionParams: { maxBytes: 1 } },
      {},
    ],
    ['a whole-expression destination', {}, { dest: '${pipeline.parameters.dest}' }],
    ['a half-filled config', {}, { source: '' }],
    ['a destination ending in a folder separator', {}, { dest: 'out/' }],
    ['no destination', {}, { dest: undefined }],
  ])('leaves a node with %s as it is', (_why, extra, config) => {
    const node = fileNode(
      'file_copy',
      { source: 'a', dest: 'b', ...config },
      extra as Partial<Node>,
    );
    expect(lowerNodes([node])[0]).toBe(node);
  });

  it('returns every other node by reference', () => {
    const copy = fileNode('copy_files', { pathType: 'file', sourcePath: 'a' });
    const set = fileNode('set_variable', {});
    const nodes = [copy, set];
    const out = lowerNodes(nodes);
    expect(out[0]).toBe(copy);
    expect(out[1]).toBe(set);
  });

  it('does not read an inherited key as a retired type', () => {
    const node = fileNode('constructor', {});
    expect(lowerNodes([node])[0]).toBe(node);
  });
});

describe('#1600 C1b — §8 output aliases', () => {
  it.each(Object.entries(RETIRED_LOWERINGS))(
    '%s: every retired output name resolves on the replacement with its type',
    (retired, lowering) => {
      const from = getActivity(retired)!;
      const to = getActivity(lowering.to)!;
      expect(Object.keys(lowering.outputs).sort()).toEqual(from.outputs.map((o) => o.name).sort());
      for (const o of from.outputs) {
        const target = to.outputs.find((t) => t.name === lowering.outputs[o.name]);
        expect(target, o.name).toBeDefined();
        expect(target!.type).toBe(o.type);
      }
    },
  );

  it('retired types are kept out of the palette but stay runnable catalog types', () => {
    for (const retired of Object.keys(RETIRED_LOWERINGS)) {
      const entry = getActivity(retired)!;
      expect(entry.inPalette).toBe(false);
      expect(entry.dispatchConfigSchema).toBeDefined();
    }
  });
});

describe('#1600 C8b — file_list → Get metadata · Child items', () => {
  const list = (config: Record<string, unknown> = { path: 'landing' }, extra: Partial<Node> = {}) =>
    fileNode('file_list', config, { id: 'list', ...extra });
  const reader = (config: Record<string, unknown>, id = 'read'): Node =>
    ({ id, type: 'filter', config, position: { x: 0, y: 0 } }) as Node;
  const foreach = (items: string): Container =>
    ({ id: 'each', kind: 'foreach', children: ['read'], items }) as Container;

  it('becomes Get metadata on the same connection and path, Child items ticked', () => {
    const node = list(
      { path: 'landing', outputs: [] },
      { description: 'd', policy: { retry: 2 }, userProperties: [{ name: 'k', value: 'v' }] },
    );
    const { nodes } = lowerRetiredTypes({ nodes: [node], containers: [] });
    const lowered = nodes[0]!;
    expect(lowered.type).toBe('get_metadata');
    expect(lowered.connectionId).toBe('conn_fs');
    expect(lowered).toMatchObject({
      id: 'list',
      description: 'd',
      policy: { retry: 2 },
      userProperties: [{ name: 'k', value: 'v' }],
      position: { x: 10, y: 20 },
    });
    const { outputs, ...config } = lowered.config;
    expect(config).toEqual({ path: 'landing', fieldList: ['childItems'] });
    expect((outputs as { name: string }[]).map((o) => o.name)).toEqual(
      getActivity('get_metadata')!.outputs.map((o) => o.name),
    );
    // Get metadata's schema reads the defaults List directory behaved as.
    expect(getMetadataConfigSchema.parse(config)).toMatchObject({
      childFilter: '*',
      childType: 'all',
    });
  });

  it('rewrites `entries` reads in other nodes and in containers, and nothing else', () => {
    const r = reader({
      items: '${nodes.list.output.entries}',
      predicate: "${equals(item.type, 'file')}",
      label: '${nodes.list.output.path} ${nodes.list.status}',
    });
    const other = reader({ items: '${nodes.x.output.entries}' }, 'x2');
    const loop = {
      id: 'loop',
      kind: 'loop',
      children: [],
      exitWhen: '${empty(nodes.list.output.entries)}',
    } as unknown as Container;
    const out = lowerRetiredTypes({
      nodes: [list(), r, other],
      containers: [foreach('${nodes.list.output.entries}'), loop],
    });
    expect(out.nodes[1]!.config).toEqual({
      items: '${nodes.list.output.childItems}',
      predicate: "${equals(item.type, 'file')}",
      label: '${nodes.list.output.path} ${nodes.list.status}',
    });
    expect(out.nodes[2]).toBe(other);
    expect(out.containers[0]!.items).toBe('${nodes.list.output.childItems}');
    expect((out.containers[1] as { exitWhen?: string }).exitWhen).toBe(
      '${empty(nodes.list.output.childItems)}',
    );
  });

  it('rewrites reads outside config too, but never a description', () => {
    const r = {
      ...reader({}),
      description: 'reads ${nodes.list.output.entries}',
      userProperties: [{ name: 'n', value: '${nodes.list.output.entries}' }],
    } as Node;
    const [, out] = lowerRetiredTypes({ nodes: [list(), r], containers: [] }).nodes;
    expect(out!.description).toBe('reads ${nodes.list.output.entries}');
    expect(out!.userProperties).toEqual([{ name: 'n', value: '${nodes.list.output.childItems}' }]);
  });

  it('stays List directory, with every reader untouched, when one read cannot be rewritten', () => {
    const ok = reader({ items: '${nodes.list.output.entries}' });
    const doc = {
      nodes: [list(), ok],
      containers: [foreach('${nodes.list.output}')],
    };
    expect(lowerRetiredTypes(doc)).toBe(doc);
  });

  it.each([
    ['carries connectionParams', list({ path: 'a' }, { connectionParams: { root: 'x' } })],
    ['has no path', list({})],
    ['has an empty path', list({ path: '' })],
    ['has a non-string path', list({ path: 5 })],
  ])('stays List directory when it %s', (_why, node) => {
    const doc = { nodes: [node], containers: [] };
    expect(lowerRetiredTypes(doc)).toBe(doc);
  });

  it('a later retired node reads the earlier one under its new name', () => {
    const copy = fileNode(
      'file_copy',
      { source: '${nodes.list.output.entries[0].name}', dest: 'out/a.csv' },
      { id: 'cp' },
    );
    const { nodes } = lowerRetiredTypes({ nodes: [list(), copy], containers: [] });
    expect(nodes.map((n) => n.type)).toEqual(['get_metadata', 'copy_files']);
    expect(nodes[1]!.config['sourcePath']).toBe('${nodes.list.output.childItems[0].name}');
  });

  it('returns the doc itself when nothing is retired', () => {
    const doc = { nodes: [reader({ items: '${nodes.list.output.entries}' })], containers: [] };
    expect(lowerRetiredTypes(doc)).toBe(doc);
  });
});
