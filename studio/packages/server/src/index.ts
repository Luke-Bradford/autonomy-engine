import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { HelloSchema, type Hello } from '@autonomy-studio/shared';
import { openDb } from './db/client.js';
import { appMeta } from './db/schema.js';
import { resolveMasterKey } from './secrets/secrets.js';
import { reapAllSupervised } from './workers/process-supervisor.js';
import { registerAuthHook } from './auth/principal.js';
import { registerErrorHandler } from './errors.js';
import { connectionsRoutes } from './routes/connections.js';
import { pipelinesRoutes } from './routes/pipelines.js';
import { triggersRoutes } from './routes/triggers.js';
import { runsRoutes } from './routes/runs.js';
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

  // Auth seam + the one global error handler, registered before any route so
  // every request (and every thrown error) is covered.
  registerAuthHook(fastify);
  registerErrorHandler(fastify);

  await fastify.register(connectionsRoutes);
  await fastify.register(pipelinesRoutes);
  await fastify.register(triggersRoutes);
  await fastify.register(runsRoutes);
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
    await reapAllSupervised();
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
