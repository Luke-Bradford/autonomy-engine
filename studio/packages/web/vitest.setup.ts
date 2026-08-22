import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// #723 — Testing Library's default `asyncUtilTimeout` is 1,000 ms, which is
// what every bare `findBy*` and `waitFor` gets. The root `pnpm test` runs the
// three packages CONCURRENTLY, and under that CPU contention a jsdom render +
// state settle can exceed a second on tests that pass every time in isolation
// (the reported case was `TriggersPage`'s async form submission). The failure
// is a flaky REQUIRED check, which is the corrosive kind — it trains a reader
// to re-run until green.
//
// Kept strictly BELOW the 20,000 ms `testTimeout` in `vitest.config.ts` so a
// genuinely stuck query still fails with RTL's message (which names the query
// and dumps the DOM) rather than vitest's, which only names the test.
configure({ asyncUtilTimeout: 5_000 });

// jsdom ships no ResizeObserver, but React Flow (`@xyflow/react`) observes its
// container to measure the viewport, so mounting a canvas in a test throws
// without this. A no-op stub is enough — jsdom reports zero-size layout anyway,
// and pixel-accurate sizing is the operator's browser-verify job, not a unit's.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

// Same gap, same reason: jsdom ships no `DOMMatrixReadOnly`, and React Flow's
// `updateNodeInternals` builds one from the viewport's computed `transform` to
// read the current zoom. Without it, any test whose canvas re-measures a node
// throws `not a constructor` from a passive effect — a failure that names jsdom,
// not the code under test.
//
// `m22` (the vertical scale, which RF destructures as `zoom`) is the ONLY field
// read, and 1 is the truthful answer here: jsdom computes no transform, so the
// viewport is unscaled. Deliberately not a fuller matrix — real zoom arithmetic
// belongs to the e2e, which has a browser that can do it.
class DOMMatrixReadOnlyStub {
  readonly m22 = 1;
}
if (!('DOMMatrixReadOnly' in globalThis)) {
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
}

// Third gap of the same kind: jsdom ships no `Document.elementFromPoint`, and
// React Flow's `isValidHandle` calls it to find the handle under the pointer
// (`@xyflow/system` index.js:2569). Without it CLICK-to-connect throws before
// the connection is ever judged, which is why that gesture had no unit coverage
// at all (#941) — and that absence is much of why its missing refusal
// explanation went unnoticed.
//
// `null` is the truthful answer here rather than a convenience: jsdom lays
// everything out at zero size, so there is genuinely no element at any point.
// `isValidHandle` then falls back to the handle it resolved by `data-id`, which
// jsdom DOES answer — so the fallback is what makes the path testable, and
// hit-testing under a real zoom stays the e2e's job.
if (!('elementFromPoint' in Document.prototype)) {
  (Document.prototype as { elementFromPoint?: unknown }).elementFromPoint = (): null => null;
}

// #1206 — a web test that reaches the REAL `fetch` is doing I/O it believes it
// stubbed. `routes.test.tsx` carries three separate comments recording the same
// retrofit (`getWorkspaceGit`, `api/connections`, `api/datasets`) and a fourth
// was added by hand in the #1124 sweep, because a per-module mock list is closed
// under nothing: the next page to gain a mount-time call repeats the miss.
//
// A THROW ALONE IS NOT ENOUGH, and that is why this records as well. The callers
// that reach here mostly swallow their own rejection BY DESIGN — `PipelineCanvas`
// degrades a failed publish-state read to "unread" deliberately — so a stub that
// only throws is caught by the code under test and the suite stays green, which
// is precisely today's invisibility with a louder message nobody sees. The
// recorded URLs are asserted below, where no `catch` in the component tree can
// reach them.
//
// A test that legitimately exercises `fetch` (`api/*.test.ts`) replaces this via
// `vi.stubGlobal('fetch', …)` and never reaches the recorder — intended: the
// guard is for the calls nobody meant to make.
const unmockedFetchUrls: string[] = [];

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return '<unknown>';
}

globalThis.fetch = ((input: unknown): never => {
  const url = urlOf(input);
  unmockedFetchUrls.push(url);
  throw new Error(
    `#1206: unmocked fetch in a web test — ${url}. Mock the api module this call ` +
      `goes through (or stub \`fetch\` for a test that means to exercise it).`,
  );
}) as unknown as typeof fetch;

// Unmount React trees between tests so queries never leak across cases.
//
// The fetch assertion lives in THIS hook rather than its own, after `cleanup()`:
// hook ordering between two separately-registered `afterEach`es is a vitest
// `sequence.hooks` setting, and a guard that fails the run must not depend on
// one. Unmount first (an unmount can itself start a request), then judge what
// was recorded. `splice` clears the list even when it throws, so one offending
// test cannot fail every test after it.
afterEach(() => {
  // `finally`, so a throwing `cleanup()` cannot leave this test's recorded urls
  // behind to be reported against the NEXT one — a failure message naming the
  // wrong test is worse than no message. The check itself stays OUTSIDE the
  // `finally`: a throw in there would replace the cleanup error rather than add
  // to it, and the cleanup failure is the one that explains the other.
  const seen: string[] = [];
  try {
    cleanup();
  } finally {
    seen.push(...unmockedFetchUrls.splice(0));
  }
  if (seen.length > 0) {
    throw new Error(
      `#1206: this test reached the real \`fetch\` ${seen.length} time(s): ${seen.join(', ')}`,
    );
  }
});
