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
  it.each(['manual', 'schedule', 'webhook', 'event', 'continuous'])('accepts %s', (mode) => {
    expect(TriggerModeSchema.parse(mode)).toBe(mode);
  });

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
  ownerId: null,
  name: 'Nightly run',
  pipelineVersionId: 'pv_1',
  params: { topic: 'news' },
  mode: 'schedule',
  schedule: '0 2 * * *',
  webhook: null,
  concurrency: { policy: 'skip_if_running' },
  runWindows: null,
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
});

describe('NewTriggerSchema', () => {
  const { id, createdAt, updatedAt, ...insert } = trigger;
  void id;
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
