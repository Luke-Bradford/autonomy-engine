import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CATALOG_VERSION, type NewTrigger } from '@autonomy-studio/shared';
import { webhookDeliveries } from '../../db/schema.js';
import { createPipeline } from '../pipelines.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createTrigger } from '../triggers.js';
import {
  claimWebhookDelivery,
  deleteWebhookDelivery,
  drainWebhookDeliveries,
  DuplicateWebhookDeliveryError,
  finalizeWebhookDelivery,
  getWebhookDelivery,
  pruneWebhookDeliveries,
} from '../webhook-deliveries.js';
import type { Db } from '../types.js';
import { freshDb } from './helpers.js';

function seedTrigger(db: ReturnType<typeof freshDb>['db']): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const version = createPipelineVersion(db, {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  });
  const input: NewTrigger = {
    ownerId: 'local',
    name: 'Hook',
    pipelineVersionId: version.id,
    params: {},
    mode: 'webhook',
    schedule: null,
    webhook: null,
    concurrency: { policy: 'parallel', max: 5 },
    runWindows: null,
    enabled: true,
  };
  return createTrigger(db, input).id;
}

describe('webhook-deliveries repo', () => {
  it('claims a fresh delivery as pending', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    const claimed = claimWebhookDelivery(db, { triggerId, idempotencyKey: 'k1' });
    expect(claimed.outcome).toBe('pending');
    expect(claimed.runId).toBeNull();
    expect(getWebhookDelivery(db, triggerId, 'k1')?.id).toBe(claimed.id);
  });

  it('rejects a second claim of the same (triggerId, key) as a duplicate', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    claimWebhookDelivery(db, { triggerId, idempotencyKey: 'k1' });
    expect(() => claimWebhookDelivery(db, { triggerId, idempotencyKey: 'k1' })).toThrow(
      DuplicateWebhookDeliveryError,
    );
  });

  it('the same key on a DIFFERENT trigger is not a duplicate', () => {
    const { db } = freshDb();
    const a = seedTrigger(db);
    const b = seedTrigger(db);
    expect(() => {
      claimWebhookDelivery(db, { triggerId: a, idempotencyKey: 'shared' });
      claimWebhookDelivery(db, { triggerId: b, idempotencyKey: 'shared' });
    }).not.toThrow();
  });

  it('finalize writes the outcome + runId back', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    const claimed = claimWebhookDelivery(db, { triggerId, idempotencyKey: 'k1' });
    finalizeWebhookDelivery(db, claimed.id, { outcome: 'started', runId: 'run_abc' });
    const stored = getWebhookDelivery(db, triggerId, 'k1');
    expect(stored?.outcome).toBe('started');
    expect(stored?.runId).toBe('run_abc');
  });

  it('delete releases a claim so the same key can be re-claimed', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    const claimed = claimWebhookDelivery(db, { triggerId, idempotencyKey: 'k1' });
    deleteWebhookDelivery(db, claimed.id);
    expect(getWebhookDelivery(db, triggerId, 'k1')).toBeNull();
    expect(() => claimWebhookDelivery(db, { triggerId, idempotencyKey: 'k1' })).not.toThrow();
  });
});

/**
 * #421 — age-based retention. `receivedAt` is stamped by `claimWebhookDelivery`
 * at `Date.now()`, so to test an explicit floor we claim then BACKDATE the row's
 * `receivedAt` directly (the same "explicit stored timestamp" shape the wakeup
 * retention test uses via `settleWakeup`'s `firedAt`).
 */
describe('#421 — webhook-deliveries retention', () => {
  function seedAt(db: Db, triggerId: string, key: string, receivedAt: number): string {
    const claimed = claimWebhookDelivery(db, { triggerId, idempotencyKey: key });
    db.update(webhookDeliveries)
      .set({ receivedAt })
      .where(eq(webhookDeliveries.id, claimed.id))
      .run();
    return claimed.id;
  }

  it('deletes rows strictly OLDER than `before`, keeping the boundary row (exclusive)', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    const oldId = seedAt(db, triggerId, 'old', 1_000);
    const boundaryId = seedAt(db, triggerId, 'boundary', 5_000); // exactly at `before`
    const freshId = seedAt(db, triggerId, 'fresh', 9_000);

    const deleted = pruneWebhookDeliveries(db, { before: 5_000 });
    expect(deleted).toBe(1);
    expect(
      db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, oldId)).get(),
    ).toBeUndefined();
    expect(
      db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, boundaryId)).get()?.id,
    ).toBe(boundaryId);
    expect(
      db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, freshId)).get()?.id,
    ).toBe(freshId);
  });

  it('prunes oldest-first, bounded by `limit`', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    const a = seedAt(db, triggerId, 'a', 1_000);
    const b = seedAt(db, triggerId, 'b', 2_000);
    const c = seedAt(db, triggerId, 'c', 3_000);

    const deleted = pruneWebhookDeliveries(db, { before: 10_000, limit: 2 });
    expect(deleted).toBe(2);
    // The two OLDEST (a, b) went; c (newest) survives this bounded call.
    expect(
      db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, a)).get(),
    ).toBeUndefined();
    expect(
      db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, b)).get(),
    ).toBeUndefined();
    expect(db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, c)).get()?.id).toBe(
      c,
    );
  });

  it('returns 0 when nothing is eligible', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    seedAt(db, triggerId, 'k', 9_000);
    expect(pruneWebhookDeliveries(db, { before: 5_000 })).toBe(0);
  });

  // SAFETY: pruning is by AGE across ALL outcomes. A crash-orphaned `pending` row
  // (a claim whose fire never finalized) that has aged past the floor IS pruned,
  // freeing its key; a FRESH in-flight claim (inside the floor) is NOT — so no
  // live delivery loses its at-most-once guard.
  it('prunes an aged pending (unfinalized) row but keeps a fresh in-flight one', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    const orphaned = seedAt(db, triggerId, 'orphan', 1_000); // pending, old
    const inflight = seedAt(db, triggerId, 'inflight', 9_000); // pending, fresh

    const deleted = pruneWebhookDeliveries(db, { before: 5_000 });
    expect(deleted).toBe(1);
    expect(
      db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, orphaned)).get(),
    ).toBeUndefined();
    expect(
      db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, inflight)).get()?.id,
    ).toBe(inflight);
  });

  it('drainWebhookDeliveries drains a whole backlog to a fixpoint in bounded batches', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    for (let i = 0; i < 5; i++) seedAt(db, triggerId, `k${i}`, 1_000 + i);
    const total = drainWebhookDeliveries(db, { before: 10_000, batch: 2 });
    expect(total).toBe(5);
    expect(drainWebhookDeliveries(db, { before: 10_000, batch: 2 })).toBe(0); // fixpoint
  });

  it('drainWebhookDeliveries respects the cutoff — leaves rows newer than `before`', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    seedAt(db, triggerId, 'old', 1_000);
    seedAt(db, triggerId, 'new', 9_000);
    expect(drainWebhookDeliveries(db, { before: 5_000, batch: 10 })).toBe(1);
  });

  it('drainWebhookDeliveries caps a single invocation at maxBatches, resuming next call', () => {
    const { db } = freshDb();
    const triggerId = seedTrigger(db);
    for (let i = 0; i < 5; i++) seedAt(db, triggerId, `k${i}`, 1_000 + i);
    // batch 2 × maxBatches 2 = at most 4 this call, the 5th drains next.
    expect(drainWebhookDeliveries(db, { before: 10_000, batch: 2, maxBatches: 2 })).toBe(4);
    expect(drainWebhookDeliveries(db, { before: 10_000, batch: 2 })).toBe(1);
  });
});
