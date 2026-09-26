import { describe, expect, it } from 'vitest';
import { createRunCancels } from '../cancel.js';

/** CX2 (#1320) — the cancel intent + poke registry (spec D6). */
describe('createRunCancels', () => {
  it('keeps the FIRST source, and take consumes the intent exactly once', () => {
    const cancels = createRunCancels();
    cancels.request('r1', { kind: 'operator' });
    cancels.request('r1', { kind: 'parent_terminal', parentRunId: 'p' });

    expect(cancels.pending('r1')).toBe(true);
    expect(cancels.take('r1')).toEqual({ kind: 'operator' });
    expect(cancels.pending('r1')).toBe(false);
    expect(cancels.take('r1')).toBeUndefined();
  });

  it('pokes only a registered pump, and a stale unregister cannot remove a newer pump', () => {
    const cancels = createRunCancels();
    const calls: string[] = [];
    expect(cancels.poke('r1')).toBe(false);

    const unregisterOld = cancels.registerPoke('r1', () => calls.push('old'));
    const unregisterNew = cancels.registerPoke('r1', () => calls.push('new'));
    unregisterOld();
    expect(cancels.poke('r1')).toBe(true);
    unregisterNew();
    expect(cancels.poke('r1')).toBe(false);

    expect(calls).toEqual(['new']);
  });
});
