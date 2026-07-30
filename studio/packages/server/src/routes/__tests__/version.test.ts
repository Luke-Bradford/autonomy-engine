import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../__tests__/build-test-app.js';
import { MANIFEST_PATH } from '../version.js';

describe('MANIFEST_PATH', () => {
  // Pins the resolution depth so it cannot silently regress: this file
  // compiles to `dist/routes/version.js`, and the manifest is written at the
  // PACKAGE root (dev) / APP root (packaged install) — two levels up from
  // `routes/`, beside `dist/`, never inside it. A test with a real manifest on
  // disk cannot prove this (task 1 has none, and a wrong-but-still-absent path
  // would look identical to a right-but-absent one via `resolveBuildInfo`'s
  // fallback) — only pinning the string itself catches a future one-level (or
  // three-level) regression.
  it('resolves two levels up from routes/, not one and not three', () => {
    // `__tests__` sits directly inside `routes/`, the same directory
    // `version.ts` lives in — so this file's parent's parent is `version.ts`'s
    // parent, giving an independent computation of the same directory
    // `version.ts` resolves `MANIFEST_PATH` from.
    const routesDir = dirname(dirname(fileURLToPath(import.meta.url)));
    expect(MANIFEST_PATH).toBe(join(routesDir, '..', '..', 'manifest.json'));
    expect(MANIFEST_PATH).not.toBe(join(routesDir, '..', 'manifest.json'));
    expect(MANIFEST_PATH).not.toBe(join(routesDir, '..', '..', '..', 'manifest.json'));
  });
});

describe('GET /api/version', () => {
  it('serves the running build identity', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body.version).toBe('string');
    expect(typeof body.commit).toBe('string');
    expect(typeof body.arch).toBe('string');
    await app.close();
  });

  // The version endpoint must NOT change /health. It is a separate concern with
  // a separate consumer, and a liveness probe that grows fields is one that
  // eventually breaks something that polls it.
  it('leaves /health as a bare liveness probe', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('serves an update status that names the running build', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/update/available' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { current: { version: string }; updateAvailable: boolean };
    expect(typeof body.current.version).toBe('string');
    expect(typeof body.updateAvailable).toBe('boolean');
    await app.close();
  });
});
