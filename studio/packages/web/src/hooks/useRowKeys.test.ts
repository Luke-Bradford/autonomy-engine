import { describe, expect, it } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { useRowKeys } from './useRowKeys';

/**
 * #1092 — what this hook must guarantee for a React `key` to be worth anything:
 * a surviving row's key does NOT change. Everything below is a way of asking
 * that question, because a key list that reshuffles is exactly as useless as
 * `key={index}` while looking like a fix.
 *
 * The tests drive it through a HOST that owns the row count, rather than
 * through `renderHook`'s `rerender`, because the count and the mutator must
 * move in ONE commit — which is what the editor does (`removeRow` calls
 * `removeAt` and `onChange` in the same handler, and React batches them). A
 * two-step `act` then `rerender` would leave a frame where the key list and the
 * row count disagree, exercising the out-of-band reconciliation instead of the
 * path under test. That is a real distinction and not a testing detail: the two
 * paths deliberately behave differently, and the last two tests cover the other
 * one on purpose.
 */
function useHost(initial: number) {
  const [count, setCount] = useState(initial);
  return { ...useRowKeys(count), setCount };
}
describe('useRowKeys', () => {
  it('mints one key per row, all distinct', () => {
    const { result } = renderHook(() => useRowKeys(3));
    expect(result.current.keys).toHaveLength(3);
    expect(new Set(result.current.keys).size).toBe(3);
  });

  it('keys are unique ACROSS instances, so two mounted editors never collide', () => {
    const a = renderHook(() => useRowKeys(2));
    const b = renderHook(() => useRowKeys(2));
    const overlap = a.result.current.keys.filter((k) => b.result.current.keys.includes(k));
    expect(overlap).toEqual([]);
  });

  it('removeAt drops THAT key and leaves every survivor unchanged', () => {
    const { result } = renderHook(() => useHost(3));
    const [first, second, third] = result.current.keys;

    // The caller removes the middle row and says so; the row count follows in
    // the same commit, as it does in the editor.
    act(() => {
      result.current.removeAt(1);
      result.current.setCount(2);
    });

    // The whole point: `third` did not become `second`. Truncating from the end
    // would have produced `[first, second]` here and quietly renamed row 3.
    expect(result.current.keys).toEqual([first, third]);
    expect(result.current.keys).not.toContain(second);
  });

  it('insertAt puts a NEW key at the position and shifts nothing', () => {
    const { result } = renderHook(() => useHost(2));
    const before = [...result.current.keys];

    act(() => {
      result.current.insertAt(1);
      result.current.setCount(3);
    });

    expect(result.current.keys).toHaveLength(3);
    expect(result.current.keys[0]).toBe(before[0]);
    expect(result.current.keys[2]).toBe(before[1]);
    expect(before).not.toContain(result.current.keys[1]);
  });

  it('a count that GROWS with no insertAt appends fresh keys and disturbs none', () => {
    // The out-of-band path: `TriggersPage` replaces the whole form value when a
    // different trigger is loaded, so no mutator is called and the hook has only
    // the count to go on.
    const { result, rerender } = renderHook(({ n }) => useRowKeys(n), {
      initialProps: { n: 1 },
    });
    const [only] = result.current.keys;

    rerender({ n: 3 });

    expect(result.current.keys).toHaveLength(3);
    expect(result.current.keys[0]).toBe(only);
    expect(new Set(result.current.keys).size).toBe(3);
  });

  it('a count that SHRINKS with no removeAt truncates from the end — the stated degradation', () => {
    const { result, rerender } = renderHook(({ n }) => useRowKeys(n), {
      initialProps: { n: 3 },
    });
    const [first, second] = result.current.keys;

    rerender({ n: 2 });

    // Positional, and deliberately so: with nothing but a count the hook cannot
    // know WHICH row went, and guessing would reintroduce the matching this
    // exists to remove. An out-of-band replacement is a different list, not an
    // edit to this one, so there is no identity worth preserving.
    expect(result.current.keys).toEqual([first, second]);
  });

  it('keys stay unique and stable under StrictMode, whose extra render pass burns the counter', () => {
    // `main.tsx` wraps the whole app in StrictMode, so this is the environment
    // the hook actually runs in — and it is the one place the module-level
    // counter could plausibly bite, because StrictMode invokes the render body
    // twice and `mintRowKey` is called from it. Burning extra counter values is
    // harmless by construction (every call returns a fresh one), but "harmless
    // by construction" is the kind of claim that deserves a test rather than a
    // paragraph. `useGuardedLoad.test.ts` sets the precedent for covering it.
    const { result } = renderHook(() => useHost(3), { wrapper: StrictMode });
    expect(new Set(result.current.keys).size).toBe(3);
    expect(result.current.keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
    const [first, , third] = result.current.keys;

    act(() => {
      result.current.removeAt(1);
      result.current.setCount(2);
    });

    // The property that matters is unchanged by the double render: survivors
    // keep the identity they had.
    expect(result.current.keys).toEqual([first, third]);
  });

  it('the reconciled list is correct on the SAME render, not one frame later', () => {
    // Reconciling in an effect instead would commit one frame in which the key
    // list is shorter than the row list — React would then key a row on
    // `undefined`, which is the bug wearing a fix's clothes.
    const seen: number[] = [];
    const { rerender } = renderHook(
      ({ n }) => {
        seen.push(useRowKeys(n).keys.length);
        return null;
      },
      { initialProps: { n: 2 } },
    );
    rerender({ n: 5 });
    expect(seen).toEqual([2, 5, 5]);
  });
});
