import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAuthHook } from '../principal.js';

describe('registerAuthHook', () => {
  it('attaches a fixed local principal to every request', async () => {
    const app = Fastify({ logger: false });
    registerAuthHook(app);
    app.get('/whoami', async (request) => request.principal);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/whoami' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'local', ownerId: 'local' });

    await app.close();
  });

  it('attaches the same principal shape across independent requests', async () => {
    const app = Fastify({ logger: false });
    registerAuthHook(app);
    app.get('/whoami', async (request) => request.principal);
    await app.ready();

    const first = await app.inject({ method: 'GET', url: '/whoami' });
    const second = await app.inject({ method: 'GET', url: '/whoami' });
    expect(first.json()).toEqual(second.json());

    await app.close();
  });
});
