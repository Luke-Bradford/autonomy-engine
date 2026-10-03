import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  CATALOG_VERSION,
  type NewRun,
  type RunTriggeredByKind,
  type TriggerContext,
  type TriggerMode,
} from '@autonomy-studio/shared';
import { triggers, tumblingWindowState, webhookDeliveries } from '../../db/schema.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { createRun, listRunSummariesPage } from '../runs.js';
import { createTrigger, deleteTrigger } from '../triggers.js';
import { freshDb } from './helpers.js';
import { makeRunActivityFold } from '../../run/activity-counts.js';
import { makeDocResolver } from '../../run/driver.js';

/** #1484 — the real Activities fold, as the runs route builds it. */
const testFold = (db: Parameters<typeof makeDocResolver>[0]) => makeRunActivityFold(makeDocResolver(db));

/**
 * #1484 OR35 M1 — `RUN_TRIGGERED_BY_SQL`'s truth table, read back through the
 * list query that selects it, against a real SQLite: the expression is SQL, so
 * only a real database can say what it evaluates to.
 */
type TestDb = ReturnType<typeof freshDb>['db'];

function setup() {
  const { db } = freshDb();
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const doc = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  const version = createPipelineVersion(db, doc);
  const debugVersion = createPipelineVersion(db, doc, { debug: true });
  return { db, versionId: version.id, debugVersionId: debugVersion.id };
}

/** A trigger of any mode. Created as `manual` (no mode-specific config to
 * satisfy), then re-moded in place: the classifier reads only `triggers.mode`. */
function trigger(db: TestDb, versionId: string, mode: TriggerMode = 'manual'): string {
  const t = createTrigger(db, {
    ownerId: 'local',
    name: `T ${mode}`,
    pipelineVersionId: versionId,
    params: {},
    mode: 'manual',
    schedule: null,
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled: false,
  });
  if (mode !== 'manual') db.update(triggers).set({ mode }).where(eq(triggers.id, t.id)).run();
  return t.id;
}

function ctx(triggerId: string, extra: Partial<TriggerContext> = {}): TriggerContext {
  return { triggerId, scheduledTime: null, body: null, ...extra };
}

function run(db: TestDb, versionId: string, overrides: Partial<NewRun> = {}): string {
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: versionId,
    triggerId: null,
    parentRunId: null,
    params: {},
    ...overrides,
  }).id;
}

function kindOf(db: TestDb, runId: string): RunTriggeredByKind | undefined {
  return listRunSummariesPage(db, { ownerId: 'local' }, { limit: 100 }, testFold(db)).items.find(
    (r) => r.id === runId,
  )?.triggeredByKind;
}

describe('RUN_TRIGGERED_BY_SQL (#1484)', () => {
  it('reads the stamped fire kind, whatever the trigger mode says', () => {
    const { db, versionId } = setup();
    // Fire now on a SCHEDULE trigger is a manual fire, not a schedule tick.
    const t = trigger(db, versionId, 'schedule');
    const kinds = ['manual', 'schedule', 'tumbling', 'webhook', 'event'] as const;
    for (const fireKind of kinds) {
      const id = run(db, versionId, { triggerId: t, triggerContext: ctx(t, { fireKind }) });
      expect(kindOf(db, id), fireKind).toBe(fireKind);
    }
  });

  it('keeps the kind after the trigger is deleted (the context survives; trigger_id does not)', () => {
    const { db, versionId } = setup();
    const t = trigger(db, versionId);
    const id = run(db, versionId, {
      triggerId: t,
      triggerContext: ctx(t, { fireKind: 'webhook' }),
    });
    deleteTrigger(db, t);
    expect(kindOf(db, id)).toBe('webhook');
  });

  it('classifies runs no trigger started: editor, debug, rerun, call', () => {
    const { db, versionId, debugVersionId } = setup();
    const editor = run(db, versionId);
    expect(kindOf(db, editor)).toBe('editor');
    expect(kindOf(db, run(db, debugVersionId))).toBe('debug');
    expect(kindOf(db, run(db, versionId, { rerunOf: editor }))).toBe('rerun');
    expect(kindOf(db, run(db, versionId, { parentRunId: editor }))).toBe('call');
  });

  it('a rerun or a child wins over a trigger context the row also carries', () => {
    const { db, versionId } = setup();
    const t = trigger(db, versionId);
    const source = run(db, versionId);
    const stamped = { triggerId: t, triggerContext: ctx(t, { fireKind: 'schedule' }) };
    expect(kindOf(db, run(db, versionId, { ...stamped, rerunOf: source }))).toBe('rerun');
    expect(kindOf(db, run(db, versionId, { ...stamped, parentRunId: source }))).toBe('call');
  });

  describe('rows written before the stamp existed', () => {
    it('a tumbling window is told by its window facts or its window-state link', () => {
      const { db, versionId } = setup();
      const t = trigger(db, versionId, 'tumbling');
      const T = '2026-07-17T09:00:00.000Z';
      // A tumbling fire ALSO sets scheduledTime (its window end); the window
      // facts must win over it.
      const withFacts = run(db, versionId, {
        triggerId: t,
        triggerContext: ctx(t, { scheduledTime: T, windowEpoch: 'ep1' }),
      });
      expect(kindOf(db, withFacts)).toBe('tumbling');

      const linkedOnly = run(db, versionId, {
        triggerId: t,
        triggerContext: ctx(t, { scheduledTime: T }),
      });
      db.insert(tumblingWindowState)
        .values({
          triggerId: t,
          configEpoch: 'ep1',
          windowStart: '2026-07-17T08:00:00.000Z',
          windowEnd: T,
          status: 'running',
          runId: linkedOnly,
          origin: 'live',
          updatedAt: Date.now(),
        })
        .run();
      expect(kindOf(db, linkedOnly)).toBe('tumbling');
    });

    it('an occurrence time means a schedule tick', () => {
      const { db, versionId } = setup();
      const t = trigger(db, versionId, 'schedule');
      const id = run(db, versionId, {
        triggerId: t,
        triggerContext: ctx(t, { scheduledTime: '2026-07-17T09:00:00.000Z' }),
      });
      expect(kindOf(db, id)).toBe('schedule');
    });

    it('a webhook is told by its recorded delivery, not by the trigger mode', () => {
      const { db, versionId } = setup();
      const t = trigger(db, versionId, 'webhook');
      const delivered = run(db, versionId, { triggerId: t, triggerContext: ctx(t) });
      db.insert(webhookDeliveries)
        .values({
          id: 'wd_1',
          triggerId: t,
          idempotencyKey: 'k1',
          outcome: 'started',
          runId: delivered,
          receivedAt: Date.now(),
        })
        .run();
      expect(kindOf(db, delivered)).toBe('webhook');
      // Same webhook trigger, no delivery: it was Fire now.
      const firedByHand = run(db, versionId, { triggerId: t, triggerContext: ctx(t) });
      expect(kindOf(db, firedByHand)).toBe('manual');
    });

    it('an event fire carries a body; Fire now on an event trigger does not', () => {
      const { db, versionId } = setup();
      const t = trigger(db, versionId, 'event');
      const evented = run(db, versionId, {
        triggerId: t,
        triggerContext: ctx(t, { body: { kind: 'x' } }),
      });
      expect(kindOf(db, evented)).toBe('event');
      expect(kindOf(db, run(db, versionId, { triggerId: t, triggerContext: ctx(t) }))).toBe(
        'manual',
      );
    });

    it('a pre-S9 row with no context reads its trigger mode for schedule/event, else manual', () => {
      const { db, versionId } = setup();
      const schedule = trigger(db, versionId, 'schedule');
      const manual = trigger(db, versionId, 'manual');
      expect(kindOf(db, run(db, versionId, { triggerId: schedule }))).toBe('schedule');
      expect(kindOf(db, run(db, versionId, { triggerId: manual }))).toBe('manual');
    });
  });
});
