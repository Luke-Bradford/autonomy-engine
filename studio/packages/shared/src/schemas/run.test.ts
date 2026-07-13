import { describe, expect, it } from 'vitest';
import {
  NewRunEventSchema,
  NewRunSchema,
  RunEventSchema,
  RunLifecyclePatchSchema,
  RunSchema,
  RunStatusSchema,
} from './run.js';

describe('RunStatusSchema', () => {
  it.each(['pending', 'running', 'success', 'failure', 'skipped', 'waiting', 'interrupted'])(
    'accepts %s',
    (status) => {
      expect(RunStatusSchema.parse(status)).toBe(status);
    },
  );

  it('rejects an unknown status', () => {
    expect(() => RunStatusSchema.parse('cancelled')).toThrow();
  });
});

const run = {
  id: 'run_1',
  ownerId: null,
  pipelineVersionId: 'pv_1',
  triggerId: null,
  parentRunId: null,
  params: { topic: 'news' },
  status: 'pending',
  leaseUntil: null,
  heartbeatAt: null,
  startedAt: 1700000000000,
  finishedAt: null,
};

describe('RunSchema', () => {
  it('round-trips a valid pending run', () => {
    expect(RunSchema.parse(run)).toEqual(run);
  });

  it('round-trips a finished run with a trigger and lease/heartbeat set', () => {
    const finished = {
      ...run,
      triggerId: 'trig_1',
      status: 'success',
      leaseUntil: 1700000005000,
      heartbeatAt: 1700000004000,
      finishedAt: 1700000006000,
    };
    expect(RunSchema.parse(finished)).toEqual(finished);
  });

  it('round-trips a child run (parentRunId set)', () => {
    const child = { ...run, parentRunId: 'run_parent' };
    expect(RunSchema.parse(child)).toEqual(child);
  });

  it('rejects an invalid status', () => {
    expect(() => RunSchema.parse({ ...run, status: 'cancelled' })).toThrow();
  });

  it('rejects a non-integer leaseUntil', () => {
    expect(() => RunSchema.parse({ ...run, leaseUntil: 1700000005000.5 })).toThrow();
  });

  it('rejects a non-integer heartbeatAt', () => {
    expect(() => RunSchema.parse({ ...run, heartbeatAt: 1700000004000.5 })).toThrow();
  });
});

describe('RunLifecyclePatchSchema', () => {
  it('accepts a patch with only lifecycle fields', () => {
    const patch = { status: 'running' as const, leaseUntil: 1700000005000 };
    expect(RunLifecyclePatchSchema.parse(patch)).toEqual(patch);
  });

  it('accepts an empty patch', () => {
    expect(RunLifecyclePatchSchema.parse({})).toEqual({});
  });

  it('rejects a patch touching an immutable-binding field (pipelineVersionId)', () => {
    expect(() =>
      RunLifecyclePatchSchema.parse({ status: 'running', pipelineVersionId: 'pv_2' }),
    ).toThrow();
  });

  it('rejects a patch touching params', () => {
    expect(() => RunLifecyclePatchSchema.parse({ params: { changed: true } })).toThrow();
  });

  it('rejects a patch touching startedAt', () => {
    expect(() => RunLifecyclePatchSchema.parse({ startedAt: 0 })).toThrow();
  });

  it('rejects a patch touching triggerId or parentRunId', () => {
    expect(() => RunLifecyclePatchSchema.parse({ triggerId: 'trig_1' })).toThrow();
    expect(() => RunLifecyclePatchSchema.parse({ parentRunId: 'run_1' })).toThrow();
  });

  it('rejects any other unrecognized key', () => {
    expect(() => RunLifecyclePatchSchema.parse({ notAField: true })).toThrow();
  });
});

describe('NewRunSchema', () => {
  it('defaults status to pending when omitted', () => {
    const { id, status, leaseUntil, heartbeatAt, startedAt, finishedAt, ...insert } = run;
    void id;
    void status;
    void leaseUntil;
    void heartbeatAt;
    void startedAt;
    void finishedAt;
    const parsed = NewRunSchema.parse(insert);
    expect(parsed.status).toBe('pending');
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('startedAt');
  });

  it('accepts an explicit non-default status', () => {
    const { id, leaseUntil, heartbeatAt, startedAt, finishedAt, ...insert } = run;
    void id;
    void leaseUntil;
    void heartbeatAt;
    void startedAt;
    void finishedAt;
    const parsed = NewRunSchema.parse({ ...insert, status: 'waiting' });
    expect(parsed.status).toBe('waiting');
  });
});

const runEvent = {
  id: 'evt_1',
  runId: 'run_1',
  seq: 0,
  type: 'run.started',
  payload: { note: 'kickoff' },
  ts: 1700000000000,
};

describe('RunEventSchema', () => {
  it('round-trips a valid event', () => {
    expect(RunEventSchema.parse(runEvent)).toEqual(runEvent);
  });

  it('accepts an arbitrary payload shape', () => {
    const withArrayPayload = { ...runEvent, payload: [1, 2, 3] };
    expect(RunEventSchema.parse(withArrayPayload)).toEqual(withArrayPayload);
  });

  it('rejects a negative seq', () => {
    expect(() => RunEventSchema.parse({ ...runEvent, seq: -1 })).toThrow();
  });

  it('rejects an empty type', () => {
    expect(() => RunEventSchema.parse({ ...runEvent, type: '' })).toThrow();
  });
});

describe('NewRunEventSchema', () => {
  it('accepts a payload without id/seq/ts (server assigns them)', () => {
    const { id, seq, ts, ...insert } = runEvent;
    void id;
    void seq;
    void ts;
    const parsed = NewRunEventSchema.parse(insert);
    expect(parsed).not.toHaveProperty('seq');
    expect(parsed).not.toHaveProperty('ts');
  });
});
