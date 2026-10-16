import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_ACTIVITY_TIMEOUT_SECONDS,
  LOOKUP_ROW_CAP,
  LOOKUP_ROW_CEILING_MAX,
} from '@autonomy-studio/shared';
import { getWorkspaceSettings, putWorkspaceSettings } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';
import { freshDb } from '../../repo/__tests__/helpers.js';

/**
 * #1600 OR41 C0f — a workspace's own settings: the default activity timeout,
 * and (C7d) the Lookup max rows every Lookup run is held to.
 */
describe('workspace settings routes (#1600 C0f, C7d)', () => {
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

  it('GET reads the 12 h and 1000-row defaults, not stored, before the workspace ever saves', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workspace/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      settings: { defaultActivityTimeoutSeconds: 43_200, lookupMaxRows: 1000 },
      stored: false,
    });
    expect(DEFAULT_ACTIVITY_TIMEOUT_SECONDS).toBe(43_200);
    expect(LOOKUP_ROW_CAP).toBe(1000);
  });

  it('PUT stores a value and a null (default off), and GET reads each back', async () => {
    const set = await put({ defaultActivityTimeoutSeconds: 600, lookupMaxRows: 2500 });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({
      settings: { defaultActivityTimeoutSeconds: 600, lookupMaxRows: 2500 },
      stored: true,
    });

    const off = await put({ defaultActivityTimeoutSeconds: null, lookupMaxRows: 10 });
    expect(off.json()).toEqual({
      settings: { defaultActivityTimeoutSeconds: null, lookupMaxRows: 10 },
      stored: true,
    });
    const read = await app.inject({ method: 'GET', url: '/api/workspace/settings' });
    expect(read.json()).toEqual({
      settings: { defaultActivityTimeoutSeconds: null, lookupMaxRows: 10 },
      stored: true,
    });
  });

  it('PUT refuses a bad, missing or unknown field', async () => {
    const ok = { defaultActivityTimeoutSeconds: 600, lookupMaxRows: 1000 };
    for (const body of [
      { ...ok, defaultActivityTimeoutSeconds: 0 },
      { ...ok, defaultActivityTimeoutSeconds: 1.5 },
      { ...ok, defaultActivityTimeoutSeconds: 31_536_001 },
      { ...ok, defaultActivityTimeoutSeconds: '600' },
      // #1600 C7d — 1 to ADF's 5000, whole, never null.
      { ...ok, lookupMaxRows: 0 },
      { ...ok, lookupMaxRows: 2.5 },
      { ...ok, lookupMaxRows: LOOKUP_ROW_CEILING_MAX + 1 },
      { ...ok, lookupMaxRows: null },
      { ...ok, lookupMaxRows: '10' },
      // Whole document: an omitted field is refused, never written as its default.
      { defaultActivityTimeoutSeconds: 600 },
      { lookupMaxRows: 1000 },
      {},
      { ...ok, ownerId: 'other' },
    ]) {
      const res = await put(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const top = {
      defaultActivityTimeoutSeconds: 31_536_000,
      lookupMaxRows: LOOKUP_ROW_CEILING_MAX,
    };
    expect((await put(top)).statusCode).toBe(200);
    // Nothing refused was written over the last good value.
    const read = await app.inject({ method: 'GET', url: '/api/workspace/settings' });
    expect(read.json().settings).toEqual(top);
  });
});

describe('workspace settings repo (#1600 C0f, C7d)', () => {
  it('keeps each owner to its own row', () => {
    const { db } = freshDb();
    putWorkspaceSettings(db, 'a', { defaultActivityTimeoutSeconds: 60, lookupMaxRows: 200 });
    putWorkspaceSettings(db, 'b', { defaultActivityTimeoutSeconds: null, lookupMaxRows: 3000 });
    putWorkspaceSettings(db, 'a', { defaultActivityTimeoutSeconds: 90, lookupMaxRows: 300 });
    expect(getWorkspaceSettings(db, 'a')).toEqual({
      settings: { defaultActivityTimeoutSeconds: 90, lookupMaxRows: 300 },
      stored: true,
    });
    expect(getWorkspaceSettings(db, 'b').settings).toEqual({
      defaultActivityTimeoutSeconds: null,
      lookupMaxRows: 3000,
    });
    expect(getWorkspaceSettings(db, 'c')).toEqual({
      settings: { defaultActivityTimeoutSeconds: 43_200, lookupMaxRows: 1000 },
      stored: false,
    });
  });
});
