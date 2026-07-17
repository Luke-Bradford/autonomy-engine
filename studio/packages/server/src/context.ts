import type { Db } from './repo/types.js';
import type { Supervisor } from './workers/process-supervisor.js';
import type { RunLauncher } from './run/launcher.js';
import type { RunEventBus } from './run/event-bus.js';
import type { ExternalWaitCompleter } from './run/external-wait-service.js';
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
    /** #4 A13 — completes a parked `webhook` node from an inbound callback (the
     * `POST /api/external-wait/:token` route). Per-app, sharing this instance's
     * driver boundary so the completion append + downstream drive run under the same
     * per-run lock as every other drive entry point. */
    externalWaitCompleter: ExternalWaitCompleter;
    /** This app instance's schedule RECONCILER (#5 S5): reconciles the durable
     * `schedule_tick` outbox rows against the DB's schedulable triggers (croner is
     * a next-fire CALCULATOR now, not a firing source — the alarm clock fires).
     * Per-app so its state never leaks across instances. Routes call `.sync()`
     * after any trigger write; `buildApp` syncs at boot and `.stop()`s it on
     * close. */
    scheduler: Scheduler;
    /** This app instance's live-run-monitor event bus (P6). The run driver
     * publishes every appended `run_events` envelope to it; the run-events
     * WebSocket route subscribes per run. Per-app so two instances in one
     * process never cross-deliver each other's run events. */
    runEventBus: RunEventBus;
  }
}
