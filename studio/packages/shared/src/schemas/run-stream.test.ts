import { describe, expect, it } from 'vitest';
import { RunStreamServerMessageSchema } from './run-stream.js';
import type { RunEvent } from './run.js';

const anEvent: RunEvent = {
  id: 'evt_1',
  runId: 'run_1',
  seq: 0,
  type: 'run.started',
  payload: { type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} },
  ts: 1,
};

describe('RunStreamServerMessageSchema', () => {
  it('accepts an event message wrapping a full run-event envelope', () => {
    const msg = RunStreamServerMessageSchema.parse({ kind: 'event', event: anEvent });
    expect(msg.kind).toBe('event');
    if (msg.kind === 'event') expect(msg.event.seq).toBe(0);
  });

  it('accepts a replay_complete marker (including the empty-run -1 sentinel)', () => {
    expect(RunStreamServerMessageSchema.parse({ kind: 'replay_complete', throughSeq: -1 })).toEqual(
      {
        kind: 'replay_complete',
        throughSeq: -1,
      },
    );
    expect(
      RunStreamServerMessageSchema.parse({ kind: 'replay_complete', throughSeq: 7 }).kind,
    ).toBe('replay_complete');
  });

  it('rejects an unknown kind', () => {
    expect(() => RunStreamServerMessageSchema.parse({ kind: 'nope' })).toThrow();
  });

  it('rejects an event message whose envelope is malformed', () => {
    expect(() =>
      RunStreamServerMessageSchema.parse({ kind: 'event', event: { runId: 'x' } }),
    ).toThrow();
  });

  it('rejects a non-integer throughSeq', () => {
    expect(() =>
      RunStreamServerMessageSchema.parse({ kind: 'replay_complete', throughSeq: 1.5 }),
    ).toThrow();
  });
});
