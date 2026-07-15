import { describe, expect, it } from 'vitest';
import {
  ArmWakeupInputSchema,
  ScheduledWakeupSchema,
  WakeupStatusSchema,
  buildDedupeKey,
} from './wakeup.js';

describe('#5 S1 — WakeupStatus vocabulary', () => {
  it('is exactly the four reachable states', () => {
    // Each has a distinct writer: `pending` (arm), `fired`/`suppressed` (the
    // clock's fire txn), `cancelled` (cancel/supersede). A status nothing can
    // write would be the same unreachable-surface defect as a column no code
    // sets — see the `claimedAt` note in `wakeup.ts`.
    expect(WakeupStatusSchema.options).toEqual(['pending', 'fired', 'suppressed', 'cancelled']);
  });
});

describe('#5 S1 — buildDedupeKey is the (kind, ref, discriminator) SSOT', () => {
  it('composes kind, ref and discriminator', () => {
    const key = buildDedupeKey({
      kind: 'retry',
      ref: { runId: 'run_1', nodeId: 'a' },
      discriminator: 'attempt-1',
    });
    expect(key).toContain('retry');
    expect(key).toContain('run_1');
    expect(key).toContain('attempt-1');
  });

  it('is DETERMINISTIC across ref key order — the dedupe identity cannot depend on JS insertion order', () => {
    // `ref` is a JSON object, so a naive `JSON.stringify` would key off
    // insertion order: the same logical alarm armed from two call sites (or
    // re-armed on replay from a differently-ordered literal) would produce two
    // different keys, both of which arm — silently double-firing. Sorted-key
    // serialisation is what makes the UNIQUE (kind, dedupeKey) index mean
    // "the same logical alarm".
    const a = buildDedupeKey({
      kind: 'retry',
      ref: { runId: 'run_1', nodeId: 'a', attemptId: 'att_1' },
      discriminator: 'attempt-1',
    });
    const b = buildDedupeKey({
      kind: 'retry',
      ref: { attemptId: 'att_1', nodeId: 'a', runId: 'run_1' },
      discriminator: 'attempt-1',
    });
    expect(a).toBe(b);
  });

  it('THE SPIKE REGRESSION: a different attempt yields a different key', () => {
    // The spike's headline finding (spec #5, "Spike-hardened"): omitting the
    // attempt number from the key makes attempt-2's retry collide with
    // attempt-1's already-`fired` row, so attempt 2 "silently never arms".
    // The discriminator is what prevents it — proven end-to-end against the
    // real UNIQUE index in `repo/__tests__/scheduled-wakeups.test.ts`.
    const ref = { runId: 'run_1', nodeId: 'a' };
    const attempt1 = buildDedupeKey({ kind: 'retry', ref, discriminator: 'attempt-1' });
    const attempt2 = buildDedupeKey({ kind: 'retry', ref, discriminator: 'attempt-2' });
    expect(attempt1).not.toBe(attempt2);
  });

  it('distinguishes kinds that share a ref and discriminator', () => {
    const ref = { runId: 'run_1', nodeId: 'a' };
    expect(buildDedupeKey({ kind: 'retry', ref, discriminator: 'attempt-1' })).not.toBe(
      buildDedupeKey({ kind: 'timer', ref, discriminator: 'attempt-1' }),
    );
  });

  it('does not let ref values forge a collision across field boundaries', () => {
    // A hand-rolled `join(':')` over values would make {a:'x:y'} and
    // {a:'x', b:'y'} collide. The serialisation must be injective.
    expect(buildDedupeKey({ kind: 'retry', ref: { a: 'x:y' }, discriminator: 'd' })).not.toBe(
      buildDedupeKey({ kind: 'retry', ref: { a: 'x', b: 'y' }, discriminator: 'd' }),
    );
  });

  it('rejects an empty discriminator — the field is the spike lesson, an empty one defeats it', () => {
    expect(() =>
      buildDedupeKey({ kind: 'retry', ref: { runId: 'r' }, discriminator: '' }),
    ).toThrow();
  });
});

describe('#5 S1 — ArmWakeupInputSchema models the ONE write path', () => {
  it('accepts the caller-facing arm input', () => {
    const parsed = ArmWakeupInputSchema.parse({
      kind: 'retry',
      ref: { runId: 'run_1', nodeId: 'a' },
      dueAt: 1_700_000_000_000,
      discriminator: 'attempt-1',
    });
    expect(parsed.kind).toBe('retry');
  });

  it('rejects a non-integer dueAt — `dueAt` is a stored epoch-ms fact', () => {
    expect(() =>
      ArmWakeupInputSchema.parse({
        kind: 'retry',
        ref: { runId: 'run_1' },
        dueAt: 1.5,
        discriminator: 'attempt-1',
      }),
    ).toThrow();
  });

  it('rejects a non-string ref value — ref is a flat string map so its key is deterministic', () => {
    expect(() =>
      ArmWakeupInputSchema.parse({
        kind: 'retry',
        ref: { runId: 1 },
        dueAt: 1,
        discriminator: 'attempt-1',
      }),
    ).toThrow();
  });

  it('carries NO server-set field: status/firedAt/id are not caller input', () => {
    // Mirrors the `webhook-delivery.ts` note: an insert schema spanning
    // server-set columns mis-models the one write path the row has.
    const shape = Object.keys(ArmWakeupInputSchema.shape);
    expect(shape.sort()).toEqual(['discriminator', 'dueAt', 'kind', 'ref']);
  });
});

describe('#5 S1 — ScheduledWakeupSchema is the durable row', () => {
  const row = {
    id: 'wku_1',
    kind: 'retry',
    ref: { runId: 'run_1', nodeId: 'a' },
    dueAt: 1_700_000_000_000,
    dedupeKey: 'retry:{"nodeId":"a","runId":"run_1"}:attempt-1',
    status: 'pending' as const,
    firedAt: null,
    supersededBy: null,
  };

  it('parses a pending row', () => {
    expect(ScheduledWakeupSchema.parse(row).status).toBe('pending');
  });

  it('accepts an open `kind` — the registry is the runtime authority, not an enum', () => {
    // `kind` is deliberately NOT an enum: at S1 no consumer exists, so a closed
    // vocabulary would be speculative AND a durable back-compat trap (the same
    // reasoning `node.failed.code` records in `engine/types.ts`). The alarm
    // clock's handler registry decides which kinds are live; an unregistered
    // kind is simply never claimed.
    expect(ScheduledWakeupSchema.parse({ ...row, kind: 'a_kind_invented_later' }).kind).toBe(
      'a_kind_invented_later',
    );
  });

  it('rejects an unknown status — the status vocabulary IS closed', () => {
    expect(() => ScheduledWakeupSchema.parse({ ...row, status: 'claimed' })).toThrow();
  });
});
