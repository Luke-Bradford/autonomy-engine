import type { Db } from './repo/types.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import type { Supervisor } from './workers/process-supervisor.js';
import type { RunLauncher } from './run/launcher.js';
import type { RunEventBus } from './run/event-bus.js';
import type { ExternalWaitCompleter } from './run/external-wait-service.js';
import type { ReseedService } from './run/reseed.js';
import type { Scheduler } from './scheduler/scheduler.js';
import type { ClaudeAccountQuotaReader } from './quota/claude-quota.js';
import type { CodexAccountQuotaReader } from './quota/codex-quota.js';
import type { LastKnownQuota } from './quota/last-known.js';

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
    /** This app instance's connector registry — the ONE map of adapters, shared
     * by the executor's dispatch path and the #1191 test-connection routes.
     * Decorated (rather than rebuilt per consumer) because the `agent_cli`
     * adapter closes over `supervisor`, so a second registry would hold a
     * second, process-state-carrying instance of it. */
    connectors: ConnectorRegistry;
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
    /** RS2 — starts a rerun-from-failed of a terminal FAILED run (the
     * `POST /api/runs/:id/rerun-from-failed` route): computes the frontier, appends
     * the reseed pair atomically, and drives R2. Per-app, sharing this instance's
     * driver boundary so the reseed append + drive run under the same per-run lock
     * as every other drive entry point. */
    reseedService: ReseedService;
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
    /** #440 (C1) — this app instance's account-quota reader, backing
     * `GET /api/quota` (the build loop's spend-guard source). Per-app so two
     * instances in one process never share its TTL cache. Always decorated: when
     * the surface is disabled it is a reader that reports UNREADABLE. */
    claudeAccountQuota: ClaudeAccountQuotaReader;
    /** #987 — the last account-quota reading that was actually OBTAINED, for the
     * DISPLAY surface only (`GET /api/quota/display`). `null` until one has been.
     * The reader above is untouched by this and still serves no last-good value
     * after a failed read; see `quota/last-known.ts` for why the split is in the
     * contract rather than in the reader. Nothing may GATE on this. */
    claudeAccountQuotaLastKnown: () => LastKnownQuota | null;
    /** #990 — this app instance's CODEX account-quota reader, backing the codex
     * half of `GET /api/quota/display`. `null` when codex is ABSENT from this
     * host, which is why the decoration is nullable rather than falling back to
     * an always-UNREADABLE reader as claude's does: absent and unreadable are
     * different facts on this surface, and only a `null` decoration can express
     * "omit the key" rather than "report a failed read". DISPLAY ONLY — the
     * guard's `GET /api/quota` never reads it. */
    codexAccountQuota: CodexAccountQuotaReader | null;
  }
}
