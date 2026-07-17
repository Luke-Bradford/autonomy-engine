import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildApp,
  DEFAULT_WAKEUP_RETENTION_MS,
  DEFAULT_WEBHOOK_RETENTION_MS,
  resolvePort,
  resolveRetentionMs,
} from '../index.js';
import { eq } from 'drizzle-orm';
import { CATALOG_VERSION, type NewTrigger } from '@autonomy-studio/shared';
import { openDb } from '../db/client.js';
import { webhookDeliveries } from '../db/schema.js';
import { armWakeup, getWakeup, settleWakeup } from '../repo/scheduled-wakeups.js';
import { createPipeline } from '../repo/pipelines.js';
import { createPipelineVersion } from '../repo/pipeline-versions.js';
import { createTrigger } from '../repo/triggers.js';
import { claimWebhookDelivery, getWebhookDelivery } from '../repo/webhook-deliveries.js';

// `dbPath`/`masterKeyFile` are passed as call-time options to `buildApp()`
// rather than via `process.env` — `process.env` is process-global and
// shared across concurrently-running test files in the same vitest worker,
// so mutating it would let two test files stomp each other's DB path.
const tmpDir = mkdtempSync(join(tmpdir(), 'autonomy-studio-server-test-'));
const dbPath = join(tmpDir, 'test.sqlite');
const masterKeyFile = join(tmpDir, 'master.key');

describe('resolvePort', () => {
  it('defaults to 8080 when unset or empty', () => {
    expect(resolvePort(undefined)).toBe(8080);
    expect(resolvePort('')).toBe(8080);
  });
  it('parses a valid port', () => {
    expect(resolvePort('9099')).toBe(9099);
  });
  it('throws (never NaN) on a non-numeric or out-of-range value', () => {
    expect(() => resolvePort('abc')).toThrow(/Invalid PORT/);
    expect(() => resolvePort('0')).toThrow(/Invalid PORT/);
    expect(() => resolvePort('70000')).toThrow(/Invalid PORT/);
  });
});

describe('resolveRetentionMs (#464/#421)', () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const wakeup = { envName: 'WAKEUP_RETENTION_DAYS', defaultMs: DEFAULT_WAKEUP_RETENTION_MS };
  it('defaults to the given defaultMs when unset or empty', () => {
    expect(resolveRetentionMs(undefined, wakeup)).toBe(DEFAULT_WAKEUP_RETENTION_MS);
    expect(resolveRetentionMs('', wakeup)).toBe(DEFAULT_WAKEUP_RETENTION_MS);
    expect(DEFAULT_WAKEUP_RETENTION_MS).toBe(30 * MS_PER_DAY);
  });
  it('parses a day count into ms', () => {
    expect(resolveRetentionMs('7', wakeup)).toBe(7 * MS_PER_DAY);
  });
  it('treats 0 as retention DISABLED', () => {
    expect(resolveRetentionMs('0', wakeup)).toBe(0);
  });
  it('throws (never NaN) on a non-integer or negative value', () => {
    expect(() => resolveRetentionMs('abc', wakeup)).toThrow(/Invalid WAKEUP_RETENTION_DAYS/);
    expect(() => resolveRetentionMs('-1', wakeup)).toThrow(/Invalid WAKEUP_RETENTION_DAYS/);
    expect(() => resolveRetentionMs('1.5', wakeup)).toThrow(/Invalid WAKEUP_RETENTION_DAYS/);
  });
  it('#421 — carries the given envName + defaultMs (a webhook typo blames the webhook var)', () => {
    const webhook = { envName: 'WEBHOOK_RETENTION_DAYS', defaultMs: DEFAULT_WEBHOOK_RETENTION_MS };
    expect(resolveRetentionMs(undefined, webhook)).toBe(DEFAULT_WEBHOOK_RETENTION_MS);
    expect(DEFAULT_WEBHOOK_RETENTION_MS).toBe(30 * MS_PER_DAY);
    expect(() => resolveRetentionMs('nope', webhook)).toThrow(/Invalid WEBHOOK_RETENTION_DAYS/);
  });
});

describe('#464 — retention boot sweep', () => {
  /** Seed one OLD and one FRESH settled wakeup, close the handle, then return the
   * two ids so a booted app (reopening the same file) can be checked. */
  function seedBacklog(path: string): { oldId: string; freshId: string } {
    const seed = openDb(path);
    const oldRow = armWakeup(seed.db, {
      kind: 'retry',
      ref: { runId: 'r_old' },
      dueAt: 1,
      discriminator: 'a',
    });
    settleWakeup(seed.db, oldRow.id, { status: 'fired', firedAt: 1 }); // 1970 — far past any floor
    const freshRow = armWakeup(seed.db, {
      kind: 'retry',
      ref: { runId: 'r_fresh' },
      dueAt: 1,
      discriminator: 'b',
    });
    settleWakeup(seed.db, freshRow.id, { status: 'fired', firedAt: Date.now() });
    seed.sqlite.close();
    return { oldId: oldRow.id, freshId: freshRow.id };
  }

  it('prunes a settled backlog older than the floor on boot, keeping fresh rows', async () => {
    const path = join(tmpDir, 'retention-on.sqlite');
    const { oldId, freshId } = seedBacklog(path);

    // 1-day floor: the 1970 row is far past it, the just-now row is inside it.
    // The boot sweep runs synchronously during buildApp, before it resolves.
    const app = await buildApp({
      dbPath: path,
      masterKeyFile: join(tmpDir, 'retention-on.key'),
      wakeupRetentionMs: 24 * 60 * 60 * 1000,
    });
    await app.ready();

    const check = openDb(path);
    expect(getWakeup(check.db, oldId)).toBeNull(); // pruned
    expect(getWakeup(check.db, freshId)?.id).toBe(freshId); // kept
    check.sqlite.close();
    await app.close();
  });

  it('prunes NOTHING when retention is disabled (wakeupRetentionMs: 0)', async () => {
    const path = join(tmpDir, 'retention-off.sqlite');
    const { oldId, freshId } = seedBacklog(path);

    const app = await buildApp({
      dbPath: path,
      masterKeyFile: join(tmpDir, 'retention-off.key'),
      wakeupRetentionMs: 0,
    });
    await app.ready();

    const check = openDb(path);
    expect(getWakeup(check.db, oldId)?.id).toBe(oldId); // still there — sweep off
    expect(getWakeup(check.db, freshId)?.id).toBe(freshId);
    check.sqlite.close();
    await app.close();
  });

  it('rejects a degenerate retentionSweepMs (would make setInterval fire continuously)', async () => {
    await expect(
      buildApp({
        dbPath: join(tmpDir, 'retention-badsweep.sqlite'),
        masterKeyFile: join(tmpDir, 'retention-badsweep.key'),
        wakeupRetentionMs: 1_000,
        retentionSweepMs: 0,
      }),
    ).rejects.toThrow(/retentionSweepMs/);
  });

  it('rejects a negative wakeupRetentionMs', async () => {
    await expect(
      buildApp({
        dbPath: join(tmpDir, 'retention-badms.sqlite'),
        masterKeyFile: join(tmpDir, 'retention-badms.key'),
        wakeupRetentionMs: -1,
      }),
    ).rejects.toThrow(/wakeupRetentionMs/);
  });

  it('the RECURRING interval sweep prunes a row that ages past the floor after boot', async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now(); // frozen by the fake clock until we advance it
      const path = join(tmpDir, 'retention-interval.sqlite');

      // A row settled just before boot: with a 1s floor it is NOT yet prunable at
      // boot, so the BOOT sweep must keep it — isolating the INTERVAL as the thing
      // under test.
      const seed = openDb(path);
      const row = armWakeup(seed.db, {
        kind: 'node_retry',
        ref: { runId: 'r' },
        dueAt: 1,
        discriminator: 'a',
      });
      settleWakeup(seed.db, row.id, { status: 'fired', firedAt: t0 - 100 });
      seed.sqlite.close();

      const app = await buildApp({
        dbPath: path,
        masterKeyFile: join(tmpDir, 'retention-interval.key'),
        wakeupRetentionMs: 1_000, // 1s floor
        retentionSweepMs: 500, // sweep twice a second
      });
      await app.ready();

      // Boot sweep ran at t0: firedAt = t0-100 is inside the 1s floor → kept.
      let check = openDb(path);
      expect(getWakeup(check.db, row.id)?.id).toBe(row.id);
      check.sqlite.close();

      // Advance 2s: the fake clock (and Date.now) moves forward, the row crosses
      // the 1s floor, and the 500ms interval sweeps fire and prune it.
      await vi.advanceTimersByTimeAsync(2_000);

      check = openDb(path);
      expect(getWakeup(check.db, row.id)).toBeNull(); // pruned by the interval, not boot
      check.sqlite.close();
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#421 — webhook-deliveries retention boot sweep', () => {
  /** Seed a trigger + one OLD and one FRESH webhook delivery (backdating the old
   * one's `receivedAt` past the floor), close the handle, and return the ids so a
   * booted app reopening the same file can be checked. */
  function seedWebhookBacklog(path: string): {
    triggerId: string;
    oldKey: string;
    freshKey: string;
  } {
    const seed = openDb(path);
    const pipeline = createPipeline(seed.db, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(seed.db, {
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
    const triggerId = createTrigger(seed.db, input).id;
    const old = claimWebhookDelivery(seed.db, { triggerId, idempotencyKey: 'old' });
    seed.db
      .update(webhookDeliveries)
      .set({ receivedAt: 1 }) // 1970 — far past any floor
      .where(eq(webhookDeliveries.id, old.id))
      .run();
    claimWebhookDelivery(seed.db, { triggerId, idempotencyKey: 'fresh' }); // stamped now
    seed.sqlite.close();
    return { triggerId, oldKey: 'old', freshKey: 'fresh' };
  }

  it('prunes an aged delivery on boot, keeping fresh rows', async () => {
    const path = join(tmpDir, 'webhook-retention-on.sqlite');
    const { triggerId, oldKey, freshKey } = seedWebhookBacklog(path);

    const app = await buildApp({
      dbPath: path,
      masterKeyFile: join(tmpDir, 'webhook-retention-on.key'),
      webhookRetentionMs: 24 * 60 * 60 * 1000, // 1-day floor
      wakeupRetentionMs: 0, // isolate the webhook sweep
    });
    await app.ready();

    const check = openDb(path);
    expect(getWebhookDelivery(check.db, triggerId, oldKey)).toBeNull(); // pruned
    expect(getWebhookDelivery(check.db, triggerId, freshKey)?.idempotencyKey).toBe(freshKey); // kept
    check.sqlite.close();
    await app.close();
  });

  it('prunes NOTHING when webhook retention is disabled (webhookRetentionMs: 0)', async () => {
    const path = join(tmpDir, 'webhook-retention-off.sqlite');
    const { triggerId, oldKey } = seedWebhookBacklog(path);

    const app = await buildApp({
      dbPath: path,
      masterKeyFile: join(tmpDir, 'webhook-retention-off.key'),
      webhookRetentionMs: 0,
      wakeupRetentionMs: 0,
    });
    await app.ready();

    const check = openDb(path);
    expect(getWebhookDelivery(check.db, triggerId, oldKey)?.idempotencyKey).toBe(oldKey); // sweep off
    check.sqlite.close();
    await app.close();
  });

  // A bad webhook window must reject BEFORE the (enabled) wakeup sweep's interval
  // is armed — the boot error path runs before `onClose` is wired, so an interval
  // armed then abandoned would keep firing against the open db. Enabling wakeup
  // retention here (rather than disabling it) exercises that ordering.
  it('rejects a negative webhookRetentionMs even with the wakeup sweep enabled', async () => {
    await expect(
      buildApp({
        dbPath: join(tmpDir, 'webhook-retention-badms.sqlite'),
        masterKeyFile: join(tmpDir, 'webhook-retention-badms.key'),
        webhookRetentionMs: -1,
        wakeupRetentionMs: 1_000,
      }),
    ).rejects.toThrow(/webhookRetentionMs/);
  });
});

describe('server app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ dbPath, masterKeyFile });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /api/hello returns a schema-valid Hello', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hello' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.message).toBe('string');
    expect(typeof body.ts).toBe('number');
  });
});
