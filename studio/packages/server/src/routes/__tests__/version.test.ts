import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../__tests__/build-test-app.js';

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
});
