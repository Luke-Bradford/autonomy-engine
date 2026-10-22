import { describe, expect, it } from 'vitest';
import { getCopyWatermark, putCopyWatermark } from '../copy-watermarks.js';
import { createPipeline, deletePipeline } from '../pipelines.js';
import { freshDb } from './helpers.js';

/**
 * #1600 OR41 C5a — the store behind a Copy's Watermark from Automatic: one value
 * per pipeline, activity and source, kept apart from the run log so deleting a
 * run, pruning debug runs or a secure output's redaction cannot lose it.
 */
describe('copy watermarks repo', () => {
  const key = (pipelineId: string, copyKey = 'src-a') => ({
    pipelineId,
    nodeId: 'copy1',
    copyKey,
  });

  it('reads nothing before a copy committed, then the value it stored', () => {
    const { db } = freshDb();
    const p = createPipeline(db, { ownerId: 'local', name: 'p' });
    expect(getCopyWatermark(db, key(p.id))).toEqual({ found: false });
    putCopyWatermark(db, {
      ...key(p.id),
      column: 'm',
      value: '2026-10-22 10:00:00+00',
      runId: 'run_1',
    });
    expect(getCopyWatermark(db, key(p.id))).toEqual({
      found: true,
      value: '2026-10-22 10:00:00+00',
    });
  });

  it('replaces the value on the next commit and keeps numbers as numbers', () => {
    const { db } = freshDb();
    const p = createPipeline(db, { ownerId: 'local', name: 'p' });
    putCopyWatermark(db, { ...key(p.id), column: 'id', value: 5, runId: 'run_1' });
    putCopyWatermark(db, { ...key(p.id), column: 'id', value: 9, runId: 'run_2' });
    expect(getCopyWatermark(db, key(p.id))).toEqual({ found: true, value: 9 });
  });

  it('keeps one value per source, activity and pipeline', () => {
    const { db } = freshDb();
    const p = createPipeline(db, { ownerId: 'local', name: 'p' });
    const q = createPipeline(db, { ownerId: 'local', name: 'q' });
    putCopyWatermark(db, { ...key(p.id), column: 'id', value: 5, runId: 'run_1' });
    expect(getCopyWatermark(db, key(p.id, 'src-b'))).toEqual({ found: false });
    expect(getCopyWatermark(db, key(q.id))).toEqual({ found: false });
    expect(getCopyWatermark(db, { ...key(p.id), nodeId: 'copy2' })).toEqual({ found: false });
  });

  it('goes with its pipeline', () => {
    const { db, sqlite } = freshDb();
    const p = createPipeline(db, { ownerId: 'local', name: 'p' });
    putCopyWatermark(db, { ...key(p.id), column: 'id', value: 5, runId: 'run_1' });
    expect(deletePipeline(db, p.id)).toBe(true);
    expect(sqlite.prepare('SELECT count(*) AS n FROM copy_watermarks').get()).toEqual({ n: 0 });
  });
});
