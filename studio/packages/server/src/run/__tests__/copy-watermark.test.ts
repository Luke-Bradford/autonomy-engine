import { describe, expect, it } from 'vitest';
import {
  acquireCopyWatermark,
  copyFilesWatermarkKey,
  copyWatermarkKey,
} from '../copy-watermark.js';
import { createPipeline } from '../../repo/pipelines.js';
import { freshDb } from '../../repo/__tests__/helpers.js';

/** #1600 OR41 C5a — which stored watermark a copy reads, and the lease on it. */
describe('copyWatermarkKey', () => {
  const dataset = (config: Record<string, unknown>, kind: 'query' | 'table' = 'query') => ({
    id: 'ds',
    name: 'orders',
    kind,
    config,
    columns: [],
  });
  const base = {
    source: { connectionId: 'conn_a', dataset: dataset({ sql: 'SELECT 1', parameters: { n: 1 } }) },
    sink: { connectionId: 'conn_s', dataset: dataset({ table: 'stage' }, 'table') },
    column: 'm',
  };
  const key = copyWatermarkKey(base);

  it('changes with the source connection, its config, a bind value, the column or the sink', () => {
    const source = (connectionId: string, config: Record<string, unknown>) => ({
      ...base,
      source: { connectionId, dataset: dataset(config) },
    });
    expect(copyWatermarkKey(source('conn_b', { sql: 'SELECT 1', parameters: { n: 1 } }))).not.toBe(
      key,
    );
    expect(copyWatermarkKey(source('conn_a', { sql: 'SELECT 2', parameters: { n: 1 } }))).not.toBe(
      key,
    );
    expect(copyWatermarkKey(source('conn_a', { sql: 'SELECT 1', parameters: { n: 2 } }))).not.toBe(
      key,
    );
    expect(copyWatermarkKey({ ...base, column: 'other' })).not.toBe(key);
    expect(
      copyWatermarkKey({
        ...base,
        sink: { connectionId: 'conn_s', dataset: dataset({ table: 'other' }, 'table') },
      }),
    ).not.toBe(key);
    expect(copyWatermarkKey({ ...base, sink: { ...base.sink, connectionId: 'conn_t' } })).not.toBe(
      key,
    );
  });

  it('ignores the query timeout, the dataset name and the key order', () => {
    expect(
      copyWatermarkKey({
        ...base,
        source: {
          connectionId: 'conn_a',
          dataset: {
            ...dataset({ parameters: { n: 1 }, sql: 'SELECT 1', queryTimeoutSeconds: 60 }),
            name: 'renamed',
          },
        },
      }),
    ).toBe(key);
  });
});

/**
 * #1600 OR41 C5b — a Files as-is copy's key: the source connection and what it
 * selects, and the sink connection and where it writes, read from the parsed
 * config so a default written out keys as one left absent.
 */
describe('copyFilesWatermarkKey', () => {
  const base = { sourceConnectionId: 'conn_a', sinkConnectionId: 'conn_s' };
  const key = (input: Record<string, unknown>, over: Partial<typeof base> = {}) =>
    copyFilesWatermarkKey({ ...base, ...over, input: { sourcePath: 'in', load: 'incremental', ...input } });
  const k = key({});

  it('changes with what is selected, where it is written and either connection', () => {
    for (const changed of [
      key({ sourcePath: 'other' }),
      key({ wildcard: '*.csv' }),
      key({ recursive: false }),
      key({ pathType: 'list', fileListPath: 'l.txt' }),
      key({ sinkFolder: 'out' }),
      key({ copyBehavior: 'flatten' }),
      key({}, { sourceConnectionId: 'conn_b' }),
      key({}, { sinkConnectionId: 'conn_t' }),
    ]) {
      expect(changed).not.toBe(k);
    }
  });

  it('keeps one key across how the copy runs, and across a default written out', () => {
    for (const same of [
      key({ recursive: true, wildcard: '*' }),
      key({ ifExists: 'skip' }),
      key({ afterCopy: 'move', moveTo: 'done' }),
      key({ parallelCopies: 4, logLevel: 'info' }),
    ]) {
      expect(same).toBe(k);
    }
  });

  it('is null for a config that does not parse, which the copy refuses itself', () => {
    expect(copyFilesWatermarkKey({ ...base, input: { load: 'incremental' } })).toBeNull();
  });
});

describe('acquireCopyWatermark', () => {
  it('holds a key until released, and releases once', () => {
    const { db } = freshDb();
    const p = createPipeline(db, { ownerId: 'local', name: 'p' });
    const key = { pipelineId: p.id, nodeId: 'c', copyKey: 's', column: 'm', runId: 'run_1' };
    const lease = acquireCopyWatermark(db, key);
    expect(lease).toMatchObject({ old: null });
    expect(acquireCopyWatermark(db, key)).toBe('busy');
    expect(acquireCopyWatermark(db, { ...key, copyKey: 't' })).not.toBe('busy');
    if (lease === 'busy') throw new Error('unreachable');
    lease.commit(7);
    lease.release();
    lease.release();
    const next = acquireCopyWatermark(db, key);
    expect(next).toMatchObject({ old: 7 });
  });
});
