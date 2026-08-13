import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end harness (#713).
 *
 * The unit suites (vitest, per package) run in jsdom, which paints nothing and
 * resolves no CSS custom properties — so the one class of regression they
 * CANNOT see is exactly the one the U0 theme bridge exists to prevent: an
 * `--xy-*` override left pointing at a Fluent token that does not resolve in
 * the scope it was written in, which degrades silently to React Flow's white
 * light default instead of throwing. These specs assert COMPUTED values in a
 * real browser, which is the only place that fact is observable.
 *
 * TOPOLOGY: ONE server — the Fastify app serving the BUILT web bundle from
 * `WEB_ROOT`, i.e. the same single-container shape the P7 image ships
 * (`routes/static-web.ts`). Deliberately NOT `vite dev` + its `/api` proxy:
 *   - one origin, no proxy hop, and no second port to collide on;
 *   - no HMR client, so a strict "zero console errors" assertion is meaningful
 *     rather than a filter over dev-server chatter;
 *   - the bridge arrives as a real `<link>`ed stylesheet (as shipped) rather
 *     than a vite-injected `<style>` tag, so the CSSOM walk in
 *     `theme-bridge.spec.ts` exercises the production path;
 *   - it tests the artifact that actually ships.
 * The cost is that `test:e2e` builds first (see the root script) — accepted.
 * When only the specs changed, `pnpm exec playwright test` skips the rebuild.
 */

/** Studio workspace root — this file's directory. */
const ROOT = import.meta.dirname;

/**
 * Deliberately NOT 8080 (the server's default) and NOT 5173 (vite's): a
 * developer's own studio dev server, or another project's frontend, commonly
 * holds both on this machine. `reuseExistingServer: false` below means a busy
 * port fails loudly instead of silently testing whatever is already listening,
 * so the override exists for the rare genuine clash.
 *
 * `||`, not `??`: an empty `E2E_SERVER_PORT` must fall back, exactly as the
 * server's own `resolvePort` treats `''` as unset. With `??` the base URL would
 * lose its port (i.e. become 80) while the server bound its own default — a
 * 60-second readiness timeout with nothing in the message to explain it.
 */
const PORT = process.env.E2E_SERVER_PORT || '8199';
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Throwaway server state, kept OUT of the developer's real `data/app.sqlite`.
 * `DB_PATH` is the only var that moves the database (`index.ts` resolves it
 * independently of `AUTONOMY_DATA_DIR`, which only locates the master key), so
 * all three roots are pinned explicitly. `data/` is gitignored, and
 * `e2e/reset-state.mjs` wipes this directory as the server's launch command's
 * first step, so a spec never inherits a previous run's rows.
 *
 * Nothing is WRITTEN outside this directory. Reads are a different matter:
 * Playwright merges `webServer.env` OVER `process.env`, so an ambient
 * `AUTONOMY_MASTER_KEY`/`_FILE` would otherwise win over the pinned data dir
 * and the e2e server would open the developer's real key file. Both are
 * cleared below — `secrets.ts` treats `''` as unset — as are the git host
 * credentials, which no spec needs and which should not reach a test server.
 */
/* PER-PORT, so two suites can never share one SQLite file. `reset-state.mjs`
   wipes this directory as the server's first act, so a second run starting while
   a first is mid-flight deletes the database out from under it — the first run
   then fails from wherever it had got to with `ECONNREFUSED`, which reads as
   "the server died" and hides whatever it was actually testing. Measured: two
   concurrent runs in this tree produced 32 and 91 connection-refused failures on
   separate occasions, none of them real.

   Keyed on the PORT because that is already the thing a second run has to change
   to coexist (`E2E_SERVER_PORT`), so one override now buys both isolations. */
const DATA_DIR = join(ROOT, 'data', `e2e-${PORT}`);

export default defineConfig({
  testDir: './e2e',
  /* One worker against one shared server + one SQLite file: the specs create
     real rows, so parallelism would make them observe each other. */
  workers: 1,
  fullyParallel: false,
  /* No retries. A retried e2e failure is a flake being hidden; this suite is a
     gate, and a flaky gate is worse than no gate. */
  retries: 0,
  forbidOnly: !!process.env.CI,
  // In CI also emit the HTML report, which the workflow uploads as an artifact
  // on failure — a failed e2e is otherwise only a log line, and the report
  // carries the trace (`retain-on-failure` below) that explains it.
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /**
         * STATED, because #757 made it matter — and it MUST live here, after the
         * device spread, not in the top-level `use` above. Project-level `use`
         * wins, and `devices['Desktop Chrome']` carries its own
         * `viewport: 1280x720`; a viewport set above is silently overridden, so
         * the config reads as changed while every spec still runs at 1280x720.
         * (Measured that trap directly: a "1600x1000" setting above reported
         * `innerWidth: 1280`.)
         *
         * Why it is now a decision at all: the canvas used to be a fixed 620px
         * whatever the window did, so canvas-spec geometry was independent of
         * the viewport. The editor now fills the content area, which makes the
         * viewport the canvas size — and the canvas COLUMN is what the drag
         * distances in `support/canvasGraph.ts` are really against (a node
         * measures ~240px on screen at the zoom `fitView` picks, so a ~397px
         * column at 1280 wide cannot hold two side by side).
         */
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: {
    // `reset-state.mjs` clears the throwaway data dir immediately BEFORE the
    // server opens it — see that file for why this cannot live in
    // `globalSetup`. `start` then runs the compiled server; the root `test:e2e`
    // script builds shared -> server -> web first (the server imports shared's
    // `dist`, so an unbuilt workspace fails at import and the readiness poll
    // would just time out with an opaque message).
    command: 'node ./e2e/reset-state.mjs && pnpm --filter @autonomy-studio/server start',
    cwd: ROOT,
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    // The server logs a pino line per request, which buries the test output.
    // stderr stays piped so a boot failure is still visible.
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT,
      HOST: '127.0.0.1',
      E2E_DATA_DIR: DATA_DIR,
      DB_PATH: join(DATA_DIR, 'app.sqlite'),
      AUTONOMY_DATA_DIR: DATA_DIR,
      WORKSPACE_GIT_ROOT: join(DATA_DIR, 'git'),
      WEB_ROOT: join(ROOT, 'packages', 'web', 'dist'),
      // Neutralise ambient credentials (see the DATA_DIR note above).
      AUTONOMY_MASTER_KEY: '',
      AUTONOMY_MASTER_KEY_FILE: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
  },
});
