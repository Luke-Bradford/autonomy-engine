import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, SCHEMA_VERSION } from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createTrigger,
} from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

const emptyVersionBody = { params: [], outputs: [], nodes: [], edges: [] };

describe('portability routes (export + import)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/pipelines/:id/export', () => {
    it('exports a version-stamped envelope and it round-trips through POST /api/import', async () => {
      const pipelineRes = await app.inject({
        method: 'POST',
        url: '/api/pipelines',
        payload: { name: 'Exportable' },
      });
      const pipeline = pipelineRes.json();
      const versionRes = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload: emptyVersionBody,
      });
      const version = versionRes.json();

      const exportRes = await app.inject({
        method: 'GET',
        url: `/api/pipelines/${pipeline.id}/export`,
      });
      expect(exportRes.statusCode).toBe(200);
      const envelope = exportRes.json();
      expect(envelope).toEqual({
        schemaVersion: SCHEMA_VERSION,
        catalogVersion: CATALOG_VERSION,
        kind: 'pipeline',
        exportedAt: expect.any(Number),
        data: {
          pipeline,
          versions: [{ ...version }],
          strippedConnectionRefs: [],
        },
      });

      const importRes = await app.inject({ method: 'POST', url: '/api/import', payload: envelope });
      expect(importRes.statusCode).toBe(201);
      const imported = importRes.json();
      expect(imported.kind).toBe('pipeline');
      expect(imported.pipeline.id).not.toBe(pipeline.id);
      expect(imported.pipeline.ownerId).toBe('local');
      expect(imported.versions).toHaveLength(1);
      expect(imported.attention).toEqual([]);
    });

    it('404 for a missing or not-owned pipeline', async () => {
      const missing = await app.inject({
        method: 'GET',
        url: '/api/pipelines/pipe_missing/export',
      });
      expect(missing.statusCode).toBe(404);

      const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'Not mine' });
      const res = await app.inject({ method: 'GET', url: `/api/pipelines/${other.id}/export` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/connections/:id/export', () => {
    it('never leaks a secret and round-trips with requiresSecret through import', async () => {
      const plaintext = 'sk-export-test-plaintext';
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/connections',
        payload: { name: 'Keyed', kind: 'anthropic_api', config: {}, secret: plaintext },
      });
      const created = createRes.json();

      const exportRes = await app.inject({
        method: 'GET',
        url: `/api/connections/${created.id}/export`,
      });
      expect(exportRes.statusCode).toBe(200);
      const envelope = exportRes.json();
      expect(envelope.kind).toBe('connection');
      expect(envelope.data).not.toHaveProperty('secretRef');
      expect(envelope.data.requiresSecret).toBe(true);
      expect(JSON.stringify(envelope)).not.toContain(plaintext);
      expect(JSON.stringify(envelope)).not.toMatch(/secretRef|ciphertext/);

      const importRes = await app.inject({ method: 'POST', url: '/api/import', payload: envelope });
      expect(importRes.statusCode).toBe(201);
      const imported = importRes.json();
      expect(imported.kind).toBe('connection');
      expect(imported.connection.id).not.toBe(created.id);
      expect(imported.connection).not.toHaveProperty('secretRef');
      expect(imported.attention).toEqual([{ type: 'requiresSecret' }]);
      expect(JSON.stringify(imported)).not.toContain(plaintext);
    });

    it('404 for a missing or not-owned connection', async () => {
      const missing = await app.inject({
        method: 'GET',
        url: '/api/connections/conn_missing/export',
      });
      expect(missing.statusCode).toBe(404);

      const other = createConnection(app.db, {
        ownerId: 'someone-else',
        name: 'Not mine',
        kind: 'http',
        config: {},
        secretRef: null,
      });
      const res = await app.inject({ method: 'GET', url: `/api/connections/${other.id}/export` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/triggers/:id/export', () => {
    it('nulls pipelineVersionId + strips webhook.secretRef, and round-trips through import', async () => {
      const pipelineRes = await app.inject({
        method: 'POST',
        url: '/api/pipelines',
        payload: { name: 'For trigger export' },
      });
      const pipeline = pipelineRes.json();
      const versionRes = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload: emptyVersionBody,
      });
      const version = versionRes.json();

      const triggerRes = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          name: 'Webhook',
          pipelineVersionId: version.id,
          params: {},
          mode: 'webhook',
          schedule: null,
          webhook: { secretRef: 'secref_leak_check_marker', idempotencyWindowSeconds: 10 },
          concurrency: { policy: 'queue' },
          runWindows: null,
          enabled: true,
        },
      });
      const trigger = triggerRes.json();

      const exportRes = await app.inject({
        method: 'GET',
        url: `/api/triggers/${trigger.id}/export`,
      });
      expect(exportRes.statusCode).toBe(200);
      const envelope = exportRes.json();
      expect(envelope.kind).toBe('trigger');
      expect(envelope.data.pipelineVersionId).toBeNull();
      expect(envelope.data.webhook).toEqual({ idempotencyWindowSeconds: 10 });
      expect(JSON.stringify(envelope)).not.toContain('secref_leak_check_marker');
      expect(JSON.stringify(envelope)).not.toContain(version.id);

      const importRes = await app.inject({ method: 'POST', url: '/api/import', payload: envelope });
      expect(importRes.statusCode).toBe(201);
      const imported = importRes.json();
      expect(imported.kind).toBe('trigger');
      expect(imported.trigger.id).not.toBe(trigger.id);
      expect(imported.trigger.pipelineVersionId).toBeNull();
      expect(imported.trigger.webhook).toBeNull();
      expect(imported.attention).toEqual(
        expect.arrayContaining([
          { type: 'unboundPipelineVersion' },
          { type: 'requiresWebhookSecret' },
        ]),
      );
      expect(JSON.stringify(imported)).not.toContain('secref_leak_check_marker');
    });

    it('404 for a missing or not-owned trigger', async () => {
      const missing = await app.inject({ method: 'GET', url: '/api/triggers/trig_missing/export' });
      expect(missing.statusCode).toBe(404);

      const otherPipeline = createPipeline(app.db, { ownerId: 'someone-else', name: 'P' });
      const otherVersion = createPipelineVersion(app.db, {
        pipelineId: otherPipeline.id,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      const other = createTrigger(app.db, {
        ownerId: 'someone-else',
        name: 'Not mine',
        pipelineVersionId: otherVersion.id,
        params: {},
        mode: 'manual',
        schedule: null,
        webhook: null,
        concurrency: { policy: 'queue' },
        runWindows: null,
        enabled: true,
      });
      const res = await app.inject({ method: 'GET', url: `/api/triggers/${other.id}/export` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/import', () => {
    it('a malformed envelope is a 400 with a structured, stack-free error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import',
        payload: { not: 'an envelope' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('import_error');
      expect(typeof body.message).toBe('string');
      expect(JSON.stringify(body)).not.toMatch(/\.ts:\d+/);
    });

    it('a schemaVersion newer than this build supports is a 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import',
        payload: {
          schemaVersion: SCHEMA_VERSION + 1,
          catalogVersion: CATALOG_VERSION,
          kind: 'pipeline',
          exportedAt: Date.now(),
          data: {},
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('import_error');
    });

    it('a catalogVersion newer than this build supports is a 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import',
        payload: {
          schemaVersion: SCHEMA_VERSION,
          catalogVersion: CATALOG_VERSION + 1,
          kind: 'connection',
          exportedAt: Date.now(),
          data: {},
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('import_error');
    });

    it('a validation failure inside an otherwise-versioned envelope is a 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import',
        payload: {
          schemaVersion: SCHEMA_VERSION,
          catalogVersion: CATALOG_VERSION,
          kind: 'connection',
          exportedAt: Date.now(),
          data: { totally: 'wrong shape' },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('import_error');
    });
  });
});
