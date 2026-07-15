import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connections,
  pipelineVersions,
  pipelines,
  runEvents,
  runs,
  scheduledWakeups,
  triggers,
} from '../schema.js';
import { freshDb } from '../../repo/__tests__/helpers.js';

/**
 * DB-level defense-in-depth tests: constraints and triggers that exist
 * ALONGSIDE the Zod validation the repo layer already does at its boundary
 * (`packages/shared/src/schemas/*`). These prove the database itself refuses
 * a write a raw `db.insert/update/delete` could otherwise sneak past the
 * repo functions with — not just that the repo functions behave, which the
 * `repo/__tests__/*` files already cover.
 */
describe('P1a DB constraints (fresh migrated DB, raw db access)', () => {
  it('CHECK rejects an out-of-enum connections.kind', () => {
    const { db } = freshDb();
    expect(() =>
      db
        .insert(connections)
        .values({
          id: 'conn_bad',
          ownerId: null,
          name: 'x',
          kind: 'not_a_real_kind' as never,
          config: {},
          secretRef: null,
          createdAt: 1,
          updatedAt: 1,
        })
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('CHECK rejects an out-of-enum triggers.mode', () => {
    const { db } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_1', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_1',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();

    expect(() =>
      db
        .insert(triggers)
        .values({
          id: 'trig_bad',
          ownerId: null,
          name: 'x',
          pipelineVersionId: version.id,
          params: {},
          mode: 'not_a_real_mode' as never,
          schedule: null,
          webhook: null,
          concurrency: { policy: 'queue' },
          runWindows: null,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        })
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('CHECK rejects an out-of-enum runs.status', () => {
    const { db } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_2', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_2',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();

    expect(() =>
      db
        .insert(runs)
        .values({
          id: 'run_bad',
          ownerId: null,
          pipelineVersionId: version.id,
          triggerId: null,
          parentRunId: null,
          params: {},
          status: 'cancelled' as never,
          leaseUntil: null,
          heartbeatAt: null,
          startedAt: 1,
          finishedAt: null,
        })
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('CHECK rejects an out-of-range triggers.enabled (integer-boolean column)', () => {
    const { db, sqlite } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_3', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_3',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();

    // Bypass Drizzle's `{ mode: 'boolean' }` translation (which would itself
    // coerce any truthy/falsy JS value to 0/1) with a raw insert on the same
    // connection so the out-of-range integer actually reaches the CHECK
    // constraint.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO triggers
             (id, owner_id, name, pipeline_version_id, params, mode, schedule, webhook, concurrency, run_windows, enabled, created_at, updated_at)
           VALUES (?, NULL, 'x', ?, '{}', 'manual', NULL, NULL, '{"policy":"queue"}', NULL, 2, 1, 1)`,
        )
        .run('trig_bad_enabled', version.id),
    ).toThrow(/CHECK constraint failed/);
  });

  it('triggers.pipeline_version_id accepts NULL (P1c: an unbound trigger)', () => {
    const { db, sqlite } = freshDb();
    const trigger = db
      .insert(triggers)
      .values({
        id: 'trig_unbound',
        ownerId: null,
        name: 'Unbound',
        pipelineVersionId: null,
        params: {},
        mode: 'manual',
        schedule: null,
        webhook: null,
        concurrency: { policy: 'queue' },
        runWindows: null,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .returning()
      .get();
    expect(trigger.pipelineVersionId).toBeNull();

    const row = sqlite
      .prepare('SELECT pipeline_version_id FROM triggers WHERE id = ?')
      .get('trig_unbound') as { pipeline_version_id: string | null };
    expect(row.pipeline_version_id).toBeNull();
  });

  it('FK rejects creating a connection with a bogus secretRef', () => {
    const { db } = freshDb();
    expect(() =>
      db
        .insert(connections)
        .values({
          id: 'conn_bogus_ref',
          ownerId: null,
          name: 'x',
          kind: 'http',
          config: {},
          secretRef: 'sec_does_not_exist',
          createdAt: 1,
          updatedAt: 1,
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('pipeline_versions: a raw UPDATE is aborted (immutability trigger)', () => {
    const { db } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_4', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_4',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();

    expect(() =>
      db
        .update(pipelineVersions)
        .set({ catalogVersion: 2 })
        .where(eq(pipelineVersions.id, version.id))
        .run(),
    ).toThrow(/pipeline_versions are immutable/);
  });

  it('pipeline_versions: a raw standalone DELETE (parent pipeline still alive) is aborted', () => {
    const { db } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_5', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_5',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();

    expect(() =>
      db.delete(pipelineVersions).where(eq(pipelineVersions.id, version.id)).run(),
    ).toThrow(/pipeline_versions are immutable/);
  });

  it('pipeline_versions: DELETE still cascades when the parent pipeline itself is deleted (no direct delete involved)', () => {
    const { db } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_6', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_6',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();

    db.delete(pipelines).where(eq(pipelines.id, pipeline.id)).run();
    expect(
      db.select().from(pipelineVersions).where(eq(pipelineVersions.id, version.id)).get(),
    ).toBeUndefined();
  });

  it('run_events: a raw UPDATE is aborted (append-only trigger)', () => {
    const { db } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_7', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_7',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();
    const run = db
      .insert(runs)
      .values({
        id: 'run_7',
        ownerId: null,
        pipelineVersionId: version.id,
        triggerId: null,
        parentRunId: null,
        params: {},
        status: 'pending',
        leaseUntil: null,
        heartbeatAt: null,
        startedAt: 1,
        finishedAt: null,
      })
      .returning()
      .get();
    const evt = db
      .insert(runEvents)
      .values({ id: 'evt_7', runId: run.id, seq: 0, type: 'run.started', payload: {}, ts: 1 })
      .returning()
      .get();

    expect(() =>
      db.update(runEvents).set({ type: 'edited' }).where(eq(runEvents.id, evt.id)).run(),
    ).toThrow(/run_events are append-only/);
  });

  it('run_events: a raw standalone DELETE (parent run still alive) is aborted', () => {
    const { db } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_8', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_8',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();
    const run = db
      .insert(runs)
      .values({
        id: 'run_8',
        ownerId: null,
        pipelineVersionId: version.id,
        triggerId: null,
        parentRunId: null,
        params: {},
        status: 'pending',
        leaseUntil: null,
        heartbeatAt: null,
        startedAt: 1,
        finishedAt: null,
      })
      .returning()
      .get();
    const evt = db
      .insert(runEvents)
      .values({ id: 'evt_8', runId: run.id, seq: 0, type: 'run.started', payload: {}, ts: 1 })
      .returning()
      .get();

    expect(() => db.delete(runEvents).where(eq(runEvents.id, evt.id)).run()).toThrow(
      /run_events are append-only/,
    );
  });

  it('run_events: DELETE still cascades when the parent run itself is deleted (no direct delete involved)', () => {
    const { db } = freshDb();
    const pipeline = db
      .insert(pipelines)
      .values({ id: 'pipe_9', ownerId: null, name: 'P', createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const version = db
      .insert(pipelineVersions)
      .values({
        id: 'pv_9',
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: 1,
        createdAt: 1,
      })
      .returning()
      .get();
    const run = db
      .insert(runs)
      .values({
        id: 'run_9',
        ownerId: null,
        pipelineVersionId: version.id,
        triggerId: null,
        parentRunId: null,
        params: {},
        status: 'pending',
        leaseUntil: null,
        heartbeatAt: null,
        startedAt: 1,
        finishedAt: null,
      })
      .returning()
      .get();
    const evt = db
      .insert(runEvents)
      .values({ id: 'evt_9', runId: run.id, seq: 0, type: 'run.started', payload: {}, ts: 1 })
      .returning()
      .get();

    db.delete(runs).where(eq(runs.id, run.id)).run();
    expect(db.select().from(runEvents).where(eq(runEvents.id, evt.id)).get()).toBeUndefined();
  });
});

describe('#5 S1 scheduled_wakeups constraints (raw db access)', () => {
  const row = {
    id: 'wku_1',
    kind: 'retry',
    ref: { runId: 'run_1' },
    dueAt: 1_000,
    dedupeKey: 'retry:{"runId":"run_1"}:attempt-1',
    status: 'pending' as const,
    firedAt: null,
  };

  it('UNIQUE (kind, dedupe_key) refuses a duplicate alarm at the DB level', () => {
    // `armWakeup` returns the existing row rather than inserting a second, so
    // the repo tests never reach this index. It is the backstop that makes
    // arm-idempotency an INVARIANT rather than a convention: a raw insert (or a
    // future writer that forgets the read-then-insert) is refused by the
    // database itself.
    const { db } = freshDb();
    db.insert(scheduledWakeups).values(row).run();
    expect(() =>
      db
        .insert(scheduledWakeups)
        .values({ ...row, id: 'wku_2' })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('UNIQUE is scoped to (kind, dedupe_key) — the same key under another kind is a distinct alarm', () => {
    const { db } = freshDb();
    db.insert(scheduledWakeups).values(row).run();
    expect(() =>
      db
        .insert(scheduledWakeups)
        .values({ ...row, id: 'wku_2', kind: 'timer' })
        .run(),
    ).not.toThrow();
  });

  it('CHECK rejects an out-of-enum status', () => {
    const { db } = freshDb();
    expect(() =>
      db
        .insert(scheduledWakeups)
        .values({ ...row, status: 'claimed' as never })
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('accepts ANY kind — `kind` is deliberately open, with no CHECK', () => {
    // The mirror of the test above, and the point of the asymmetry: `status` is
    // a settled, closed vocabulary; `kind` is not. A CHECK on `kind` would need
    // a table-recreate migration for every new consumer, and would pin a
    // durable field to today's vocabulary. The handler registry
    // (`scheduler/alarms.ts`) is the runtime authority instead.
    const { db } = freshDb();
    expect(() =>
      db
        .insert(scheduledWakeups)
        .values({ ...row, kind: 'a_kind_invented_in_2027' })
        .run(),
    ).not.toThrow();
  });
});
