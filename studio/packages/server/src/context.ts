import type { Db } from './repo/types.js';
import type { Supervisor } from './workers/process-supervisor.js';
import type { RunLauncher } from './run/launcher.js';
import type { Scheduler } from './scheduler/scheduler.js';

/**
 * Ambient `FastifyInstance` augmentation for the app-scoped state routes and
 * workers need: the single Drizzle client, the resolved secret-encryption
 * master key, and this app instance's process supervisor. All are decorated
 * exactly once at boot (`index.ts`'s `buildApp`), so route plugins and tests
 * reach them via `fastify.db` / `fastify.masterKey` / `fastify.supervisor`
 * instead of threading them through every plugin's registration options.
 */
declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** The resolved 32-byte secret-encryption master key. Never log this. */
    masterKey: Uint8Array;
    /** This app instance's process supervisor. Its shutdown reap (wired into
     * `onClose`) tree-kills ONLY the subprocesses IT spawned, so two apps in
     * one process never reap each other's `agent_cli` children. */
    supervisor: Supervisor;
    /** This app instance's run launcher: the one place a trigger becomes a
     * run (manual fire + P4 scheduler/webhooks), enforcing "unbound never
     * fires" + concurrency admission. Per-app so its in-flight/queue state
     * never leaks across instances. */
    runLauncher: RunLauncher;
    /** This app instance's scheduler: fires `schedule`-mode triggers on their
     * cron (UTC) through the launcher, gated by run windows. Per-app so its
     * cron set never leaks across instances. Routes call `.sync()` after any
     * trigger write; `buildApp` syncs at boot and `.stop()`s it on close. */
    scheduler: Scheduler;
  }
}
