import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The DB path must be set before `../index.js` is imported, since it reads
// process.env.DB_PATH at module-eval time to open the database.
const tmpDir = mkdtempSync(join(tmpdir(), 'autonomy-studio-server-test-'));
process.env.DB_PATH = join(tmpDir, 'test.sqlite');

const { buildApp } = await import('../index.js');

describe('server app', () => {
  const app = buildApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /api/hello returns a schema-valid Hello', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hello' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.message).toBe('string');
    expect(typeof body.ts).toBe('number');
  });
});
