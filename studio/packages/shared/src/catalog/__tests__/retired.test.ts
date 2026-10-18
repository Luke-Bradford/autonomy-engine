import { describe, expect, it } from 'vitest';
import type { Container, Node } from '../../schemas/pipeline.js';
import { copyFilesConfigSchema } from '../copy-files-config.js';
import { deleteConfigSchema } from '../delete-config.js';
import { getMetadataConfigSchema } from '../get-metadata-config.js';
import { WEB_MAX_RESPONSE_BYTES, webConfigSchema } from '../web-config.js';
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
        // The same type, or `json` on the replacement: `json` types as `any`
        // (`sigOfDeclared`), so every read that typed before still types. A
        // widening is safe; a narrowing would refuse a saved expression, so it
        // fails here. #1600 C11b: `http_request`'s string `body` is Web's json.
        if (target!.type !== 'json') expect(target!.type).toBe(o.type);
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

  it('a retired reader BEFORE the list node is renamed after it is lowered', () => {
    const copy = fileNode(
      'file_copy',
      { source: '${nodes.list.output.entries[0].name}', dest: 'out/a.csv' },
      { id: 'cp' },
    );
    const { nodes } = lowerRetiredTypes({ nodes: [copy, list()], containers: [] });
    expect(nodes.map((n) => n.type)).toEqual(['copy_files', 'get_metadata']);
    expect(nodes[0]!.config['sourcePath']).toBe('${nodes.list.output.childItems[0].name}');
  });

  it('each List directory is judged on its own reads', () => {
    const clean = list({ path: 'a' }, { id: 'l1' });
    const doubtful = list({ path: 'b' }, { id: 'l2' });
    const { nodes } = lowerRetiredTypes({
      nodes: [
        clean,
        doubtful,
        reader({ a: '${nodes.l1.output.entries}', b: '${nodes.l2.output}' }),
      ],
      containers: [],
    });
    expect(nodes.map((n) => n.type)).toEqual(['get_metadata', 'file_list', 'filter']);
    expect(nodes[1]).toBe(doubtful);
    expect(nodes[2]!.config).toEqual({
      a: '${nodes.l1.output.childItems}',
      b: '${nodes.l2.output}',
    });
  });

  it('returns the doc itself when nothing is retired', () => {
    const doc = { nodes: [reader({ items: '${nodes.list.output.entries}' })], containers: [] };
    expect(lowerRetiredTypes(doc)).toBe(doc);
  });
});

describe('#1600 C9b — file_delete → Delete, one file', () => {
  const del = (
    config: Record<string, unknown> = { path: 'landing/old.csv' },
    extra: Partial<Node> = {},
  ) => fileNode('file_delete', config, { id: 'del', ...extra });

  it('becomes Delete on the same connection and path, Path type File, Fail if nothing matched on', () => {
    const node = del(
      { path: 'landing/old.csv', outputs: [] },
      { description: 'd', policy: { retry: 2 }, userProperties: [{ name: 'k', value: 'v' }] },
    );
    const [lowered] = lowerNodes([node]);
    expect(lowered!.type).toBe('delete');
    expect(lowered).toMatchObject({
      id: 'del',
      connectionId: 'conn_fs',
      description: 'd',
      policy: { retry: 2 },
      userProperties: [{ name: 'k', value: 'v' }],
      position: { x: 10, y: 20 },
    });
    const { outputs, ...config } = lowered!.config;
    expect(config).toEqual({
      pathType: 'file',
      path: 'landing/old.csv',
      failIfNothingMatched: true,
    });
    expect((outputs as { name: string }[]).map((o) => o.name)).toEqual(
      getActivity('delete')!.outputs.map((o) => o.name),
    );
    // Delete's schema reads the defaults Delete file behaved as: one file, every
    // modification time, one at a time.
    expect(deleteConfigSchema.parse(config)).toMatchObject({
      wildcard: '*',
      recursive: false,
      maxConcurrentConnections: 1,
      deleteEmptyFolders: false,
    });
    expect(deleteConfigSchema.parse(config).modifiedStart).toBeUndefined();
    expect(deleteConfigSchema.parse(config).modifiedEnd).toBeUndefined();
  });

  it('lowers an expression path as written', () => {
    const [lowered] = lowerNodes([del({ path: 'in/${pipeline.parameters.name}.csv' })]);
    expect(lowered!.type).toBe('delete');
    expect(lowered!.config['path']).toBe('in/${pipeline.parameters.name}.csv');
  });

  it('leaves a `path` reader as it was: the output keeps its name', () => {
    const reader = {
      id: 'read',
      type: 'set_variable',
      config: { name: 'v', value: '${nodes.del.output.path}' },
      position: { x: 0, y: 0 },
    } as Node;
    const doc = { nodes: [del(), reader], containers: [] };
    const out = lowerRetiredTypes(doc);
    expect(out.nodes[0]!.type).toBe('delete');
    expect(out.nodes[1]).toBe(reader);
  });

  it.each([
    ['a path that is not a string', del({ path: 3 })],
    ['no path', del({})],
    ['an empty path', del({ path: '' })],
    ['connection params', del(undefined, { connectionParams: { root: 'x' } } as Partial<Node>)],
    ['a dataset', del(undefined, { datasetIds: { source: 'ds' } } as Partial<Node>)],
  ])('stays Delete file, by reference, with %s', (_why, node) => {
    expect(lowerNodes([node])[0]).toBe(node);
  });
});

describe('#1600 C11b — http_request → Web, Fail on HTTP error off, Parse as Text', () => {
  const call = (config: Record<string, unknown> = { url: '/items' }, extra: Partial<Node> = {}) =>
    ({
      id: 'call',
      type: 'http_request',
      config,
      connectionId: 'conn_http',
      position: { x: 10, y: 20 },
      ...extra,
    }) as Node;

  it("opens as Web on the same connection, keeping today's results", () => {
    const node = call({
      url: '/items/${run.runId}',
      method: 'post',
      headers: { 'x-trace': 'abc' },
      body: '{"a":1}',
      secretHeaders: { 'x-api-key': { $secret: 'api_key' } },
      outputs: [],
    });
    const [lowered] = lowerNodes([node]);
    expect(lowered!.type).toBe('web');
    expect(lowered!.connectionId).toBe('conn_http');
    expect(lowered!.position).toEqual({ x: 10, y: 20 });
    const { outputs, ...config } = lowered!.config;
    expect(config).toEqual({
      url: '/items/${run.runId}',
      method: 'POST',
      headers: { 'x-trace': 'abc' },
      body: '{"a":1}',
      secretHeaders: { 'x-api-key': { $secret: 'api_key' } },
      failOnHttpError: false,
      parseAs: 'text',
      maxResponseBytes: WEB_MAX_RESPONSE_BYTES,
    });
    expect(webConfigSchema.safeParse(config).success).toBe(true);
    expect((outputs as { name: string }[]).map((o) => o.name)).toEqual(
      getActivity('web')!.outputs.map((o) => o.name),
    );
  });

  it('an unset method is GET, and a lowercase one is upper-cased', () => {
    expect(lowerNodes([call()])[0]!.config['method']).toBe('GET');
    expect(lowerNodes([call({ url: '/a', method: 'patch' })])[0]!.config['method']).toBe('PATCH');
    expect(lowerNodes([call({ url: '/a', method: 'head' })])[0]!.config['method']).toBe('HEAD');
  });

  it('keeps connection parameter bindings: Web is a single-connection node too', () => {
    const node = call({ url: '/a' }, { connectionParams: { region: '${pipeline().parameters.r}' } });
    const [lowered] = lowerNodes([node]);
    expect(lowered!.type).toBe('web');
    expect(lowered!.connectionParams).toEqual({ region: '${pipeline().parameters.r}' });
  });

  it.each([
    ['a method Web does not offer', { url: '/a', method: 'OPTIONS' }],
    ['an expression method', { url: '/a', method: '${pipeline().parameters.m}' }],
    ['a method with spaces', { url: '/a', method: ' get ' }],
    ['no URL', {}],
    ['an empty URL', { url: '' }],
    // HTTP request fails these at every run (any body on GET or HEAD); Web
    // would send '' as no body and succeed.
    ['an empty body on GET', { url: '/a', body: '' }],
    ['a body on HEAD', { url: '/a', method: 'HEAD', body: 'x' }],
    ['an expression body on GET', { url: '/a', method: 'get', body: '${run.runId}' }],
  ])('stays HTTP request with %s', (_label, config) => {
    const node = call(config);
    expect(lowerNodes([node])[0]).toBe(node);
  });

  it.each([
    ['datasets', { datasetIds: { source: 'ds_1' } }],
    ['paired connections', { connectionIds: { source: 'a', sink: 'b' } }],
  ] as [string, Partial<Node>][])('stays HTTP request when it carries %s', (_label, extra) => {
    const node = call({ url: '/a' }, extra);
    expect(lowerNodes([node])[0]).toBe(node);
  });

  it("a reader of its outputs needs no rewrite: status, body and headers keep their names", () => {
    const reader = {
      id: 'check',
      type: 'if',
      config: { condition: '${greaterOrEquals(nodes.call.output.status, 400)}' },
      position: { x: 0, y: 0 },
    } as Node;
    const nodes = lowerNodes([call(), reader]);
    expect(nodes.map((n) => n.type)).toEqual(['web', 'if']);
    expect(nodes[1]).toBe(reader);
  });
});
