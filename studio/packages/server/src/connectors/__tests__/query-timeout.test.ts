import { describe, expect, it } from 'vitest';
import { DatasetIoError } from '../dataset-io-error.js';
import { queryTimeoutSecondsOf, startQueryClock } from '../query-timeout.js';

describe('startQueryClock (#1600 OR41 C1q-c)', () => {
  it('counts down from the start, and refuses once the limit has passed', () => {
    let t = 1_000;
    const clock = startQueryClock(2, () => t);
    expect(clock.remainingMs()).toBe(2_000);
    t += 1_999;
    expect(clock.remainingMs()).toBe(1);
    t += 1;
    let thrown: unknown;
    try {
      clock.remainingMs();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DatasetIoError);
    expect((thrown as DatasetIoError).kind).toBe('transient');
    expect((thrown as DatasetIoError).message).toBe(
      'the query ran past its query timeout of 2 seconds',
    );
  });

  it('never refuses a query with no limit', () => {
    let t = 0;
    const clock = startQueryClock(null, () => t);
    t += 10 * 24 * 60 * 60 * 1000;
    expect(clock.remainingMs()).toBeNull();
  });
});

describe('queryTimeoutSecondsOf', () => {
  it("reads a query's timeout, and none for a table or a query without one", () => {
    expect(queryTimeoutSecondsOf('query', { sql: 'select 1', queryTimeoutSeconds: 30 })).toBe(30);
    expect(queryTimeoutSecondsOf('query', { sql: 'select 1' })).toBeNull();
    expect(queryTimeoutSecondsOf('table', { table: 't', queryTimeoutSeconds: 30 })).toBeNull();
  });
});
