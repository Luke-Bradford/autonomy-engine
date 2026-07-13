import Fastify from 'fastify';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { NotFoundError, registerErrorHandler } from '../errors.js';
import { PipelineHasRunsError } from '../repo/index.js';

function buildMinimalApp() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.get('/boom', async () => {
    throw new Error('some internal detail that must never reach the client');
  });
  app.get('/missing', async () => {
    throw new NotFoundError('widget', 'w_1');
  });
  app.get('/conflict', async () => {
    throw new PipelineHasRunsError('pipe_1');
  });
  app.get('/bad', async () => {
    return z.object({ x: z.string() }).parse({});
  });
  return app;
}

describe('registerErrorHandler', () => {
  it('maps an unexpected error to a generic 500 with no leaked detail or stack trace', async () => {
    const app = buildMinimalApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toEqual({ error: 'internal_error', message: 'An unexpected error occurred.' });
    expect(JSON.stringify(body)).not.toContain('some internal detail');
    expect(JSON.stringify(body)).not.toMatch(/at .*:\d+:\d+/);
    await app.close();
  });

  it('maps NotFoundError to 404', async () => {
    const app = buildMinimalApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'widget "w_1" not found' });
    await app.close();
  });

  it('maps PipelineHasRunsError to 409', async () => {
    const app = buildMinimalApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/conflict' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
    await app.close();
  });

  it('maps a ZodError to 400 with structured, value-free issues', async () => {
    const app = buildMinimalApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/bad' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues[0]).toHaveProperty('path');
    expect(body.issues[0]).toHaveProperty('message');
    await app.close();
  });
});
