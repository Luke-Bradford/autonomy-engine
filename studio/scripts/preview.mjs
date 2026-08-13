/**
 * The PREVIEW SERVER — one fixed address for looking at the app.
 *
 *   pnpm preview     # build, then serve on http://127.0.0.1:8080
 *
 * The port is HARD-FIXED and deliberately not configurable. An address that
 * moves is not an address: the whole point is that the operator can keep a tab
 * open, and whoever is changing the app can rebuild under it without anyone
 * having to be told a new number. A busy port therefore fails LOUDLY rather than
 * silently drifting to another one — a second server on a different port is
 * exactly how you end up reviewing a stale bundle and calling the design bad.
 *
 * Deliberately NOT `vite dev`. This serves the BUILT bundle through the real
 * Fastify app — the same single-origin shape the container image ships and the
 * same thing the e2e suite drives — so what is on screen is what would deploy.
 * The cost is that a change needs a rebuild; `pnpm preview` does that first.
 *
 * Its own DATA DIR (`data/preview`), so poking at the UI never writes to the
 * developer's real `data/app.sqlite`, and never to the e2e suite's `data/e2e`
 * either — that one is wiped at the start of every test run, which would take
 * the pipeline you were looking at with it. Ambient credentials are cleared for
 * the same reason `playwright.config.ts` clears them: a preview server has no
 * business opening the operator's real key file.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/* THE address. Changing that number is a decision, not a preference — and it
   lives in its own module because this file spawns a server on import. */
import { PREVIEW_HOST as HOST, PREVIEW_PORT } from './previewPort.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data', 'preview');

/**
 * Refuse a busy port by NAME, so the message says what to do about it.
 *
 * This is a MESSAGE, not a lock, and the distinction is worth stating because
 * the check looks like one. There is a window between this probe closing and the
 * server binding in which something else could take the port. Nothing is lost
 * when that happens: the server's own bind fails with `EADDRINUSE` and the
 * process exits, which is the same outcome with a worse message. Holding the
 * socket open and handing the descriptor to the child would close the window and
 * is not worth the machinery in a dev script whose failure mode is "run it
 * again".
 */
async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `port ${String(PREVIEW_PORT)} is already in use.\n` +
                `Something is already serving the preview — reuse it at http://${HOST}:${String(PREVIEW_PORT)}, ` +
                `or stop it first:  lsof -tnP -iTCP:${String(PREVIEW_PORT)} -sTCP:LISTEN | xargs kill`,
            )
          : err,
      );
    });
    probe.once('listening', () => {
      probe.close(resolve);
    });
    probe.listen(PREVIEW_PORT, HOST);
  });
}

await assertPortFree();

const child = spawn(process.execPath, [join(ROOT, 'packages', 'server', 'dist', 'index.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(PREVIEW_PORT),
    HOST,
    DB_PATH: join(DATA_DIR, 'app.sqlite'),
    AUTONOMY_DATA_DIR: DATA_DIR,
    WORKSPACE_GIT_ROOT: join(DATA_DIR, 'git'),
    WEB_ROOT: join(ROOT, 'packages', 'web', 'dist'),
    // `secrets.ts` treats '' as unset — see the header.
    AUTONOMY_MASTER_KEY: '',
    AUTONOMY_MASTER_KEY_FILE: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  },
});

console.log(`\n  preview → http://${HOST}:${String(PREVIEW_PORT)}\n`);
child.on('exit', (code) => process.exit(code ?? 0));
