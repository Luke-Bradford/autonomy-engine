import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildApp,
  DEFAULT_WAKEUP_RETENTION_MS,
  resolvePort,
  resolveRetentionMs,
} from '../index.js';
import { openDb } from '../db/client.js';
import { armWakeup, getWakeup, settleWakeup } from '../repo/scheduled-wakeups.js';

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

describe('resolveRetentionMs (#464)', () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  it('defaults to 30 days when unset or empty', () => {
    expect(resolveRetentionMs(undefined)).toBe(DEFAULT_WAKEUP_RETENTION_MS);
    expect(resolveRetentionMs('')).toBe(DEFAULT_WAKEUP_RETENTION_MS);
    expect(DEFAULT_WAKEUP_RETENTION_MS).toBe(30 * MS_PER_DAY);
  });
  it('parses a day count into ms', () => {
    expect(resolveRetentionMs('7')).toBe(7 * MS_PER_DAY);
  });
  it('treats 0 as retention DISABLED', () => {
    expect(resolveRetentionMs('0')).toBe(0);
  });
  it('throws (never NaN) on a non-integer or negative value', () => {
    expect(() => resolveRetentionMs('abc')).toThrow(/Invalid WAKEUP_RETENTION_DAYS/);
    expect(() => resolveRetentionMs('-1')).toThrow(/Invalid WAKEUP_RETENTION_DAYS/);
    expect(() => resolveRetentionMs('1.5')).toThrow(/Invalid WAKEUP_RETENTION_DAYS/);
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
