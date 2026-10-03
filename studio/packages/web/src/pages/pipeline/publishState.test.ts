import { describe, expect, it } from 'vitest';
import { claimTicket, takeTicket, type ReadSequence } from './publishState';

describe('the publish-state read sequence (#1502)', () => {
  const fresh = (): ReadSequence => ({ issued: 0, applied: 0 });

  it('drops an older answer that lands after a newer one', () => {
    const seq = fresh();
    const open = takeTicket(seq);
    const focus = takeTicket(seq);
    expect(claimTicket(seq, focus)).toBe(true);
    expect(claimTicket(seq, open)).toBe(false);
  });

  it('applies answers that land in the order they were asked', () => {
    const seq = fresh();
    const open = takeTicket(seq);
    const focus = takeTicket(seq);
    expect(claimTicket(seq, open)).toBe(true);
    expect(claimTicket(seq, focus)).toBe(true);
  });

  it('a newer read that FAILED voids nothing: the older answer still lands', () => {
    const seq = fresh();
    const open = takeTicket(seq);
    takeTicket(seq); // the focus read, which fails and claims nothing
    expect(claimTicket(seq, open)).toBe(true);
  });

  it('a write voids every read asked before it', () => {
    const seq = fresh();
    const focus = takeTicket(seq);
    // A publish lands: it is the newest fact.
    expect(claimTicket(seq, takeTicket(seq))).toBe(true);
    expect(claimTicket(seq, focus)).toBe(false);
  });
});
