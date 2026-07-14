import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The web package renders React components and talks to `/api` over `fetch`,
 * so its tests run in a `jsdom` DOM and pull in `@testing-library/jest-dom`
 * matchers (`toBeInTheDocument`, etc.) via the setup file. Test files import
 * `describe`/`it`/`expect`/`vi` explicitly (matching `store.test.ts`), so
 * `globals` stays off. `restoreMocks` resets `vi.fn()`/spies between tests.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // `clearMocks` wipes call history between tests (so a `not.toHaveBeenCalled`
    // never sees a prior test's calls); `restoreMocks` restores `vi.spyOn`
    // targets to their originals.
    clearMocks: true,
    restoreMocks: true,
  },
});
