import { describe, expect, it } from 'vitest';
import type { Node } from '../../schemas/pipeline.js';
import { copyFilesConfigSchema } from '../copy-files-config.js';
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

describe('#1600 C1b — splitDestination', () => {
  it.each([
    ['out/a.csv', { folder: 'out', name: 'a.csv' }],
    ['/data/out/a.csv', { folder: '/data/out', name: 'a.csv' }],
    ['/a.csv', { folder: '/', name: 'a.csv' }],
    ['a.csv', { folder: undefined, name: 'a.csv' }],
    ['${dir}/a.csv', { folder: '${dir}', name: 'a.csv' }],
    ['out/${name}', { folder: 'out', name: '${name}' }],
    ["out/${concat('x/', name)}", { folder: 'out', name: "${concat('x/', name)}" }],
    ['out/$${x}/a.csv', { folder: 'out/$${x}', name: 'a.csv' }],
  ])('%s', (dest, expected) => {
    expect(splitDestination(dest)).toEqual(expected);
  });

  it('refuses a wholly-expression destination, which may resolve absolute', () => {
    expect(splitDestination('${pipeline.parameters.dest}')).toBeUndefined();
    expect(splitDestination('${a}${b}')).toBeUndefined();
    expect(splitDestination('out/${unterminated')).toBeUndefined();
  });
});

describe('#1600 C1b — lowerRetiredTypes', () => {
  it('file_copy becomes Copy · Files as-is, one file, After copy Keep', () => {
    const node = fileNode(
      'file_copy',
      { source: 'in/a.csv', dest: '/data/out/a.csv', outputs: [] },
      { description: 'd', policy: { retry: 2 }, userProperties: [{ name: 'k', value: 'v' }] },
    );
    const [lowered] = lowerRetiredTypes([node]);
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
    const config = { ...lowered!.config };
    delete config['outputs'];
    expect(copyFilesConfigSchema.safeParse(config).success).toBe(true);
  });

  it('file_move becomes the same with After copy Delete source', () => {
    const [lowered] = lowerRetiredTypes([fileNode('file_move', { source: 'a', dest: 'b' })]);
    expect(lowered!.type).toBe('copy_files');
    expect(lowered!.config).toMatchObject({ afterCopy: 'delete', sinkFileName: 'b' });
    expect(lowered!.config).not.toHaveProperty('sinkFolder');
  });

  it('keeps an inactive node inactive, and an unbound one unbound', () => {
    const [lowered] = lowerRetiredTypes([
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
    expect(lowerRetiredTypes([node])[0]).toBe(node);
  });

  it('returns every other node by reference', () => {
    const copy = fileNode('copy_files', { pathType: 'file', sourcePath: 'a' });
    const set = fileNode('set_variable', {});
    const nodes = [copy, set];
    const out = lowerRetiredTypes(nodes);
    expect(out[0]).toBe(copy);
    expect(out[1]).toBe(set);
  });

  it('does not read an inherited key as a retired type', () => {
    const node = fileNode('constructor', {});
    expect(lowerRetiredTypes([node])[0]).toBe(node);
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
