import { describe, expect, it } from 'vitest';
import { acquireCopyWatermark, copyWatermarkKey } from '../copy-watermark.js';
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
