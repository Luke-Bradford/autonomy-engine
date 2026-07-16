import Fastify from 'fastify';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { NotFoundError, registerErrorHandler } from '../errors.js';
import { InvalidPipelineDocError, PipelineHasRunsError } from '../repo/index.js';

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
  // Drives the ZodError branch with an arbitrary issue count: an array of
  // `count` numbers parsed against `z.array(z.string())` yields exactly one
  // "expected string" issue per element.
  app.get<{ Params: { count: string } }>('/manybad/:count', async (request) => {
    const count = Number(request.params.count);
    return z.array(z.string()).parse(new Array(count).fill(0));
  });
  // Drives the InvalidPipelineDocError (`invalid_pipeline_doc`) branch with an
  // arbitrary issue count.
  app.get<{ Params: { count: string } }>('/manydoc/:count', async (request) => {
    const count = Number(request.params.count);
    throw new InvalidPipelineDocError(Array.from({ length: count }, (_v, i) => `issue ${i}`));
  });
  app.post('/echo', async (request) => {
    return request.body;
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
    // A small list is emitted whole, with NO truncation fields — absence of
    // `truncated` is the honest signal that the list is complete (#496).
    expect(body.truncated).toBeUndefined();
    expect(body.totalIssues).toBeUndefined();
    await app.close();
  });

  // #496 — the response `issues[]` is capped so a large doc cannot produce an
  // unbounded body, and the truncation is STATED (never a silent tail drop).
  it('caps a large ZodError issues[] at 100 and states the truncation honestly', async () => {
    const app = buildMinimalApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/manybad/150' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
    expect(body.issues).toHaveLength(100);
    expect(body.truncated).toBe(true);
    expect(body.totalIssues).toBe(150);
    await app.close();
  });

  it('emits exactly 100 ZodError issues with NO truncation fields at the boundary', async () => {
    const app = buildMinimalApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/manybad/100' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.issues).toHaveLength(100);
    expect(body.truncated).toBeUndefined();
    expect(body.totalIssues).toBeUndefined();
    await app.close();
  });

  it('caps a large invalid_pipeline_doc issues[] AND its message, stating the total', async () => {
    const app = buildMinimalApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/manydoc/150' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('invalid_pipeline_doc');
    expect(body.issues).toHaveLength(100);
    expect(body.truncated).toBe(true);
    expect(body.totalIssues).toBe(150);
    // The human `message` is bounded too — capping only `issues[]` while the
    // message re-emits the full join would leave the body O(doc). It names the
    // total and the remainder, and does NOT carry the truncated tail.
    expect(body.message).toContain('150 issues');
    expect(body.message).toContain('…and 50 more');
    expect(body.message).not.toContain('issue 149');
    await app.close();
  });

  it("maps a malformed JSON body to a generic 4xx message, never echoing a fragment of the caller's own body", async () => {
    const app = buildMinimalApp();
    await app.ready();
    const secretLookingFragment = 'not-json-but-looks-like-{"leaked":"fragment_marker_xyz"';
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: secretLookingFragment,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const body = res.json();
    expect(body).toEqual({ error: 'bad_request', message: 'Malformed request' });
    expect(JSON.stringify(body)).not.toContain('fragment_marker_xyz');
    await app.close();
  });
});
