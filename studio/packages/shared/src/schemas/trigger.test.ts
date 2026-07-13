import { describe, expect, it } from 'vitest';
import {
  ConcurrencyPolicySchema,
  ConcurrencySchema,
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

describe('ConcurrencySchema', () => {
  it('round-trips queue with no max', () => {
    const c = { policy: 'queue' };
    expect(ConcurrencySchema.parse(c)).toEqual(c);
  });

  it('round-trips parallel with a max', () => {
    const c = { policy: 'parallel', max: 4 };
    expect(ConcurrencySchema.parse(c)).toEqual(c);
  });

  it('rejects a zero max', () => {
    expect(() => ConcurrencySchema.parse({ policy: 'parallel', max: 0 })).toThrow();
  });

  it('rejects parallel without a max (unbounded fan-out footgun)', () => {
    expect(() => ConcurrencySchema.parse({ policy: 'parallel' })).toThrow();
  });

  it('rejects a max on a single-slot policy', () => {
    expect(() => ConcurrencySchema.parse({ policy: 'queue', max: 2 })).toThrow();
    expect(() => ConcurrencySchema.parse({ policy: 'skip_if_running', max: 2 })).toThrow();
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
  it('accepts a payload without server-set fields', () => {
    const { id, createdAt, updatedAt, ...insert } = trigger;
    void id;
    void createdAt;
    void updatedAt;
    expect(NewTriggerSchema.parse(insert)).toEqual(insert);
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
});
