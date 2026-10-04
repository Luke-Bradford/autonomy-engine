import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { CATALOG_VERSION, RUNS_EXPORT_TRUNCATED_HEADER } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, createRun } from '../../repo/index.js';
import { runs } from '../../db/schema.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

// A cap of 3, so truncation is reachable without seeding ten thousand runs.
vi.mock('../../limits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../limits.js')>()),
  RUNS_EXPORT_MAX_ROWS: 3,
}));

/**
 * #1534 — a hold on the walk, so a test can keep one export in flight while it
 * asks for another. Disarmed, the real walk runs untouched.
 */
const walk = vi.hoisted(() => ({
  hold: null as null | { entered: () => void; release: Promise<void> },
  /** Unparks the held export; `afterEach` calls it so `close()` never waits on one. */
  open: null as null | (() => void),
  fail: false,
}));
vi.mock('../../run/runs-export.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../run/runs-export.js')>();
  return {
    ...real,
    collectRunsForExport: async (...args: Parameters<typeof real.collectRunsForExport>) => {
      const hold = walk.hold;
      walk.hold = null;
      if (hold) {
        hold.entered();
        await hold.release;
      }
      if (walk.fail) {
        walk.fail = false;
        throw new Error('the walk failed');
      }
      return real.collectRunsForExport(...args);
    },
  };
});

/** Arm the hold for the next export; resolves once that export is in the walk. */
function holdNextWalk(): { entered: Promise<void>; release: () => void } {
  let entered!: () => void;
  let release!: () => void;
  const enteredP = new Promise<void>((r) => (entered = r));
  const releaseP = new Promise<void>((r) => (release = r));
  walk.hold = { entered, release: releaseP };
  walk.open = release;
  return { entered: enteredP, release };
}

/** The body's records as header-keyed objects. The fixtures hold no commas or
 * quotes, so a plain split is a faithful reader of them. */
function records(body: string): Record<string, string>[] {
  expect(body.startsWith('﻿')).toBe(true);
  const [header, ...lines] = body.slice(1).split('\r\n');
  expect(lines.pop()).toBe(''); // every record ends CRLF
  const keys = header!.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v])));
}

describe('GET /api/runs/export.csv (#1484 OR35 M1)', () => {
  let app: FastifyInstance;
  let versionId: string;

  beforeEach(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: '=Orders' });
    versionId = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    }).id;
  });

  afterEach(async () => {
    // A failed assertion must not leave an export parked, or close() waits on it.
    walk.open?.();
    walk.open = null;
    walk.hold = null;
    walk.fail = false;
    await app.close();
  });

  function seed(
    startedAt: number,
    opts: { ownerId?: string; status?: 'success' | 'failure' } = {},
  ) {
    const run = createRun(app.db, {
      ownerId: opts.ownerId ?? 'local',
      pipelineVersionId: versionId,
      triggerId: null,
      parentRunId: null,
      params: { password: 'hunter2' },
    });
    app.db
      .update(runs)
      .set({
        startedAt,
        ...(opts.status ? { status: opts.status, finishedAt: startedAt + 1500 } : {}),
      })
      .where(eq(runs.id, run.id))
      .run();
    return run.id;
  }

  it("is the caller's runs as CSV, newest first, with machine values and no params", async () => {
    const older = seed(Date.UTC(2026, 9, 3), { status: 'success' });
    const newer = seed(Date.UTC(2026, 9, 4), { status: 'failure' });
    seed(Date.UTC(2026, 9, 5), { ownerId: 'someone-else' });

    const res = await app.inject({ method: 'GET', url: '/api/runs/export.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers[RUNS_EXPORT_TRUNCATED_HEADER]).toBeUndefined();
    const rows = records(res.body);
    expect(rows.map((r) => r.run_id)).toEqual([newer, older]);
    expect(rows[0]).toMatchObject({
      pipeline: "'=Orders", // formula-guarded
      status: 'failure',
      started_at: '2026-10-04T00:00:00.000Z',
      duration_ms: '1500',
      triggered_by: 'editor', // no trigger, not a debug version
    });
    expect(res.body).not.toContain('hunter2');
  });

  it('honours the same filters and sort as the list', async () => {
    const a = seed(1_000, { status: 'success' });
    seed(2_000, { status: 'failure' });
    const c = seed(3_000, { status: 'success' });

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/runs/export.csv?status=success&sort=started&dir=asc',
    });
    expect(records(filtered.body).map((r) => r.run_id)).toEqual([a, c]);

    const list = await app.inject({
      method: 'GET',
      url: '/api/runs?status=success&sort=started&dir=asc',
    });
    expect(list.json().items.map((r: { id: string }) => r.id)).toEqual([a, c]);
  });

  it('stops at the cap and says so, only when more runs match', async () => {
    for (let i = 0; i < 4; i++) seed(1_000 + i);
    const cut = await app.inject({ method: 'GET', url: '/api/runs/export.csv' });
    expect(records(cut.body)).toHaveLength(3);
    expect(cut.headers[RUNS_EXPORT_TRUNCATED_HEADER]).toBe('3');
  });

  it('is exactly the cap without the header when exactly the cap match', async () => {
    for (let i = 0; i < 3; i++) seed(1_000 + i);
    const res = await app.inject({ method: 'GET', url: '/api/runs/export.csv' });
    expect(records(res.body)).toHaveLength(3);
    expect(res.headers[RUNS_EXPORT_TRUNCATED_HEADER]).toBeUndefined();
  });

  it('exports only the filtered set: includeChildren does not add descendants', async () => {
    const parent = seed(2_000);
    const child = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId: versionId,
      triggerId: null,
      parentRunId: parent,
      params: {},
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/export.csv?q=${parent}&includeChildren=true`,
    });
    // The search matches the parent alone; the run it called is not pulled in.
    expect(records(res.body).map((r) => r.run_id)).toEqual([parent]);
    expect(res.body).not.toContain(child.id);
  });

  it('refuses a junk filter with a 400, as the list does', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/export.csv?status=nope' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a second export while the first is running, then serves the next (#1534)', async () => {
    seed(1_000);
    const held = holdNextWalk();
    const first = app.inject({ method: 'GET', url: '/api/runs/export.csv' });
    await held.entered;

    const second = await app.inject({ method: 'GET', url: '/api/runs/export.csv' });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({
      error: 'busy',
      message: 'A CSV export of your runs is already running. Try again when it finishes.',
    });
    // A refused filter is still the caller's 400, not a busy.
    const junk = await app.inject({ method: 'GET', url: '/api/runs/export.csv?status=nope' });
    expect(junk.statusCode).toBe(400);

    held.release();
    expect((await first).statusCode).toBe(200);
    const third = await app.inject({ method: 'GET', url: '/api/runs/export.csv' });
    expect(third.statusCode).toBe(200);
    expect(records(third.body)).toHaveLength(1);
  });

  it('frees the slot when an export fails part-way (#1534)', async () => {
    walk.fail = true;
    const failed = await app.inject({ method: 'GET', url: '/api/runs/export.csv' });
    expect(failed.statusCode).toBe(500);
    const next = await app.inject({ method: 'GET', url: '/api/runs/export.csv' });
    expect(next.statusCode).toBe(200);
  });
});
