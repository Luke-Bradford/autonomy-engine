import { describe, expect, it } from 'vitest';
import {
  ConcurrencyPolicySchema,
  ConcurrencySchema,
  ConcurrencyWriteSchema,
  NewTriggerSchema,
  RunWindowSchema,
  TriggerModeSchema,
  TriggerPublicSchema,
  TriggerSchema,
  WebhookConfigSchema,
  WebhookPublicConfigSchema,
} from './trigger.js';

describe('TriggerModeSchema', () => {
  it.each(['manual', 'schedule', 'webhook', 'event', 'continuous', 'tumbling'])(
    'accepts %s',
    (mode) => {
      expect(TriggerModeSchema.parse(mode)).toBe(mode);
    },
  );

  it('rejects an unknown mode', () => {
    expect(() => TriggerModeSchema.parse('cron')).toThrow();
  });
});

describe('ConcurrencyPolicySchema', () => {
  it.each(['queue', 'skip_if_running', 'parallel'])('accepts %s', (policy) => {
    expect(ConcurrencyPolicySchema.parse(policy)).toBe(policy);
  });

  it('rejects an unknown policy', () => {
    expect(() => ConcurrencyPolicySchema.parse('fan_out')).toThrow();
  });
});

describe('ConcurrencySchema (stored/read — lenient)', () => {
  it('round-trips queue with no max', () => {
    const c = { policy: 'queue' };
    expect(ConcurrencySchema.parse(c)).toEqual(c);
  });

  it('round-trips parallel with a max', () => {
    const c = { policy: 'parallel', max: 4 };
    expect(ConcurrencySchema.parse(c)).toEqual(c);
  });

  it('rejects a zero/negative max (still a base-type constraint)', () => {
    expect(() => ConcurrencySchema.parse({ policy: 'parallel', max: 0 })).toThrow();
  });

  it('READS legacy rows the write-rule would reject (migration-safe): parallel-no-max + single-slot-with-max', () => {
    // Persisted under an older, looser schema — must not throw on read.
    expect(ConcurrencySchema.parse({ policy: 'parallel' })).toEqual({ policy: 'parallel' });
    expect(ConcurrencySchema.parse({ policy: 'queue', max: 2 })).toEqual({
      policy: 'queue',
      max: 2,
    });
  });
});

describe('ConcurrencyWriteSchema (write-boundary — strict cross-field rule)', () => {
  it('accepts parallel with a max and single-slot policies with no max', () => {
    expect(ConcurrencyWriteSchema.parse({ policy: 'parallel', max: 4 })).toEqual({
      policy: 'parallel',
      max: 4,
    });
    expect(ConcurrencyWriteSchema.parse({ policy: 'queue' })).toEqual({ policy: 'queue' });
  });

  it('rejects parallel without a max (unbounded fan-out footgun)', () => {
    expect(() => ConcurrencyWriteSchema.parse({ policy: 'parallel' })).toThrow();
  });

  it('rejects a max on a single-slot policy', () => {
    expect(() => ConcurrencyWriteSchema.parse({ policy: 'queue', max: 2 })).toThrow();
    expect(() => ConcurrencyWriteSchema.parse({ policy: 'skip_if_running', max: 2 })).toThrow();
  });
});

describe('RunWindowSchema', () => {
  it('round-trips a window with days', () => {
    const w = { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] };
    expect(RunWindowSchema.parse(w)).toEqual(w);
  });

  it('round-trips a wrap-past-midnight window without days', () => {
    const w = { start: '22:00', end: '02:00' };
    expect(RunWindowSchema.parse(w)).toEqual(w);
  });

  it('rejects an out-of-range day', () => {
    expect(() => RunWindowSchema.parse({ start: '09:00', end: '17:00', days: [7] })).toThrow();
  });
});

describe('WebhookConfigSchema', () => {
  it('round-trips a minimal webhook config', () => {
    const w = { secretRef: 'secret_1' };
    expect(WebhookConfigSchema.parse(w)).toEqual(w);
  });

  it('allows extra fields (idempotency/replay-protection config)', () => {
    const w = { secretRef: 'secret_1', idempotencyWindowSeconds: 300 };
    expect(WebhookConfigSchema.parse(w)).toEqual(w);
  });

  it('rejects a missing secretRef', () => {
    expect(() => WebhookConfigSchema.parse({})).toThrow();
  });
});

const trigger = {
  id: 'trig_1',
  resourceId: 'res_trig1',
  ownerId: null,
  name: 'Nightly run',
  pipelineVersionId: 'pv_1',
  params: { topic: 'news' },
  mode: 'schedule',
  schedule: '0 2 * * *',
  webhook: null,
  event: null,
  window: null,
  concurrency: { policy: 'skip_if_running' },
  runWindows: null,
  recurrence: null,
  enabled: true,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('TriggerSchema', () => {
  it('round-trips a valid schedule trigger', () => {
    expect(TriggerSchema.parse(trigger)).toEqual(trigger);
  });

  it('round-trips a manual trigger with run windows', () => {
    const manual = {
      ...trigger,
      mode: 'manual',
      schedule: null,
      runWindows: [{ start: '09:00', end: '17:00' }],
    };
    expect(TriggerSchema.parse(manual)).toEqual(manual);
  });

  it('rejects an invalid mode', () => {
    expect(() => TriggerSchema.parse({ ...trigger, mode: 'cron' })).toThrow();
  });

  it('rejects a webhook trigger missing webhook.secretRef', () => {
    expect(() => TriggerSchema.parse({ ...trigger, webhook: {} })).toThrow();
  });

  it('accepts a null pipelineVersionId (an unbound trigger, e.g. freshly imported)', () => {
    const unbound = { ...trigger, pipelineVersionId: null };
    expect(TriggerSchema.parse(unbound)).toEqual(unbound);
  });

  // #5 S8 — event-mode named-channel subscription config.
  it('round-trips an event trigger with an event config', () => {
    const evt = {
      ...trigger,
      mode: 'event',
      schedule: null,
      event: { name: 'order.created' },
    };
    expect(TriggerSchema.parse(evt)).toEqual(evt);
  });

  it('rejects an event config missing its name', () => {
    expect(() => TriggerSchema.parse({ ...trigger, event: {} })).toThrow();
    expect(() => TriggerSchema.parse({ ...trigger, event: { name: '' } })).toThrow();
  });

  it('passes unknown event-config keys through (open-ended, like webhook)', () => {
    const evt = { ...trigger, event: { name: 'x', filter: 'later' } };
    expect(TriggerSchema.parse(evt)).toEqual(evt);
  });
});

describe('NewTriggerSchema.event (write-side 3-state, the recurrence precedent)', () => {
  const { id, createdAt, updatedAt, ...insert } = trigger;
  void id;
  void createdAt;
  void updatedAt;
  // The write fixture must not itself carry `event` — omission is the case
  // under test (backward compatibility for pre-S8 clients).
  const { event, ...insertNoEvent } = insert;
  void event;

  it('parses with `event` OMITTED (pre-S8 payloads keep working) and does NOT inject a value', () => {
    const parsed = NewTriggerSchema.parse(insertNoEvent);
    expect('event' in parsed && parsed.event !== undefined).toBe(false);
  });

  it('accepts an explicit null (clear) and an object (set)', () => {
    expect(NewTriggerSchema.parse({ ...insertNoEvent, event: null }).event).toBeNull();
    expect(
      NewTriggerSchema.parse({ ...insertNoEvent, event: { name: 'order.created' } }).event,
    ).toEqual({ name: 'order.created' });
  });

  it('a .partial() PATCH body does NOT manufacture an `event` key (no .default() pitfall)', () => {
    const parsed = NewTriggerSchema.partial().parse({ enabled: false });
    expect('event' in parsed && parsed.event !== undefined).toBe(false);
  });
});

// #5 S9 — the tumbling-window config field.
describe('TriggerSchema.window', () => {
  const window = { frequency: 'hour', interval: 1, startTime: '2026-07-01T00:00:00.000Z' };

  it('round-trips a tumbling trigger with a window config', () => {
    const tumbling = { ...trigger, mode: 'tumbling', schedule: null, window };
    expect(TriggerSchema.parse(tumbling)).toEqual(tumbling);
  });

  it('rejects a window with a non-fixed-duration frequency (month/week are not v1)', () => {
    expect(() =>
      TriggerSchema.parse({ ...trigger, window: { ...window, frequency: 'month' } }),
    ).toThrow();
    expect(() =>
      TriggerSchema.parse({ ...trigger, window: { ...window, frequency: 'week' } }),
    ).toThrow();
  });

  it('rejects a window missing its startTime anchor or with a non-positive interval', () => {
    const { startTime, ...noStart } = window;
    void startTime;
    expect(() => TriggerSchema.parse({ ...trigger, window: noStart })).toThrow();
    expect(() => TriggerSchema.parse({ ...trigger, window: { ...window, interval: 0 } })).toThrow();
  });
});

describe('NewTriggerSchema.window (write-side 3-state, the recurrence/event precedent)', () => {
  const { id, createdAt, updatedAt, ...insert } = trigger;
  void id;
  void createdAt;
  void updatedAt;
  const { window: fixtureWindow, ...insertNoWindow } = insert;
  void fixtureWindow;
  const window = { frequency: 'minute', interval: 15, startTime: '2026-07-01T00:00:00.000Z' };

  it('parses with `window` OMITTED (pre-S9 payloads keep working) and does NOT inject a value', () => {
    const parsed = NewTriggerSchema.parse(insertNoWindow);
    expect('window' in parsed && parsed.window !== undefined).toBe(false);
  });

  it('accepts an explicit null (clear) and an object (set)', () => {
    expect(NewTriggerSchema.parse({ ...insertNoWindow, window: null }).window).toBeNull();
    expect(NewTriggerSchema.parse({ ...insertNoWindow, window }).window).toEqual(window);
  });

  it('a .partial() PATCH body does NOT manufacture a `window` key (no .default() pitfall)', () => {
    const parsed = NewTriggerSchema.partial().parse({ enabled: false });
    expect('window' in parsed && parsed.window !== undefined).toBe(false);
  });

  it('enforces the WRITE cross-field rule (endTime after startTime) on set', () => {
    expect(() =>
      NewTriggerSchema.parse({
        ...insertNoWindow,
        window: { ...window, endTime: '2026-06-01T00:00:00.000Z' },
      }),
    ).toThrow();
  });
});

describe('NewTriggerSchema', () => {
  const { id, resourceId, createdAt, updatedAt, ...insert } = trigger;
  void id;
  void resourceId;
  void createdAt;
  void updatedAt;

  it('accepts a payload without server-set fields', () => {
    expect(NewTriggerSchema.parse(insert)).toEqual(insert);
  });

  // #5 S12b — expression-valued param binding validation (write path only).
  it('accepts a ${trigger.*} param binding on the write path', () => {
    const parsed = NewTriggerSchema.parse({
      ...insert,
      params: { when: '${trigger.scheduledTime}', uid: '${trigger.body.user.id}' },
    });
    expect(parsed.params).toEqual({
      when: '${trigger.scheduledTime}',
      uid: '${trigger.body.user.id}',
    });
  });

  it('rejects a param binding that references a non-trigger root', () => {
    expect(() => NewTriggerSchema.parse({ ...insert, params: { x: '${params.foo}' } })).toThrow(
      /may reference only \$\{trigger\.\*\}/,
    );
    expect(() =>
      NewTriggerSchema.parse({ ...insert, params: { x: '${nodes.a.output.y}' } }),
    ).toThrow(/may reference only/);
  });

  it('rejects an unknown trigger field in a binding', () => {
    expect(() => NewTriggerSchema.parse({ ...insert, params: { x: '${trigger.nope}' } })).toThrow(
      /is not a known trigger field/,
    );
  });

  it('accepts literal (non-expression) param values unchanged', () => {
    expect(NewTriggerSchema.parse({ ...insert, params: { topic: 'news', n: 3 } }).params).toEqual({
      topic: 'news',
      n: 3,
    });
  });

  // #547 — a literal non-finite param value (1e999 → Infinity over HTTP) is
  // refused on write: stored, later fed to a run, and lost to null on the
  // run.started JSON.stringify.
  it('rejects a non-finite literal param value (#547)', () => {
    expect(() => NewTriggerSchema.parse({ ...insert, params: { x: Infinity } })).toThrow(
      /non-finite number refused/,
    );
    expect(() =>
      NewTriggerSchema.parse({ ...insert, params: { deep: { a: [Number.NaN] } } }),
    ).toThrow(/non-finite number refused/);
    // A finite value + a ${} string binding both still pass.
    expect(
      NewTriggerSchema.parse({ ...insert, params: { n: 1e308, when: '${trigger.scheduledTime}' } })
        .params,
    ).toEqual({ n: 1e308, when: '${trigger.scheduledTime}' });
  });
});

describe('TriggerSchema (stored/read) tolerates a binding the write path would refuse', () => {
  it('does not run binding validation on read', () => {
    // A row persisted before the S12b gate must still READ — resolution fails
    // SAFE at fire time, it is not refused on load.
    const stored = { ...trigger, params: { x: '${params.foo}' } };
    expect(TriggerSchema.parse(stored)).toEqual(stored);
  });
});

describe('WebhookPublicConfigSchema', () => {
  it('never carries secretRef', () => {
    const parsed = WebhookPublicConfigSchema.parse({
      secretRef: 'secret_1',
      idempotencyWindowSeconds: 300,
    });
    expect(parsed).not.toHaveProperty('secretRef');
    expect(parsed).toEqual({ idempotencyWindowSeconds: 300 });
  });

  it('is idempotent — re-parsing an already-stripped config does not throw', () => {
    // The web API client re-parses a `TriggerPublic` response (secretRef
    // already gone) through this same shared schema. secretRef is optional on
    // input, so a config with no secretRef round-trips instead of throwing.
    const alreadyPublic = { idempotencyWindowSeconds: 300 };
    expect(WebhookPublicConfigSchema.parse(alreadyPublic)).toEqual(alreadyPublic);
  });

  it('preserves secretRef structural validation — an empty secretRef is still rejected', () => {
    // Being derived from `WebhookConfigSchema`, the only relaxation is
    // secretRef → optional; its `.min(1)` check is retained, so a
    // present-but-empty secretRef is still a boundary violation, not passed
    // through as an unknown/catchall key.
    expect(() => WebhookPublicConfigSchema.parse({ secretRef: '' })).toThrow();
  });

  it('passes unknown keys through (catchall retained through the derivation)', () => {
    const parsed = WebhookPublicConfigSchema.parse({
      secretRef: 'secret_1',
      replayProtection: true,
      idempotencyWindowSeconds: 300,
    });
    expect(parsed).toEqual({ replayProtection: true, idempotencyWindowSeconds: 300 });
  });
});

describe('TriggerPublicSchema', () => {
  it('never carries webhook.secretRef', () => {
    const webhookTrigger = {
      ...trigger,
      mode: 'webhook',
      webhook: { secretRef: 'secret_1', idempotencyWindowSeconds: 300 },
    };
    const parsed = TriggerPublicSchema.parse(webhookTrigger);
    expect(parsed.webhook).not.toHaveProperty('secretRef');
    expect(parsed.webhook).toEqual({ idempotencyWindowSeconds: 300 });
  });

  it('round-trips a null webhook unchanged', () => {
    const parsed = TriggerPublicSchema.parse(trigger);
    expect(parsed.webhook).toBeNull();
  });

  it('is idempotent — re-parsing its own output does not throw (client re-parse)', () => {
    // Regression: the server sends `TriggerPublic` (webhook.secretRef stripped),
    // and the web API client validates that body through TriggerPublicSchema
    // again. A non-idempotent public webhook schema threw here, breaking every
    // list/edit of a provisioned webhook trigger.
    const webhookTrigger = {
      ...trigger,
      mode: 'webhook',
      schedule: null,
      webhook: { secretRef: 'secret_1', idempotencyWindowSeconds: 300 },
    };
    const once = TriggerPublicSchema.parse(webhookTrigger);
    const twice = TriggerPublicSchema.parse(once);
    expect(twice.webhook).toEqual({ idempotencyWindowSeconds: 300 });
  });
});
