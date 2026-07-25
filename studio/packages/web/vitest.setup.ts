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

// Unmount React trees between tests so queries never leak across cases.
afterEach(() => {
  cleanup();
});
