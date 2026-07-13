import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, resolvePort } from '../index.js';

// `dbPath`/`masterKeyFile` are passed as call-time options to `buildApp()`
// rather than via `process.env` — `process.env` is process-global and
// shared across concurrently-running test files in the same vitest worker,
// so mutating it would let two test files stomp each other's DB path.
const tmpDir = mkdtempSync(join(tmpdir(), 'autonomy-studio-server-test-'));
const dbPath = join(tmpDir, 'test.sqlite');
const masterKeyFile = join(tmpDir, 'master.key');

describe('resolvePort', () => {
  it('defaults to 8080 when unset or empty', () => {
    expect(resolvePort(undefined)).toBe(8080);
    expect(resolvePort('')).toBe(8080);
  });
  it('parses a valid port', () => {
    expect(resolvePort('9099')).toBe(9099);
  });
  it('throws (never NaN) on a non-numeric or out-of-range value', () => {
    expect(() => resolvePort('abc')).toThrow(/Invalid PORT/);
    expect(() => resolvePort('0')).toThrow(/Invalid PORT/);
    expect(() => resolvePort('70000')).toThrow(/Invalid PORT/);
  });
});

describe('server app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ dbPath, masterKeyFile });
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
