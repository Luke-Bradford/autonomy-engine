import { describe, expect, it } from 'vitest';
import { useCounterStore } from './store';

describe('useCounterStore', () => {
  it('increments count', () => {
    expect(useCounterStore.getState().count).toBe(0);
    useCounterStore.getState().increment();
    expect(useCounterStore.getState().count).toBe(1);
  });
});
