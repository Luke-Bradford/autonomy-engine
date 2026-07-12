import Fastify from 'fastify';
import { HelloSchema, type Hello } from '@autonomy-studio/shared';
import { openDb } from './db/client.js';
import { appMeta } from './db/schema.js';
import { eq } from 'drizzle-orm';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? 'data/app.sqlite';

export function buildApp() {
  const fastify = Fastify({ logger: true });
  const { db } = openDb(DB_PATH);

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

  fastify.get('/health', async () => ({ ok: true }));

  fastify.get('/api/hello', async (): Promise<Hello> => {
    const hello: Hello = { message: 'hello from @autonomy-studio/server', ts: Date.now() };
    return HelloSchema.parse(hello);
  });

  return fastify;
}

async function main() {
  const app = buildApp();
  await app.listen({ port: PORT, host: HOST });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
