import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { buildDedupeKey, HelloSchema, type Hello } from '@autonomy-studio/shared';
import { openDb } from './db/client.js';
import { appMeta } from './db/schema.js';
import { resolveMasterKey } from './secrets/secrets.js';
import { createSupervisor } from './workers/process-supervisor.js';
import { drainSettledWakeups, getWakeupByKey } from './repo/scheduled-wakeups.js';
import { drainWebhookDeliveries } from './repo/webhook-deliveries.js';
import { RETENTION_MAX_BATCHES_PER_SWEEP } from './repo/retention.js';
import { reconcileOnBoot } from './run/reconcile.js';
import { createExecutor } from './run/executor.js';
import { createRunDrives } from './run/drives.js';
import { createRunLauncher } from './run/launcher.js';
import { createRunEventBus } from './run/event-bus.js';
import { createScheduler } from './scheduler/scheduler.js';
import { createTumblingService } from './scheduler/tumbling.js';
import { createAlarmClock, type AlarmClock } from './scheduler/alarms.js';
import { createRetryAlarmHandler } from './scheduler/retry-alarm.js';
import { createWaitAlarmHandler } from './scheduler/wait-alarm.js';
import { createExternalWaitAlarmHandler } from './scheduler/external-wait-alarm.js';
import { createContainerTimeoutAlarmHandler } from './scheduler/container-timeout-alarm.js';
import { createScheduleTickHandler } from './scheduler/schedule-tick.js';
import { createLeaseService, LEASE_SWEEP_MS } from './scheduler/lease.js';
import { createConnectorRegistry } from './connectors/registry.js';
import { makeDocResolver } from './run/driver.js';
import { createExternalWaitCompleter } from './run/external-wait-service.js';
import { deriveExternalWaitToken } from './webhooks/external-wait-token.js';
import type { DocResolver, RetryAlarms } from './run/driver.js';
import { registerAuthHook } from './auth/principal.js';
import { registerErrorHandler } from './errors.js';
import { connectionsRoutes } from './routes/connections.js';
import { secretsRoutes } from './routes/secrets.js';
import { pipelinesRoutes } from './routes/pipelines.js';
import { triggersRoutes } from './routes/triggers.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { eventsRoutes } from './routes/events.js';
import { externalWaitRoutes } from './routes/external-wait.js';
import { runsRoutes } from './routes/runs.js';
import { runStreamRoutes } from './routes/run-stream.js';
import { importRoutes } from './routes/import.js';
import './context.js';

export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 8080;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT "${raw}" — must be an integer 1–65535`);
  }
  return n;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Default retention floor for settled `scheduled_wakeups` rows (#464). 30 days is
 * orders of magnitude beyond every current alarm kind's re-arm window (see
 * `pruneSettledWakeups`'s safety argument), so a fired key is never freed while
 * it could still be legitimately re-armed — while keeping the table from growing
 * without bound (an always-on minute-trigger writes ~525k rows/year on its own).
 */
export const DEFAULT_WAKEUP_RETENTION_MS = 30 * MS_PER_DAY;

/**
 * Default retention floor for `webhook_deliveries` rows (#421). Also 30 days —
 * generous ON PURPOSE (see `pruneWebhookDeliveries`'s safety argument): far
 * beyond any real caller's `x-webhook-idempotency-key` retry window, so a key is
 * freed only long after any legitimate retry could arrive, while keeping the
 * append-per-delivery ledger from growing without bound.
 */
export const DEFAULT_WEBHOOK_RETENTION_MS = 30 * MS_PER_DAY;

/**
 * Resolve a `<NAME>_RETENTION_DAYS` env value → the retention window in ms.
 * Empty/undefined = `defaultMs`; `0` = retention DISABLED (never prune); any
 * other value must be a non-negative integer number of days. VALIDATED (not a
 * silent `Number()`) for the same reason `resolvePort` is: a typo that parsed to
 * `NaN` would flow into `before = now - NaN`, make the `< before` predicate
 * always false, and silently disable pruning — the bug persisting invisibly.
 * `envName` names the offending var in the error so a `WEBHOOK_RETENTION_DAYS`
 * typo does not report `WAKEUP_RETENTION_DAYS`.
 */
export function resolveRetentionMs(
  raw: string | undefined,
  opts: { envName: string; defaultMs: number },
): number {
  // `.trim()` so a whitespace-only value falls to the default rather than
  // `Number('   ') === 0` silently DISABLING retention.
  if (raw === undefined || raw.trim() === '') return opts.defaultMs;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `Invalid ${opts.envName} "${raw}" — must be a non-negative integer number of days (0 disables retention)`,
    );
  }
  return n * MS_PER_DAY;
}

const PORT = resolvePort(process.env.PORT);
const HOST = '127.0.0.1';

/**
 * How often the alarm clock sweeps for due wakeups (#5 S1 / #1 F2c).
 *
 * This bounds how LATE an alarm can fire, not how precisely it fires: a retry
 * due at T is delivered somewhere in [T, T + this). One second is far below the
 * 30s floor `retryIntervalSeconds` enforces, so it is invisible against any
 * retry a doc can actually configure, while keeping the tick cheap — the scan is
 * one indexed query per kind, and `listDueWakeups` returns nothing on an idle
 * system.
 */
const ALARM_TICK_MS = 1_000;

/**
 * How often the #464 retention sweep runs. Pure housekeeping (prune settled
 * `scheduled_wakeups` rows past the retention floor), not latency-sensitive —
 * hourly is ample against a 30-day floor. `unref`'d like the alarm timer so a
 * pending sweep never holds the process open at shutdown.
 */
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/**
 * Max request body size. Equal to Fastify's own default (1 MiB) — set
 * EXPLICITLY so the bound is a stated decision, not an inherited default worth
 * re-verifying on every Fastify upgrade. It is the upstream cap the error
 * handler's `ISSUE_LIST_CAP` complements: this bounds what a caller can POST;
 * that bounds what a validation failure of it returns (#496).
 */
const REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;

export interface BuildAppOptions {
  /** Overrides `process.env.DB_PATH` / the built-in default. Call-time only — never a module-eval-time global. */
  dbPath?: string;
  /** Overrides `process.env.AUTONOMY_MASTER_KEY_FILE` for this app instance only; threaded through to `resolveMasterKey`. */
  masterKeyFile?: string;
  /** #464 — overrides `WAKEUP_RETENTION_DAYS`/the 30-day default (ms). `0` disables the wakeup retention sweep. Call-time only, for test isolation + operator override. */
  wakeupRetentionMs?: number;
  /** #421 — overrides `WEBHOOK_RETENTION_DAYS`/the 30-day default (ms). `0` disables the webhook-deliveries retention sweep. Call-time only, for test isolation + operator override. */
  webhookRetentionMs?: number;
  /** #464/#421 — overrides the retention sweep interval (ms) for BOTH sweeps; defaults to `RETENTION_SWEEP_MS`. Tests set it small (or disable a sweep via its `*RetentionMs: 0`) to avoid a real hour-long timer. */
  retentionSweepMs?: number;
}

export async function buildApp(opts?: BuildAppOptions) {
  const fastify = Fastify({ logger: true, bodyLimit: REQUEST_BODY_LIMIT_BYTES });
  const dbPath = opts?.dbPath ?? process.env.DB_PATH ?? 'data/app.sqlite';

  // Resolve the secret-encryption master key ONCE per process, at boot,
  // fail-fast: `resolveMasterKey()` throws a clear error (never falls back
  // to plaintext) if it cannot resolve one, which rejects this promise and
  // must stop the server from ever accepting a request — see
  // `secrets/secrets.ts` for the resolution order (env -> key file ->
  // generate-with-warning) and the module's threat-model doc. When
  // `opts.masterKeyFile` is given (test isolation), it takes precedence over
  // the process-wide `AUTONOMY_MASTER_KEY_FILE` env var so concurrent app
  // instances in the same process never contend over one key file.
  const masterKeyEnv =
    opts?.masterKeyFile !== undefined
      ? { ...process.env, AUTONOMY_MASTER_KEY_FILE: opts.masterKeyFile }
      : process.env;
  const masterKeyResolution = await resolveMasterKey(masterKeyEnv);
  fastify.log.info({ masterKeySource: masterKeyResolution.source }, 'secret master key resolved');
  if (masterKeyResolution.warning) {
    fastify.log.warn(masterKeyResolution.warning);
  }

  const { db } = openDb(dbPath);
  fastify.decorate('db', db);
  fastify.decorate('masterKey', masterKeyResolution.key);

  // One process supervisor PER app instance (not a module global), so this
  // app's graceful-shutdown reap tree-kills ONLY the `agent_cli` subprocesses
  // it spawned — never another app instance's (test isolation, multi-tenant).
  // It is injected into the connector registry below, where the `agent_cli`
  // adapter spawns through it; its `reapAllSupervised()` is wired into shutdown.
  const supervisor = createSupervisor();
  fastify.decorate('supervisor', supervisor);

  // P6 — the live-run-monitor event bus (per app instance, mirroring the
  // supervisor/launcher). The run driver publishes every appended `run_events`
  // envelope to it through the ONE append choke point; the run-events WebSocket
  // route subscribes per run. A subscriber that throws is isolated here (logged,
  // never re-thrown) so a broken tail can never disrupt the driver's pump.
  const runEventBus = createRunEventBus({
    onListenerError: (err, runId) =>
      fastify.log.error({ err, runId }, 'run-event subscriber threw'),
  });
  fastify.decorate('runEventBus', runEventBus);

  // Prove the DB round-trips on boot: upsert a "last_boot" row, then read it
  // straight back.
  const bootKey = 'last_boot';
  const bootValue = new Date().toISOString();
  db.insert(appMeta)
    .values({ key: bootKey, value: bootValue })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: bootValue } })
    .run();
  const bootRow = db.select().from(appMeta).where(eq(appMeta.key, bootKey)).get();
  fastify.log.info({ bootRow }, 'app_meta boot round-trip');

  // The run engine's impure boundary: a doc resolver (a run's immutable
  // pipeline version) + the real connector-facing executor. P3b completes the
  // adapter set (`http`, `anthropic_api`, `openai_api`, `ollama`, `agent_cli`);
  // a Connection kind with no adapter still fails its node loudly at dispatch.
  // #508 — the resolver throws `DocUnresolvableError` (not a plain `Error`) when
  // the immutable version is gone, so the boot reconciler can tell a PERMANENT
  // fault (terminalize) from a transient one (retry next boot). The contract +
  // its test live with `makeDocResolver` in `driver.ts`.
  const resolveDoc: DocResolver = makeDocResolver(db);
  const executor = createExecutor({
    db,
    masterKey: masterKeyResolution.key,
    resolveDoc,
    adapters: createConnectorRegistry({ supervisor }),
  });

  // #5 S1 + #1 F2c: the ALARM CLOCK, and its first consumer — node retries.
  //
  // Construction is MUTUALLY RECURSIVE, and genuinely so rather than by
  // accident: the driver ARMS alarms (a transient failure emits `scheduleRetry`),
  // while the clock's retry handler DRIVES runs (a due alarm re-dispatches the
  // node — whose next failure arms attempt-2's alarm). One lazy `arm` closes the
  // loop, referencing `alarmClock` above its own declaration. Safe rather than
  // clever: `arm` only ever runs long after this function body has returned, so
  // the temporal-dead-zone window is shut before anything could enter it — and a
  // `const` states "assigned exactly once", where a `let` + undefined-check would
  // only pretend to handle a case that cannot happen.
  const alarms: RetryAlarms = {
    arm: (input) => alarmClock.arm(input),
    // Reads the row `arm` would return, from the SAME table `arm` writes (`arm`
    // goes through the clock only to validate the kind + ref; both end at the
    // `scheduled_wakeups` repo). The key is DERIVED from the same input by the
    // same function, so the two halves cannot disagree about an alarm's identity.
    find: (input) => getWakeupByKey(db, input.kind, buildDedupeKey(input)),
  };
  // F2c — the per-run DRIVE LOCK. ONE registry for the whole app, shared by every
  // entry point that can pump a run (the launcher below, and the retry alarm's
  // handler via `driverBoundary`). Sharing it is the entire mechanism: two
  // registries would hand the launcher and the alarm separate locks for the same
  // run, which serializes nothing and is precisely the divergence F2c fixes.
  const drives = createRunDrives();
  // `log` belongs HERE, on the shared boundary, not on the launcher alone. Both
  // drive entry points terminalize a thrown drive through the same
  // `terminalizeInterrupted`, and both report it through `deps.log` — so a
  // boundary without a logger gives the alarm's drive a silent `log?.error(...)`
  // while the launcher's identical fault is reported. That is the very
  // launcher-vs-alarm asymmetry F2c exists to remove, reintroduced by wiring
  // rather than by code.
  // #4 A13 — the webhook external-wait token signer, closed over the master key so
  // the driver derives a parked node's capability token without handling the key
  // itself. The SAME derivation the routes use (`webhooks/external-wait-token.ts`),
  // so the token the driver hashes into the row and the token the owner endpoint
  // re-derives can never disagree. ONE closure, shared by the driver boundary AND
  // the boot reconciler (which RESUMES a `ready` webhook and re-derives the same
  // deterministic token) so the two cannot drift.
  const signExternalWaitToken = (args: { runId: string; nodeId: string; attemptId: string }) =>
    deriveExternalWaitToken(masterKeyResolution.key, args);
  const driverBoundary = {
    db,
    resolveDoc,
    executor,
    alarms,
    drives,
    bus: runEventBus,
    log: fastify.log,
    signExternalWaitToken,
  };
  // #5 S5 — the `schedule_tick` handler moves schedule triggers off in-memory
  // crons onto this same durable clock. Its only extra dependency is the launcher
  // (to SPAWN a run, which the clock's contract forbids inside a fire tx — so it
  // goes via `afterCommit`). The launcher is constructed below, after the clock,
  // so a lazy closure resolves it at fire time — the identical pattern to
  // `alarms.arm` above, and safe for the identical reason (called long after this
  // body returns). The boot `tick()` that could fire it runs AFTER `runLauncher`
  // is assigned (see the reordered wiring below).
  const scheduleTickHandler = createScheduleTickHandler({
    launcher: { fire: (t, fc) => runLauncher.fire(t, fc) },
    log: fastify.log,
  });
  // #5 S7 — the run-lease service: ONE module owning the heartbeat sweep, the
  // `run_lease` handler, and the reclaim (they share the reclaims-in-flight set
  // and the alarm-identity scheme). Same driver boundary as the retry alarm —
  // the reclaim is the second sanctioned caller of the reconcile policy and
  // takes the drive lock through it (`reconcile.ts`'s lock contract).
  const leaseService = createLeaseService(driverBoundary);
  // #5 S9 — the tumbling-window service: the `window_due` handler + reconciler
  // + completion tap + boot reconcile in ONE module (they share the epoch/key
  // scheme — the lease-service precedent). Both seams are lazy closures over
  // values constructed BELOW (`alarmClock.arm` / `runLauncher.fire`), resolved
  // at call time — the identical pattern (and safety argument) as
  // `scheduleTickHandler`'s launcher closure above.
  const tumblingService = createTumblingService({
    db,
    arm: (input) => alarmClock.arm(input),
    launcher: { fire: (t, fc) => runLauncher.fire(t, fc) },
    log: fastify.log,
  });
  const alarmClock: AlarmClock = createAlarmClock({
    db,
    handlers: [
      createRetryAlarmHandler(driverBoundary),
      // #4 A5/A6 — the durable `wait` timer's `node_wait` handler; S1's second
      // node-level alarm consumer, wired here the same way retry's is.
      createWaitAlarmHandler(driverBoundary),
      // #4 A13 — the `webhook` EXPIRY handler (`node_external_wait`); S1's third
      // node-level consumer, appending `externalWait.expired` when no callback arrives.
      createExternalWaitAlarmHandler(driverBoundary),
      // #4 A17 — the `loop` wall-clock timeout handler (`container_timeout`); S1's
      // FIRST container-level consumer, appending `container.timedOut` when a loop
      // outruns its wall-clock bound.
      createContainerTimeoutAlarmHandler(driverBoundary),
      scheduleTickHandler,
      // #5 S7 — `run_lease` expiry → reclaim; S1's first RUN-level consumer.
      leaseService.handler,
      // #5 S9 — `window_due` → tumbling window creation + materialization.
      tumblingService.handler,
      // #5 S11c — `window_retry` → a failed window's retry interval elapsed.
      tumblingService.retryHandler,
    ],
    bus: runEventBus,
    log: fastify.log,
  });

  // P2d/P3 boot reconcile: any `runs` row still `running` could not have
  // survived this restart (the driver is in-process). Freeze runs whose
  // non-idempotent activity was in flight (`interrupted`); re-sync a row whose
  // log already ended terminal; leave a run HELD on a retry to its durable alarm
  // — re-arming that alarm if the HOLD→ARM crash window lost it (F2c/B2); and,
  // WITH a real executor, actually RESUME an idempotent-resumable run.
  //
  // Runs AFTER the clock is constructed, not before: a resumed run can fail
  // transiently mid-reconcile and arm a retry like any other.
  const reconcileReport = await reconcileOnBoot({
    db,
    resolveDoc,
    executor,
    alarms,
    bus: runEventBus,
    // #4 A13 — the reconciler RESUMES a `ready` webhook (a crash between the
    // predecessor event and `externalWait.created` left its `scheduleExternalWait`
    // un-armed), which re-derives the same deterministic token — so it needs the
    // signer too, or `armExternalWait` would throw mid-reconcile. Same closure as
    // the driver boundary above.
    signExternalWaitToken,
  });
  fastify.log.info({ reconcileReport }, 'boot reconcile complete');

  // P4a: the run launcher — the one place a trigger becomes a run (manual fire,
  // the scheduler, and webhooks all reuse it). Per-app, sharing this instance's
  // driver boundary (db + doc resolver + real executor), so "unbound never fires"
  // + concurrency admission are enforced in ONE place. Built BEFORE the boot tick
  // below so the `schedule_tick` handler's lazy `fire` closure can resolve it if
  // a schedule row is already due at boot (#5 S5).
  const runLauncher = createRunLauncher({ ...driverBoundary });
  fastify.decorate('runLauncher', runLauncher);

  // #5 S6a — recover the durable admission QUEUE: admit the oldest `queued` run
  // of every trigger whose slot is now free (the rest cascade on settle). Runs
  // AFTER the awaited reconcile above (so the drain's DB active-count already
  // reflects any run it resumed to `running` — no double-admit past a single
  // slot) and BEFORE the scheduler seeds + the boot tick fires, so a queued fire
  // keeps its place ahead of a fresh schedule fire for the same trigger.
  runLauncher.recoverQueued();

  // #4 A13 — the webhook external-wait COMPLETER: the run-side of
  // `POST /api/external-wait/:token`. Shares the same driver boundary (so the
  // completion append + downstream drive run under the shared per-run lock), exactly
  // as `runLauncher` does.
  fastify.decorate('externalWaitCompleter', createExternalWaitCompleter(driverBoundary));

  // P4b/#5 S5: the schedule RECONCILER — reconciles the durable `schedule_tick`
  // outbox rows against the DB's schedulable triggers (croner is a CALCULATOR
  // now, not a firing source). Per-app; trigger routes re-`sync()` it after any
  // write, and this boot `sync()` SEEDS whatever is already enabled — done BEFORE
  // the boot tick so a freshly-seeded row that is already due fires on that tick.
  const scheduler = createScheduler({ db, arm: alarmClock.arm, log: fastify.log });
  // #5 S9 — ONE trigger-reconcile seam (the composite): trigger routes call
  // `fastify.scheduler.sync()` after every write, and pairing a second
  // `tumblingService.sync()` at each of those call sites by convention is how
  // a future fourth site silently misses one — so the decorator composes both
  // behind the interface the routes already use.
  const triggerReconciler = {
    sync(): void {
      scheduler.sync();
      tumblingService.sync();
    },
    stop(): void {
      scheduler.stop();
      tumblingService.stop();
    },
  };
  fastify.decorate('scheduler', triggerReconciler);
  // #5 S9 — the window-side boot reconcile, in its load-bearing slot: AFTER
  // `reconcileOnBoot` + `recoverQueued` above (run statuses + DB admission
  // counts are settled, so a link-heal reads terminal facts and a re-fire
  // admits against true counts) and BEFORE the seeds + boot tick below (a
  // reconciled window must not race its own `window_due` fire).
  tumblingService.reconcile();
  // #5 S9 — the run-terminal completion tap (window succeeded/failed follows
  // its run). Wired before the boot tick so a window run that terminalizes on
  // that first tick already completes its window.
  const unsubscribeWindowTap = tumblingService.subscribeCompletion(runEventBus);
  triggerReconciler.sync();

  // The clock is a SCAN, not a per-alarm timer: one tick sweeps every due row of
  // every registered kind (retry + schedule ticks). The interval bounds LATENESS
  // (an alarm fires at most this late), which `WakeupDelivery.latenessMs` reports
  // honestly. It is `unref`'d so a pending tick can never hold the process open at
  // shutdown.
  //
  // Started strictly AFTER the reconcile above has been AWAITED, and that order is
  // load-bearing (`reconcile.ts` documents the other half). The boot reconciler
  // pumps runs WITHOUT the drive lock, which is safe only while it is the sole
  // pump source; a 1s tick running against a run it is mid-`pump` on would be the
  // two-concurrent-drives divergence F2c exists to prevent. The launcher +
  // scheduler are constructed above but neither pumps until this tick fires a due
  // row, which is after the awaited reconcile — so the invariant holds.
  // #5 S7 — the BOOT lease sweep, deliberately BEFORE the boot tick below: the
  // tick can fire a stale-lease alarm whose reclaim registers in the drive
  // registry, and a sweep that then observed that registration would stamp
  // `heartbeatAt` (live-drive evidence) off a reclaim — a false liveness record
  // — and renew the lease out from under the reclaim's guard. Running first,
  // it sees only the reconciler's final states: every still-`running` row
  // (held / crash-gap parked) gets its lease alarm ensured or its generation
  // bumped, so the tick right after delivers whatever is genuinely due.
  leaseService.sweep();

  const alarmTimer = setInterval(() => alarmClock.tick(), ALARM_TICK_MS);
  alarmTimer.unref();

  // The recurring heartbeat: renews live-drive runs' leases (superseding their
  // alarms to the new generation) and self-heals lost reclaims. `unref`'d like
  // every other housekeeping timer here.
  const leaseTimer = setInterval(() => leaseService.sweep(), LEASE_SWEEP_MS);
  leaseTimer.unref();

  // A held retry alarm OR a schedule tick may already be due (armed before the
  // crash, the process down past its `dueAt`). Sweep once at boot so it fires now
  // rather than at the first interval — S1's "re-armed at boot", the durable row
  // is what makes it possible. ≤1 late fire for schedule ticks: exactly one row
  // per trigger goes overdue, and the handler arms the next FUTURE occurrence.
  alarmClock.tick();

  // #464/#421 — RETENTION SWEEPS. Two append-only ledgers grow without bound (an
  // always-on schedule/retry writes settled `scheduled_wakeups` forever; every
  // delivery appends a `webhook_deliveries` row). Each is pruned past its OWN
  // configurable floor, in bounded batches drained to a fixpoint, and each is
  // disabled entirely when its retentionMs is 0. Both share the sweep interval.
  const retentionSweepMs = opts?.retentionSweepMs ?? RETENTION_SWEEP_MS;

  // Resolve + VALIDATE both windows FIRST, before arming ANY timer. `label` names
  // the offending option in the error. The env path is already validated by
  // `resolveRetentionMs`, but the `BuildAppOptions` override path is not — so this
  // fail-fast (consistent with port/master-key) covers it. Crucially, ALL throwing
  // happens here: if `WEBHOOK_RETENTION_DAYS` is a typo, we must reject BEFORE the
  // wakeup sweep's interval is armed, because the boot error path runs before the
  // `onClose` teardown is registered — an interval armed then abandoned would keep
  // firing hourly against the open `db`.
  const resolveRetentionWindow = (
    label: 'wakeup' | 'webhook',
    overrideMs: number | undefined,
    envName: string,
    defaultMs: number,
  ): number => {
    const ms = overrideMs ?? resolveRetentionMs(process.env[envName], { envName, defaultMs });
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(
        `Invalid ${label}RetentionMs ${ms} — must be a finite number ≥ 0 (0 disables retention)`,
      );
    }
    return ms;
  };
  const wakeupRetentionMs = resolveRetentionWindow(
    'wakeup',
    opts?.wakeupRetentionMs,
    'WAKEUP_RETENTION_DAYS',
    DEFAULT_WAKEUP_RETENTION_MS,
  );
  const webhookRetentionMs = resolveRetentionWindow(
    'webhook',
    opts?.webhookRetentionMs,
    'WEBHOOK_RETENTION_DAYS',
    DEFAULT_WEBHOOK_RETENTION_MS,
  );
  // A degenerate `retentionSweepMs <= 0` would make `setInterval` fire
  // continuously — only matters once at least one sweep is enabled.
  if (
    (wakeupRetentionMs > 0 || webhookRetentionMs > 0) &&
    (!Number.isFinite(retentionSweepMs) || retentionSweepMs <= 0)
  ) {
    throw new Error(`Invalid retentionSweepMs ${retentionSweepMs} — must be a finite number > 0`);
  }

  // Arm ONE ledger's boot + recurring sweep. Returns the interval timer (or
  // `undefined` when disabled) so `onClose` can clear it. Reached only after all
  // validation above, so no timer is armed before a possible throw.
  const startRetentionSweep = (
    label: 'wakeup' | 'webhook',
    retentionMs: number,
    drain: (before: number, maxBatches?: number) => number,
  ): ReturnType<typeof setInterval> | undefined => {
    if (retentionMs === 0) return undefined;
    // A DB fault here must never crash a headless server — the same structural
    // guard the alarm tick (and cron ticks) use. `maxBatches` bounds a RECURRING
    // sweep's blocking (see `RETENTION_MAX_BATCHES_PER_SWEEP`); the BOOT sweep
    // passes undefined = a one-time full drain before serving.
    const sweep = (maxBatches?: number): void => {
      try {
        const pruned = drain(Date.now() - retentionMs, maxBatches);
        if (pruned > 0) fastify.log.info({ pruned }, `${label} retention: pruned rows`);
      } catch (err) {
        fastify.log.error({ err }, `${label} retention sweep failed`);
      }
    };
    // Full drain at boot (a long downtime — or first deploy of the feature — may
    // have piled up a backlog): synchronous better-sqlite3 blocks boot until
    // clear, but each batch is an index range scan and the server is not yet
    // serving. The recurring interval is BOUNDED so it can never stall in-flight
    // requests if a backlog builds during operation. `unref`'d so a pending
    // interval sweep never holds the process open at shutdown.
    sweep();
    const timer = setInterval(() => sweep(RETENTION_MAX_BATCHES_PER_SWEEP), retentionSweepMs);
    timer.unref();
    return timer;
  };

  // Both sweeps deliberately share the one `retentionSweepMs` interval (hourly
  // housekeeping either way); each is independently disabled via its own
  // `*RetentionMs: 0`. A per-ledger interval is not worth the extra option surface
  // until an instance actually needs to sweep the two ledgers at different rates.
  const wakeupRetentionTimer = startRetentionSweep(
    'wakeup',
    wakeupRetentionMs,
    (before, maxBatches) => drainSettledWakeups(db, { before, maxBatches }),
  );
  const webhookRetentionTimer = startRetentionSweep(
    'webhook',
    webhookRetentionMs,
    (before, maxBatches) => drainWebhookDeliveries(db, { before, maxBatches }),
  );

  // Auth seam + the one global error handler, registered before any route so
  // every request (and every thrown error) is covered.
  registerAuthHook(fastify);
  registerErrorHandler(fastify);

  // @fastify/websocket must be registered before any `{ websocket: true }` route;
  // it applies process-wide (fastify-plugin), so the auth `onRequest` hook above
  // still runs for the upgrade request and stamps `request.principal`.
  await fastify.register(fastifyWebsocket);

  await fastify.register(connectionsRoutes);
  await fastify.register(secretsRoutes);
  await fastify.register(pipelinesRoutes);
  await fastify.register(triggersRoutes);
  await fastify.register(webhooksRoutes);
  await fastify.register(eventsRoutes);
  await fastify.register(externalWaitRoutes);
  await fastify.register(runsRoutes);
  await fastify.register(runStreamRoutes);
  await fastify.register(importRoutes);

  fastify.get('/health', async () => ({ ok: true }));

  // Left in place from the P0 scaffold — harmless, unrelated to the config
  // CRUD surface above; not worth removing in this ticket.
  fastify.get('/api/hello', async (): Promise<Hello> => {
    const hello: Hello = { message: 'hello from @autonomy-studio/server', ts: Date.now() };
    return HelloSchema.parse(hello);
  });

  // The P0b process-supervisor contract: that module is a LIBRARY and
  // deliberately does not own process exit, so the HOST app must call
  // `reapAllSupervised()` from its own graceful-shutdown sequence. Fastify's
  // `onClose` hook runs on a graceful `app.close()` (including the
  // SIGTERM/SIGINT-triggered one wired up in `main()` below) — this is that
  // wiring, so no in-flight `agent_cli` subprocess tree survives a graceful
  // restart/deploy.
  fastify.addHook('onClose', async () => {
    // Stop the scheduler FIRST (no further cron ticks can call the launcher),
    // then the launcher (no new fires, drop the queue) so nothing new spawns
    // while we reap; in-flight background runs are left to settle or be
    // recovered by the boot reconciler on next start. Then tree-kill any
    // in-flight `agent_cli` subprocess.
    triggerReconciler.stop(); // both halves: cron scheduler + tumbling service
    // #5 S9 — drop the window-completion tap so a terminal event after
    // shutdown neither writes nor keeps this instance reachable (the #629
    // launcher-tap discipline; idempotent).
    unsubscribeWindowTap();
    // The alarm clock is stopped alongside the scheduler and for the identical
    // reason: it is the OTHER thing that can start work on a timer. Clearing the
    // interval stops future ticks; `stop()` stops firing.
    //
    // It does NOT refuse ARMS, and that is the point of stopping it this way. A
    // run still settling below can fail transiently and arm a retry like any
    // other; refusing that arm would turn an ordinary transient failure into a
    // DEAD run, killed by nothing but our shutdown timing. The old reason given
    // here — "an alarm nothing will ever serve" — was simply false: the row is
    // DURABLE, and the boot sweep above serves it on the next start.
    clearInterval(alarmTimer);
    alarmClock.stop();
    // #5 S7 — no further heartbeat sweeps (arming/renewing would be pointless
    // work against a closing db; pending lease alarms are durable regardless).
    clearInterval(leaseTimer);
    // #464/#421 — stop both retention sweeps too; they are pure housekeeping, safe
    // to drop instantly (the next boot sweeps again). `undefined` when that sweep
    // is disabled.
    if (wakeupRetentionTimer !== undefined) clearInterval(wakeupRetentionTimer);
    if (webhookRetentionTimer !== undefined) clearInterval(webhookRetentionTimer);
    runLauncher.stop();
    await supervisor.reapAllSupervised();
  });

  return fastify;
}

async function main() {
  const app = await buildApp();
  await app.listen({ port: PORT, host: HOST });

  // Own graceful shutdown: SIGTERM/SIGINT closes Fastify (draining
  // connections and running the `onClose` hook above, which reaps any
  // in-flight supervised subprocess) before the process exits. Per the
  // process-supervisor module's own contract doc, THIS is the "host's own
  // SIGTERM/SIGINT handler" it expects — that module intentionally does not
  // install one itself.
  const shutdown = (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'received shutdown signal, closing gracefully');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
