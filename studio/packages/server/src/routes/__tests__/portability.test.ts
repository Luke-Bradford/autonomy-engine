import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, SCHEMA_VERSION, canonicalStringify } from '@autonomy-studio/shared';
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { archived: _archived, ...pipelineWithoutArchived } = pipeline;
      // #3 G6b — git provenance is LOCAL derived state, stripped on export like
      // `archived`. A version authored via the API has it all `null`; the export
      // omits it, so the expected envelope version is the DB row MINUS provenance.
      const {
        /* eslint-disable @typescript-eslint/no-unused-vars */
        sourceCommit: _sc,
        sourceBranch: _sb,
        sourceFilePath: _sfp,
        sourceBlobSha: _sbs,
        /* eslint-enable @typescript-eslint/no-unused-vars */
        ...versionWithoutProvenance
      } = version;

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
          // #3 G5a — `archived` is a LOCAL runtime state, NEVER exported (git
          // represents archive as file absence). The export strips it, so the
          // envelope's pipeline is the DB row MINUS `archived`.
          pipeline: pipelineWithoutArchived,
          versions: [versionWithoutProvenance],
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

    // #5 S8 — the event subscription has no secret and round-trips VERBATIM
    // (the #473 silent-drop shape guarded against): the import arrives unbound
    // + disabled (standard), with the subscription intact for re-enable.
    it('round-trips an event trigger subscription through export → import', async () => {
      const triggerRes = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          name: 'Event sub',
          pipelineVersionId: null,
          params: {},
          mode: 'event',
          schedule: null,
          webhook: null,
          event: { name: 'order.created' },
          concurrency: { policy: 'queue' },
          runWindows: null,
          enabled: false,
        },
      });
      expect(triggerRes.statusCode).toBe(201);
      const trigger = triggerRes.json();

      const envelope = (
        await app.inject({ method: 'GET', url: `/api/triggers/${trigger.id}/export` })
      ).json();
      expect(envelope.data.event).toEqual({ name: 'order.created' });

      const importRes = await app.inject({ method: 'POST', url: '/api/import', payload: envelope });
      expect(importRes.statusCode).toBe(201);
      expect(importRes.json().trigger.event).toEqual({ name: 'order.created' });
      expect(importRes.json().trigger.enabled).toBe(false);
    });

    it('forces event:null on a NON-event-mode envelope (cross-field guard the import path must not bypass)', async () => {
      // A hand-crafted envelope with `mode:'schedule'` + an event subscription
      // would otherwise create a row every subsequent PATCH 400s on
      // (`assertEventConsistent` — the route guard `createTrigger` bypasses).
      const exported = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: {
            name: 'Sched',
            pipelineVersionId: null,
            params: {},
            mode: 'schedule',
            schedule: '0 2 * * *',
            webhook: null,
            event: null,
            concurrency: { policy: 'queue' },
            runWindows: null,
            enabled: false,
          },
        })
      ).json();
      const envelope = (
        await app.inject({ method: 'GET', url: `/api/triggers/${exported.id}/export` })
      ).json();
      envelope.data.event = { name: 'crafted' }; // the hand-edit

      const importRes = await app.inject({ method: 'POST', url: '/api/import', payload: envelope });
      expect(importRes.statusCode).toBe(201);
      expect(importRes.json().trigger.event).toBeNull();
      // The imported row is fully patchable (the invariant holds).
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${importRes.json().trigger.id}`,
        payload: { name: 'Renamed after import' },
      });
      expect(patch.statusCode).toBe(200);
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

  // #3 G1 — export bodies are CANONICAL JSON: stable bytes for identical
  // content (the git file writer #3 G3 will reuse this exact serialization).
  describe('#3 G1 — canonical export bodies', () => {
    it('the HTTP body IS canonicalStringify(envelope), served as application/json', async () => {
      const pipelineRes = await app.inject({
        method: 'POST',
        url: '/api/pipelines',
        payload: { name: 'Canonical' },
      });
      const pipeline = pipelineRes.json();
      await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload: emptyVersionBody,
      });

      const res = await app.inject({ method: 'GET', url: `/api/pipelines/${pipeline.id}/export` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      // Byte-level pin: re-canonicalizing the parsed body reproduces the body
      // EXACTLY — proving the wire format is already canonical (sorted keys).
      expect(canonicalStringify(res.json())).toBe(res.body);
    });

    it('the connection and trigger export routes serve canonical bytes too', async () => {
      const connRes = await app.inject({
        method: 'POST',
        url: '/api/connections',
        payload: { name: 'CanonConn', kind: 'http', config: {} },
      });
      const connection = connRes.json();
      const connExport = await app.inject({
        method: 'GET',
        url: `/api/connections/${connection.id}/export`,
      });
      expect(connExport.statusCode).toBe(200);
      expect(connExport.headers['content-type']).toContain('application/json');
      expect(canonicalStringify(connExport.json())).toBe(connExport.body);

      const pipelineRes = await app.inject({
        method: 'POST',
        url: '/api/pipelines',
        payload: { name: 'CanonTrigPipe' },
      });
      const pipeline = pipelineRes.json();
      const versionRes = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload: emptyVersionBody,
      });
      const version = versionRes.json();
      const trigRes = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          name: 'CanonTrig',
          pipelineVersionId: version.id,
          params: {},
          mode: 'manual',
          schedule: null,
          webhook: null,
          concurrency: { policy: 'queue' },
          runWindows: null,
          enabled: false,
        },
      });
      const trigger = trigRes.json();
      const trigExport = await app.inject({
        method: 'GET',
        url: `/api/triggers/${trigger.id}/export`,
      });
      expect(trigExport.statusCode).toBe(200);
      expect(trigExport.headers['content-type']).toContain('application/json');
      expect(canonicalStringify(trigExport.json())).toBe(trigExport.body);
    });

    it('two exports of identical content are byte-identical apart from exportedAt', async () => {
      const pipelineRes = await app.inject({
        method: 'POST',
        url: '/api/pipelines',
        payload: { name: 'Stable' },
      });
      const pipeline = pipelineRes.json();
      await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload: emptyVersionBody,
      });

      const first = await app.inject({
        method: 'GET',
        url: `/api/pipelines/${pipeline.id}/export`,
      });
      const second = await app.inject({
        method: 'GET',
        url: `/api/pipelines/${pipeline.id}/export`,
      });
      const stripStamp = (body: string) => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        delete parsed.exportedAt;
        return canonicalStringify(parsed);
      };
      // `exportedAt` is the ONE volatile field (wall-clock stamp) — the #3 G3
      // git file writer must normalize/omit it or every re-serialize dirties
      // the file (recorded in the spec's G1 annotation).
      expect(stripStamp(first.body)).toBe(stripStamp(second.body));
    });
  });
});
