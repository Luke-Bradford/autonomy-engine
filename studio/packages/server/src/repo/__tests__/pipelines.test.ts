import { describe, expect, it } from 'vitest';
import {
  createPipeline,
  deletePipeline,
  getPipeline,
  listPipelines,
  updatePipeline,
} from '../pipelines.js';
import { freshDb } from './helpers.js';

const newPipeline = { ownerId: 'local', name: 'My pipeline' };

describe('pipelines repo', () => {
  it('creates and reads back a pipeline', () => {
    const { db } = freshDb();
    const created = createPipeline(db, newPipeline);
    expect(created.id).toMatch(/^pipe_/);
    expect(getPipeline(db, created.id)).toEqual(created);
  });

  it('returns null for a missing id', () => {
    const { db } = freshDb();
    expect(getPipeline(db, 'pipe_missing')).toBeNull();
  });

  it('lists all pipelines', () => {
    const { db } = freshDb();
    const a = createPipeline(db, { ...newPipeline, name: 'A' });
    const b = createPipeline(db, { ...newPipeline, name: 'B' });
    expect(
      listPipelines(db)
        .map((p) => p.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('renames a pipeline via update', () => {
    const { db } = freshDb();
    const created = createPipeline(db, newPipeline);
    const updated = updatePipeline(db, created.id, { name: 'New name' });
    expect(updated!.name).toBe('New name');
    expect(updated!.createdAt).toBe(created.createdAt);
  });

  it('deletes a pipeline', () => {
    const { db } = freshDb();
    const created = createPipeline(db, newPipeline);
    expect(deletePipeline(db, created.id)).toBe(true);
    expect(getPipeline(db, created.id)).toBeNull();
  });
});
