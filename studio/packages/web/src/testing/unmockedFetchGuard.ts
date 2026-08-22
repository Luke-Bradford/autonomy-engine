/**
 * #1206's unmocked-`fetch` guard, and #1229's correction to what it REPORTS.
 *
 * A web test that reaches the real `fetch` is doing I/O it believes it stubbed.
 * `routes.test.tsx` carries three separate comments recording the same retrofit
 * (`getWorkspaceGit`, `api/connections`, `api/datasets`) and a fourth was added
 * by hand in the #1124 sweep, because a per-module mock list is closed under
 * nothing: the next page to gain a mount-time call repeats the miss.
 *
 * A THROW ALONE IS NOT ENOUGH, and that is why this records as well. The callers
 * that reach here mostly swallow their own rejection BY DESIGN — `PipelineCanvas`
 * degrades a failed publish-state read to "unread" deliberately — so a stub that
 * only throws is caught by the code under test and the suite stays green, which
 * is precisely the invisibility it replaced, with a louder message nobody sees.
 * The recorded urls are drained in an `afterEach`, where no `catch` in the
 * component tree can reach them.
 *
 * WHY THIS IS A MODULE RATHER THAN TEN LINES OF `vitest.setup.ts`, which is
 * #1229's actual fix. The defect was that the guard blamed the wrong test, and
 * the line carrying it — which test name is captured, and WHEN — lived in the
 * setup file, which is the setup for every web test and therefore the one file
 * no test can drive. Extracting the formatter alone would have left that line
 * uncovered and the fix unfalsifiable. Extracting the whole guard makes it an
 * ordinary unit: install it against a fake global with a stubbed clock on the
 * test name, record under one name, drain under another, assert what it says.
 *
 * A test that legitimately exercises `fetch` (`api/*.test.ts`) replaces the
 * installed stub via `vi.stubGlobal('fetch', …)` and never reaches the recorder
 * — intended: the guard is for the calls nobody meant to make.
 */

/** One unmocked call, and the test that was running when it was MADE. */
export interface UnmockedFetch {
  readonly url: string;
  /**
   * `expect.getState().currentTestName` at push time.
   *
   * `undefined` is a real value, not a defensive one: vitest declares the field
   * optional, and a `fetch` fired at module load or between two tests has no
   * running test to name.
   */
  readonly testName: string | undefined;
}

/** The host facts the guard needs, so a test can supply its own. */
export interface UnmockedFetchGuardHost {
  /** Where the stub is installed. `globalThis` in the setup file. */
  readonly target: { fetch: typeof fetch };
  /** The currently-running test, read afresh on every call. */
  readonly currentTestName: () => string | undefined;
}

/** The installed guard's handle: what it has recorded, and how to take it. */
export interface UnmockedFetchGuard {
  /**
   * Take every record made since the last drain, clearing the buffer.
   *
   * Clearing on the way out is load-bearing rather than tidy: one offending test
   * must not fail every test after it.
   */
  readonly drain: () => UnmockedFetch[];
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return '<unknown>';
}

/**
 * Replace `host.target.fetch` with a stub that records and then throws.
 *
 * The test name is captured HERE, at push time, which is the whole of #1229: the
 * `afterEach` that observes a record is not necessarily the one for the test
 * that made it, so the name has to travel with the url rather than be inferred
 * at the far end.
 */
export function installUnmockedFetchGuard(host: UnmockedFetchGuardHost): UnmockedFetchGuard {
  const records: UnmockedFetch[] = [];
  host.target.fetch = ((input: unknown): never => {
    const url = urlOf(input);
    records.push({ url, testName: host.currentTestName() });
    throw new Error(
      `#1206: unmocked fetch in a web test — ${url}. Mock the api module this call ` +
        `goes through (or stub \`fetch\` for a test that means to exercise it).`,
    );
  }) as unknown as typeof fetch;
  return { drain: () => records.splice(0) };
}

/** How a record's originating test is named when it is not the observing one. */
function attribution(record: UnmockedFetch, observedBy: string | undefined): string {
  if (record.testName === observedBy) return record.url;
  const from = record.testName ?? 'no running test (module load, or between tests)';
  return `${record.url} [from: ${from}]`;
}

/**
 * The message for a drained batch, or `null` when there is nothing to report.
 *
 * WHAT THIS FIXES AND WHAT IT DOES NOT, stated because the difference bounds
 * what #1229 buys. It fixes the MESSAGE, never which test FAILS: the throw still
 * happens in whichever `afterEach` observes the record, so a late `fetch` still
 * reddens the wrong test. It also only helps for the window it can see — a call
 * that lands after test A's `afterEach` but before test B starts records `A` and
 * is now attributed to A. One that lands while B is genuinely running records
 * `B`, which is the same wrong name as before, because at that moment B IS the
 * running test and nothing at this seam knows otherwise. Naming the recording
 * test is the most any push-time capture can honestly claim.
 */
export function formatUnmockedFetchReport(
  records: readonly UnmockedFetch[],
  observedBy: string | undefined,
): string | null {
  if (records.length === 0) return null;
  const detail = records.map((record) => attribution(record, observedBy)).join(', ');
  // COUNTED, not `some`: a batch where EVERY record is foreign is the common
  // shape (one leaked call, drained by the next test), and "not all of them"
  // reads there as if some were the observing test's own. Say "none".
  const foreign = records.filter((record) => record.testName !== observedBy).length;
  const lead =
    foreign === 0
      ? `#1206: this test reached the real \`fetch\` ${records.length} time(s)`
      : `#1206: ${records.length} unmocked \`fetch\` call(s) were recorded, ` +
        `${foreign === records.length ? 'none' : 'not all'} of them by this test — a call ` +
        `whose promise settles after its own test's cleanup lands here`;
  return `${lead}: ${detail}`;
}
