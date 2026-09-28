import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, listRuns } from '../repo/index.js';
import { pendingTicks } from '../scheduler/__tests__/pending-ticks.js';
import { buildTestAppWithContext } from './build-test-app.js';

/**
 * #1388 — a schedule trigger fires a run with NO human action, on the BOOTED
 * app's own clock.
 *
 * `scheduler/__tests__/schedule-tick.test.ts` already proves the fire chain
 * (handler → real launcher → run → re-arm), but over a hand-built alarm clock
 * it ticks itself. What only this file proves is the WIRING in `buildApp`:
 * `POST /api/triggers` → `scheduler.sync()` seeds a durable `schedule_tick` →
 * the `setInterval(alarmClock.tick, ALARM_TICK_MS)` fires it when it falls due.
 * Break that interval and the product silently has no schedules — every unit
 * test above it stays green.
 *
 * The fake clock is set BEFORE boot because `sync()` computes the next
 * occurrence off `Date.now()` at POST time. The trigger is created AFTER boot, so
 * the boot tick cannot fire it; the "no run yet" assertions pin that neither the
 * POST nor anything short of the due minute does either. `until` from
 * `poll-until.ts` is NOT usable here — it polls on a real `setTimeout` and would
 * not see fake time move.
 */
describe('#1388 — a schedule trigger fires on the booted app, unattended', () => {
  const T0 = Date.parse('2026-07-15T12:00:10.000Z');
  let app: FastifyInstance | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      vi.useRealTimers();
      if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
      app = undefined;
      tmpDir = undefined;
    }
  });

  async function bootWithTrigger(enabled: boolean): Promise<{ app: FastifyInstance; id: string }> {
    // Fake ONLY the interval + the clock. Faking everything hangs the boot (measured:
    // the suite times out before the first assertion); the alarm clock is a
    // setInterval and the schedule reads Date.now, which is all this needs to own.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    ({ app, tmpDir } = await buildTestAppWithContext());
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Every minute' });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [], // an empty pipeline drives straight to success
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: {
        name: 'Every minute',
        pipelineVersionId: version.id,
        params: {},
        mode: 'schedule',
        schedule: '* * * * *',
        webhook: null,
        concurrency: { policy: 'parallel', max: 5 },
        runWindows: null,
        enabled,
      },
    });
    expect(res.statusCode).toBe(201);
    return { app, id: res.json().id as string };
  }

  it('fires exactly one run at the next minute, which succeeds, and re-arms the minute after', async () => {
    const { app, id } = await bootWithTrigger(true);

    // Armed for 12:01, and nothing has fired yet — the boot tick saw nothing due.
    expect(pendingTicks(app.db, id).map((w) => w.dueAt)).toEqual([
      Date.parse('2026-07-15T12:01:00.000Z'),
    ]);
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);

    // Just short of the minute: still nothing (the run is the schedule's, not the boot's).
    await vi.advanceTimersByTimeAsync(49_000);
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);

    // Past 12:01 plus one tick interval — nobody calls tick(); the app's own timer does.
    await vi.advanceTimersByTimeAsync(2_000);
    await app.runLauncher.whenIdle();

    const runs = listRuns(app.db, { triggerId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('success');
    expect(pendingTicks(app.db, id).map((w) => w.dueAt)).toEqual([
      Date.parse('2026-07-15T12:02:00.000Z'),
    ]);
  });

  it('a DISABLED schedule trigger arms nothing and fires nothing', async () => {
    const { app, id } = await bootWithTrigger(false);
    expect(pendingTicks(app.db, id)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(125_000); // two whole minutes
    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);
  });
});
