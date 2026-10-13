import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_ACTIVITY_TIMEOUT_SECONDS } from '@autonomy-studio/shared';
import { getWorkspaceSettings, putWorkspaceSettings } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';
import { freshDb } from '../../repo/__tests__/helpers.js';

/** #1600 OR41 C0f — a workspace's own settings: the default activity timeout. */
describe('workspace settings routes (#1600 C0f)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  function put(payload: unknown) {
    return app.inject({
      method: 'PUT',
      url: '/api/workspace/settings',
      payload: payload as object,
    });
  }

  it('GET reads the 12 h default, not stored, before the workspace ever saves', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workspace/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      settings: { defaultActivityTimeoutSeconds: 43_200 },
      stored: false,
    });
    expect(DEFAULT_ACTIVITY_TIMEOUT_SECONDS).toBe(43_200);
  });

  it('PUT stores a value and a null (default off), and GET reads each back', async () => {
    const set = await put({ defaultActivityTimeoutSeconds: 600 });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ settings: { defaultActivityTimeoutSeconds: 600 }, stored: true });

    const off = await put({ defaultActivityTimeoutSeconds: null });
    expect(off.json()).toEqual({ settings: { defaultActivityTimeoutSeconds: null }, stored: true });
    const read = await app.inject({ method: 'GET', url: '/api/workspace/settings' });
    expect(read.json()).toEqual({
      settings: { defaultActivityTimeoutSeconds: null },
      stored: true,
    });
  });

  it('PUT refuses a non-positive, fractional, over-a-year, missing or unknown field', async () => {
    for (const body of [
      { defaultActivityTimeoutSeconds: 0 },
      { defaultActivityTimeoutSeconds: 1.5 },
      { defaultActivityTimeoutSeconds: 31_536_001 },
      { defaultActivityTimeoutSeconds: '600' },
      {},
      { defaultActivityTimeoutSeconds: 600, ownerId: 'other' },
    ]) {
      const res = await put(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await put({ defaultActivityTimeoutSeconds: 31_536_000 })).statusCode).toBe(200);
    // Nothing refused was written over the last good value.
    const read = await app.inject({ method: 'GET', url: '/api/workspace/settings' });
    expect(read.json().settings.defaultActivityTimeoutSeconds).toBe(31_536_000);
  });
});

describe('workspace settings repo (#1600 C0f)', () => {
  it('keeps each owner to its own row', () => {
    const { db } = freshDb();
    putWorkspaceSettings(db, 'a', { defaultActivityTimeoutSeconds: 60 });
    putWorkspaceSettings(db, 'b', { defaultActivityTimeoutSeconds: null });
    putWorkspaceSettings(db, 'a', { defaultActivityTimeoutSeconds: 90 });
    expect(getWorkspaceSettings(db, 'a')).toEqual({
      settings: { defaultActivityTimeoutSeconds: 90 },
      stored: true,
    });
    expect(getWorkspaceSettings(db, 'b').settings.defaultActivityTimeoutSeconds).toBeNull();
    expect(getWorkspaceSettings(db, 'c')).toEqual({
      settings: { defaultActivityTimeoutSeconds: 43_200 },
      stored: false,
    });
  });
});
