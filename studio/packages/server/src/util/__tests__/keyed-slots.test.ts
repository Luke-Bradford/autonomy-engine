import { describe, expect, it } from 'vitest';
import { KeyedSlots } from '../keyed-slots.js';

describe('KeyedSlots (#1534)', () => {
  it('refuses a key that is held, and frees it on release', () => {
    const slots = new KeyedSlots();
    const release = slots.tryAcquire('a');
    expect(release).not.toBeNull();
    expect(slots.tryAcquire('a')).toBeNull();
    release!();
    expect(slots.tryAcquire('a')).not.toBeNull();
  });

  it('holds each key on its own: one owner busy does not refuse another', () => {
    const slots = new KeyedSlots();
    expect(slots.tryAcquire('a')).not.toBeNull();
    expect(slots.tryAcquire('b')).not.toBeNull();
  });

  it('a second release is a no-op, so it cannot free a later holder', () => {
    const slots = new KeyedSlots();
    const first = slots.tryAcquire('a')!;
    first();
    const second = slots.tryAcquire('a');
    expect(second).not.toBeNull();
    first();
    expect(slots.tryAcquire('a')).toBeNull();
  });
});
