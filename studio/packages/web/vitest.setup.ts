import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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
