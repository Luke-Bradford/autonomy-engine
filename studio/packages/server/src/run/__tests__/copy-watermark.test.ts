import { describe, expect, it } from 'vitest';
import { acquireCopyWatermark, copyWatermarkSourceKey } from '../copy-watermark.js';
import { createPipeline } from '../../repo/pipelines.js';
import { freshDb } from '../../repo/__tests__/helpers.js';

/** #1600 OR41 C5a — which stored watermark a copy reads, and the lease on it. */
describe('copyWatermarkSourceKey', () => {
  const dataset = (config: Record<string, unknown>) => ({
    id: 'ds',
    name: 'orders',
    kind: 'query' as const,
    config,
    columns: [],
  });
  const base = { connectionId: 'conn_a', dataset: dataset({ sql: 'SELECT 1', parameters: { n: 1 } }), column: 'm' };
  const key = copyWatermarkSourceKey(base);

  it('changes with the connection, the config, a bind value or the column', () => {
    expect(copyWatermarkSourceKey({ ...base, connectionId: 'conn_b' })).not.toBe(key);
    expect(copyWatermarkSourceKey({ ...base, dataset: dataset({ sql: 'SELECT 2', parameters: { n: 1 } }) })).not.toBe(key);
    expect(copyWatermarkSourceKey({ ...base, dataset: dataset({ sql: 'SELECT 1', parameters: { n: 2 } }) })).not.toBe(key);
    expect(copyWatermarkSourceKey({ ...base, column: 'other' })).not.toBe(key);
  });

  it('ignores the query timeout, the dataset name and the key order', () => {
    expect(
      copyWatermarkSourceKey({
        ...base,
        dataset: { ...dataset({ parameters: { n: 1 }, sql: 'SELECT 1', queryTimeoutSeconds: 60 }), name: 'renamed' },
      }),
    ).toBe(key);
  });
});

describe('acquireCopyWatermark', () => {
  it('holds a key until released, and releases once', () => {
    const { db } = freshDb();
    const p = createPipeline(db, { ownerId: 'local', name: 'p' });
    const key = { pipelineId: p.id, nodeId: 'c', sourceKey: 's', column: 'm', runId: 'run_1' };
    const lease = acquireCopyWatermark(db, key);
    expect(lease).toMatchObject({ old: null });
    expect(acquireCopyWatermark(db, key)).toBe('busy');
    expect(acquireCopyWatermark(db, { ...key, sourceKey: 't' })).not.toBe('busy');
    if (lease === 'busy') throw new Error('unreachable');
    lease.commit(7);
    lease.release();
    lease.release();
    const next = acquireCopyWatermark(db, key);
    expect(next).toMatchObject({ old: 7 });
  });
});
