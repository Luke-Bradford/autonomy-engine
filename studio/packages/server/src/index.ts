import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { HelloSchema, type Hello } from '@autonomy-studio/shared';
import { openDb } from './db/client.js';
import { appMeta } from './db/schema.js';
import { resolveMasterKey } from './secrets/secrets.js';
import { createSupervisor } from './workers/process-supervisor.js';
import { getPipelineVersion } from './repo/pipeline-versions.js';
import { reconcileOnBoot } from './run/reconcile.js';
import { createExecutor } from './run/executor.js';
import { createRunLauncher } from './run/launcher.js';
import { createRunEventBus } from './run/event-bus.js';
import { createScheduler } from './scheduler/scheduler.js';
import { createConnectorRegistry } from './connectors/registry.js';
import type { DocResolver } from './run/driver.js';
import { registerAuthHook } from './auth/principal.js';
import { registerErrorHandler } from './errors.js';
import { connectionsRoutes } from './routes/connections.js';
import { pipelinesRoutes } from './routes/pipelines.js';
import { triggersRoutes } from './routes/triggers.js';
import { webhooksRoutes } from './routes/webhooks.js';
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

const PORT = resolvePort(process.env.PORT);
const HOST = '127.0.0.1';

export interface BuildAppOptions {
  /** Overrides `process.env.DB_PATH` / the built-in default. Call-time only — never a module-eval-time global. */
  dbPath?: string;
  /** Overrides `process.env.AUTONOMY_MASTER_KEY_FILE` for this app instance only; threaded through to `resolveMasterKey`. */
  masterKeyFile?: string;
}

export async function buildApp(opts?: BuildAppOptions) {
  const fastify = Fastify({ logger: true });
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
  const resolveDoc: DocResolver = (pipelineVersionId) => {
    const pv = getPipelineVersion(db, pipelineVersionId);
    if (pv === null) {
      throw new Error(`pipeline version '${pipelineVersionId}' not found`);
    }
    return pv;
  };
  const executor = createExecutor({
    db,
    masterKey: masterKeyResolution.key,
    resolveDoc,
    adapters: createConnectorRegistry({ supervisor }),
  });

  // P2d/P3 boot reconcile: any `runs` row still `running` could not have
  // survived this restart (the driver is in-process). Freeze runs whose
  // non-idempotent activity was in flight (`interrupted`); re-sync a row whose
  // log already ended terminal; and now, WITH a real executor, actually RESUME
  // an idempotent-resumable run (previously only deferred). Nothing yet creates
  // a `running` run outside tests (manual fire is P4), so this is a no-op in
  // practice today; it is wired so the recovery path exists from the first boot.
  const reconcileReport = await reconcileOnBoot({ db, resolveDoc, executor, bus: runEventBus });
  fastify.log.info({ reconcileReport }, 'boot reconcile complete');

  // P4a: the run launcher — the one place a trigger becomes a run (manual fire
  // now; the scheduler + webhooks reuse it in P4b/P4c). Per-app, sharing this
  // instance's driver boundary (db + doc resolver + real executor), so
  // "unbound never fires" + concurrency admission are enforced in ONE place.
  const runLauncher = createRunLauncher({
    db,
    resolveDoc,
    executor,
    log: fastify.log,
    bus: runEventBus,
  });
  fastify.decorate('runLauncher', runLauncher);

  // P4b: the scheduler — fires `schedule`-mode triggers on their cron (UTC)
  // through the launcher above, gated by each trigger's run windows. Per-app
  // (mirrors the launcher/supervisor); trigger routes re-`sync()` it after any
  // write, and `sync()` here schedules whatever is already enabled at boot.
  const scheduler = createScheduler({ db, launcher: runLauncher, log: fastify.log });
  fastify.decorate('scheduler', scheduler);
  scheduler.sync();

  // Auth seam + the one global error handler, registered before any route so
  // every request (and every thrown error) is covered.
  registerAuthHook(fastify);
  registerErrorHandler(fastify);

  // @fastify/websocket must be registered before any `{ websocket: true }` route;
  // it applies process-wide (fastify-plugin), so the auth `onRequest` hook above
  // still runs for the upgrade request and stamps `request.principal`.
  await fastify.register(fastifyWebsocket);

  await fastify.register(connectionsRoutes);
  await fastify.register(pipelinesRoutes);
  await fastify.register(triggersRoutes);
  await fastify.register(webhooksRoutes);
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
    scheduler.stop();
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
