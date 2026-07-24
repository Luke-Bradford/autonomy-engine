import { rmSync } from 'node:fs';

/**
 * Wipe the throwaway server state so an e2e run never inherits rows (or a
 * master key, or a git working copy) from a previous one.
 *
 * This runs as the FIRST half of the `webServer` command rather than from
 * Playwright's `globalSetup`, because `globalSetup` is NOT early enough:
 * Playwright launches `webServer` first and only then calls `globalSetup`
 * (verified by instrumenting both — the server's master-key boot log printed
 * before the setup function did). A wipe from there deletes the SQLite file out
 * from under the running server's open handle, which on macOS silently keeps
 * the unlinked inode alive: the suite still passes while the "fresh state"
 * guarantee is quietly false. Sequencing it inside the server's own launch
 * command makes the ordering true by construction.
 *
 * It is also NOT at `playwright.config.ts` module scope: every worker process
 * loads the config, so a wipe there would fire mid-suite.
 *
 * `E2E_DATA_DIR` comes from the `webServer.env` block that also sets `DB_PATH`,
 * so there is one definition of the directory being cleared.
 */
const dir = process.env.E2E_DATA_DIR;
if (!dir) {
  // Fail loudly: a silent skip would leave a stale DB and make the next
  // failure look like a flaky test rather than a config regression.
  throw new Error(
    'E2E_DATA_DIR is not set — refusing to start the e2e server against unknown state',
  );
}
rmSync(dir, { recursive: true, force: true });
