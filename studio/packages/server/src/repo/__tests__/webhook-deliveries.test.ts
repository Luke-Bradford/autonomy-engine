import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewTrigger } from '@autonomy-studio/shared';
import { createPipeline } from '../pipelines.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createTrigger } from '../triggers.js';
import {
  claimWebhookDelivery,
  deleteWebhookDelivery,
  DuplicateWebhookDeliveryError,
  finalizeWebhookDelivery,
  getWebhookDelivery,
} from '../webhook-deliveries.js';
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
