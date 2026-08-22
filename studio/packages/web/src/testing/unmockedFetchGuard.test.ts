import { describe, expect, it } from 'vitest';
import {
  formatUnmockedFetchReport,
  installUnmockedFetchGuard,
  type UnmockedFetch,
} from './unmockedFetchGuard.js';

/**
 * #1229 — the guard's ATTRIBUTION, driven end to end.
 *
 * The ticket asks for "a test that deliberately defers a `fetch` past the
 * `afterEach` boundary and asserts the reported name — otherwise the fix is
 * unfalsifiable". That is what the host seam buys: the boundary is a change in
 * what `currentTestName` returns, so it can be crossed here by moving a variable
 * rather than by racing a real timer, and the assertion is on the real recorder
 * rather than on a formatter fed hand-written records.
 */
function harness(): {
  readonly target: { fetch: typeof fetch };
  readonly guard: { drain: () => UnmockedFetch[] };
  running: string | undefined;
} {
  const target = { fetch: (() => undefined) as unknown as typeof fetch };
  const state = { running: undefined as string | undefined };
  const guard = installUnmockedFetchGuard({
    target,
    currentTestName: () => state.running,
  });
  return {
    target,
    guard,
    get running(): string | undefined {
      return state.running;
    },
    set running(value: string | undefined) {
      state.running = value;
    },
  };
}

/** Call the installed stub, which always throws, and keep going. */
function callFetch(target: { fetch: typeof fetch }, url: string): void {
  expect(() => (target.fetch as (input: string) => never)(url)).toThrow(/unmocked fetch/);
}

describe('installUnmockedFetchGuard', () => {
  it('names the test that MADE the call, not the one that observed it', () => {
    // The defect: a `fetch` reached by async work that outlives its own test's
    // `afterEach` is drained by the NEXT test, and was reported against it — so
    // whoever read the message went to the wrong file. The name now travels with
    // the url, captured when the call was made.
    const h = harness();
    h.running = 'suite > the test that actually leaked';
    callFetch(h.target, '/api/late');
    h.running = 'suite > the innocent next test';

    const report = formatUnmockedFetchReport(h.guard.drain(), h.running);

    expect(report).toContain('/api/late');
    expect(report).toContain('the test that actually leaked');
    // Every record here is foreign, so "not all" would read as if some were the
    // observing test's own. It gets the stronger, true claim.
    expect(report).toContain('none of them by this test');
    expect(report).not.toContain('not all of them');
  });

  it('says "not all" only when the batch is genuinely MIXED', () => {
    // The distinction the count buys: one of these two calls really is the
    // observing test's own, so "not all of them" is the accurate reading.
    const h = harness();
    h.running = 'suite > the test that actually leaked';
    callFetch(h.target, '/api/late');
    h.running = 'suite > the innocent next test';
    callFetch(h.target, '/api/its-own');

    const report = formatUnmockedFetchReport(h.guard.drain(), h.running);

    expect(report).toContain('not all of them by this test');
    expect(report).toContain('/api/late [from: suite > the test that actually leaked]');
    // Its own call carries no `[from: …]`, so the two are told apart at a glance.
    expect(report).toContain('/api/its-own');
    expect(report).not.toContain('/api/its-own [from:');
  });

  it('says nothing about attribution when the call is the observing test s own', () => {
    const h = harness();
    h.running = 'suite > a test that forgot a mock';
    callFetch(h.target, '/api/connections');

    const report = formatUnmockedFetchReport(h.guard.drain(), h.running);

    expect(report).toContain('reached the real');
    expect(report).toContain('/api/connections');
    // No `[from: …]` noise on the ordinary case, which is the common one.
    expect(report).not.toContain('[from:');
  });

  it('names a call made with NO running test rather than implying one', () => {
    // `currentTestName` is genuinely optional — a `fetch` at module load or
    // between two tests has no test to name. Reporting it as the observing
    // test s own would be the same wrong-file failure in a different disguise.
    const h = harness();
    h.running = undefined;
    callFetch(h.target, '/api/at-module-load');
    h.running = 'suite > the first test to run';

    const report = formatUnmockedFetchReport(h.guard.drain(), h.running);

    expect(report).toContain('no running test');
  });

  it('drains, so one offending test cannot fail every test after it', () => {
    const h = harness();
    h.running = 'suite > offender';
    callFetch(h.target, '/api/one');

    expect(h.guard.drain()).toHaveLength(1);
    expect(h.guard.drain()).toEqual([]);
    expect(formatUnmockedFetchReport([], 'suite > innocent')).toBeNull();
  });

  it('reports every recorded url, and records the request s url shape', () => {
    const h = harness();
    h.running = 'suite > many';
    callFetch(h.target, '/api/one');
    expect(() =>
      (h.target.fetch as (input: URL) => never)(new URL('https://example.test/api/two')),
    ).toThrow();
    expect(() =>
      (h.target.fetch as (input: { url: string }) => never)({ url: '/api/three' }),
    ).toThrow();

    const report = formatUnmockedFetchReport(h.guard.drain(), h.running);

    expect(report).toContain('3 time(s)');
    expect(report).toContain('/api/one');
    expect(report).toContain('https://example.test/api/two');
    expect(report).toContain('/api/three');
  });
});
