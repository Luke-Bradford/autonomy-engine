import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CATALOG_VERSION,
  ISSUE_LIST_CAP,
  MAX_BUNDLE_ITEMS,
  SCHEMA_VERSION,
  canonicalStringify,
} from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createTrigger,
} from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #904 — the versions route now requires the save to declare the version it is
 * based on. Every use here mints a FIRST version on a fresh pipeline, so the
 * honest basis is `null` ("I expect no versions yet") rather than a value that
 * opts out of the check.
 */
const emptyVersionBody = {
  params: [],
  outputs: [],
  nodes: [],
  edges: [],
  basedOnVersionId: null,
};

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
      // #1380 — and a top-level pipeline's `folder: null` is omitted, so the
      // export keeps the bytes it had before folders existed.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { archived: _archived, folder: _folder, ...pipelineWithoutArchived } = pipeline;
      // #3 G6b — git provenance is LOCAL derived state, stripped on export like
      // `archived`. A version authored via the API has it all `null`; the export
      // omits it, so the expected envelope version is the DB row MINUS provenance.
      const {
        /* eslint-disable @typescript-eslint/no-unused-vars */
        sourceCommit: _sc,
        sourceBranch: _sb,
        sourceFilePath: _sfp,
        sourceBlobSha: _sbs,
        // #844 V1 — an EMPTY `variables` is omitted from an export, so every
        // pre-V1 file keeps its bytes (spec V-D2).
        variables: _vars,
        // #1 F8a — the same for an empty description and empty annotations.
        description: _desc,
        annotations: _ann,
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

    // #1480 — an import mints versions through the same save gate, so a
    // hand-edited envelope carrying a config the adapter refuses is refused as a
    // whole, naming the node and field, and leaves nothing behind (the import
    // is one transaction). It is not an attention item: those are repairable
    // bindings on a pipeline that DID import; this version could never run.
    it('refuses an envelope whose node config the adapter would refuse, and stores nothing (#1480)', async () => {
      const pipeline = (
        await app.inject({ method: 'POST', url: '/api/pipelines', payload: { name: 'Copier' } })
      ).json();
      const saved = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload: {
          params: [],
          outputs: [],
          nodes: [
            {
              id: 'load',
              type: 'copy',
              config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }], mode: 'append' },
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
          basedOnVersionId: null,
        },
      });
      expect(saved.statusCode).toBe(201);
      const envelope = (
        await app.inject({ method: 'GET', url: `/api/pipelines/${pipeline.id}/export` })
      ).json();
      envelope.data.pipeline.name = 'Copier (imported)';
      envelope.data.versions[0].nodes[0].config.mode = 'truncate'; // the hand-edit

      const before = (await app.inject({ method: 'GET', url: '/api/pipelines' })).json().length;
      const importRes = await app.inject({ method: 'POST', url: '/api/import', payload: envelope });
      expect(importRes.statusCode).toBe(400);
      expect(importRes.json().error).toBe('invalid_pipeline_doc');
      expect(importRes.json().issues.map((i: { message: string }) => i.message)).toEqual([
        expect.stringMatching(/^node 'load': config\.mode: /),
      ]);
      const after = (await app.inject({ method: 'GET', url: '/api/pipelines' })).json().length;
      expect(after).toBe(before);
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

    /**
     * #1183 — the `import_error` body is the ONE reachable path where a
     * `formatZodIssues` string leaves the process: `parseAndUpgradeEnvelope`
     * throws an `ImportError` whose message `errors.ts` sends VERBATIM. Before
     * the cap, an envelope with one issue per node produced a response of
     * O(envelope) — the renderer was the only issue list in the codebase that
     * did not honour `ISSUE_LIST_CAP`.
     *
     * Bounded here means the issue COUNT is capped and the remainder is STATED,
     * not that the body is constant-size: a single issue's path is still
     * caller-controlled (see `summarizeIssueList`). Asserting more than that
     * would claim more than the change delivers.
     */
    it('#1183 caps the issue list in an import_error body and STATES the remainder', async () => {
      const versionCount = ISSUE_LIST_CAP + 40;
      const res = await app.inject({
        method: 'POST',
        url: '/api/import',
        payload: {
          schemaVersion: SCHEMA_VERSION,
          catalogVersion: CATALOG_VERSION,
          kind: 'pipeline',
          exportedAt: Date.now(),
          data: {
            pipeline: {
              id: 'p1',
              resourceId: null,
              ownerId: 'o',
              name: 'P',
              concurrency: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            // Every version is missing every required field, so the issue count
            // grows with the envelope — exactly the shape the cap exists for.
            versions: Array.from({ length: versionCount }, () => ({})),
          },
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('import_error');
      const message: string = body.message;

      // The rendered list is capped...
      const rendered = message.slice(message.indexOf(':') + 1).split('; ');
      expect(rendered.length).toBeLessThanOrEqual(ISSUE_LIST_CAP + 1); // +1 = the tail
      // ...and the drop is STATED, never silent (#473/#496).
      expect(message).toMatch(/…and \d+ more$/);
      // The deepest node index cannot appear: it is past the cap.
      expect(message).not.toContain(`data.versions.${versionCount - 1}.`);
      // ...while the first one still does, so the message is still useful.
      expect(message).toContain('data.versions.0.');
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

  describe('#1586 POST /api/pipelines/export (bundle)', () => {
    async function seedPipeline(name: string, prompt = 'p') {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name });
      createPipelineVersion(app.db, {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes: [{ id: 'n1', type: 'llm_call', config: { prompt }, position: { x: 0, y: 0 } }],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      return pipeline;
    }

    it('serves ONE canonical file that POST /api/import reads back as every pipeline', async () => {
      const a = await seedPipeline(`Bundle A ${Date.now()}`);
      const b = await seedPipeline(`Bundle B ${Date.now()}`);
      const res = await app.inject({
        method: 'POST',
        url: '/api/pipelines/export',
        payload: { ids: [b.id, a.id] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const bundle = res.json();
      expect(res.body).toBe(canonicalStringify(bundle));
      expect(bundle).toMatchObject({ kind: 'bundle', bundleVersion: 1 });
      expect(
        bundle.items.map((e: { data: { pipeline: { name: string } } }) => e.data.pipeline.name),
      ).toEqual([b.name, a.name]);

      const imported = await app.inject({ method: 'POST', url: '/api/import', payload: bundle });
      expect(imported.statusCode).toBe(201);
      const result = imported.json();
      expect(result.kind).toBe('bundle');
      expect(result.items.map((r: { pipeline: { name: string } }) => r.pipeline.name)).toEqual([
        b.name,
        a.name,
      ]);
      expect(
        result.items.every(
          (r: { pipeline: { id: string } }) => ![a.id, b.id].includes(r.pipeline.id),
        ),
      ).toBe(true);
    });

    it('404s the whole request when one id is not the caller’s, exporting nothing', async () => {
      const mine = await seedPipeline(`Mine ${Date.now()}`);
      const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'Not mine' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/pipelines/export',
        payload: { ids: [mine.id, other.id] },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('Not mine');
    });

    it.each([
      ['no ids', { ids: [] }],
      ['too many ids', { ids: Array.from({ length: MAX_BUNDLE_ITEMS + 1 }, (_, i) => `p${i}`) }],
      ['no body field', {}],
    ])('refuses %s as a validation error', async (_label, payload) => {
      const res = await app.inject({ method: 'POST', url: '/api/pipelines/export', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_error');
    });

    it('refuses a bundle larger than an import can read back, rather than serving it', async () => {
      const big = 'x'.repeat(600 * 1024);
      const a = await seedPipeline(`Big A ${Date.now()}`, big);
      const b = await seedPipeline(`Big B ${Date.now()}`, big);
      const one = await app.inject({
        method: 'POST',
        url: '/api/pipelines/export',
        payload: { ids: [a.id] },
      });
      expect(one.statusCode).toBe(200);
      const both = await app.inject({
        method: 'POST',
        url: '/api/pipelines/export',
        payload: { ids: [a.id, b.id] },
      });
      expect(both.statusCode).toBe(400);
      expect(both.json().message).toMatch(
        /^These 2 pipelines export to 1\.\d MiB, over the 1\.0 MiB an import can read back/,
      );
    });

    it('an import body over the limit is a 413 that says so, not "Malformed request"', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ kind: 'bundle', pad: 'x'.repeat(1024 * 1024) }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().message).toBe('The request is larger than the 1 MiB this server accepts.');
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

  // #1143 — the single-file dataset path over HTTP: an export carrying the
  // store's resourceId, and an import that takes the store from `?connectionId=`.
  describe('dataset export + import', () => {
    async function seed(name: string) {
      const conn = (
        await app.inject({
          method: 'POST',
          url: '/api/connections',
          payload: { name: `${name} store`, kind: 'fs', config: {} },
        })
      ).json();
      const dataset = (
        await app.inject({
          method: 'POST',
          url: '/api/datasets',
          payload: {
            name,
            connectionId: conn.id,
            kind: 'delimited',
            config: { path: 'x.csv' },
            columns: [{ name: 'id', type: 'integer', nullable: false }],
          },
        })
      ).json();
      return { conn, dataset };
    }

    it('exports canonical bytes and re-imports into the CHOSEN store', async () => {
      const { conn, dataset } = await seed('RoundTrip');
      const res = await app.inject({ method: 'GET', url: `/api/datasets/${dataset.id}/export` });
      expect(res.statusCode).toBe(200);
      expect(canonicalStringify(res.json())).toBe(res.body);
      expect(res.json().data.connectionId).toBe(conn.resourceId);

      const { conn: other } = await seed('Elsewhere');
      const imported = await app.inject({
        method: 'POST',
        url: `/api/import?connectionId=${other.id}`,
        payload: res.json(),
      });
      expect(imported.statusCode).toBe(201);
      expect(imported.json().kind).toBe('dataset');
      expect(imported.json().dataset.connectionId).toBe(other.id);
      expect(imported.json().dataset.id).not.toBe(dataset.id);
    });

    it('with no ?connectionId= resolves the store by identity', async () => {
      const { conn, dataset } = await seed('ByIdentity');
      const envelope = (
        await app.inject({ method: 'GET', url: `/api/datasets/${dataset.id}/export` })
      ).json();
      const imported = await app.inject({ method: 'POST', url: '/api/import', payload: envelope });
      expect(imported.statusCode).toBe(201);
      expect(imported.json().dataset.connectionId).toBe(conn.id);
    });

    it('refuses a store that belongs to another owner, creating nothing', async () => {
      const { dataset } = await seed('Foreign');
      const envelope = (
        await app.inject({ method: 'GET', url: `/api/datasets/${dataset.id}/export` })
      ).json();
      const theirs = createConnection(app.db, {
        ownerId: 'someone-else',
        name: 'Theirs',
        kind: 'fs',
        config: {},
        secretRef: null,
      });
      const before = (await app.inject({ method: 'GET', url: '/api/datasets' })).json().items
        .length;
      const res = await app.inject({
        method: 'POST',
        url: `/api/import?connectionId=${theirs.id}`,
        payload: envelope,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('no such connection');
      const after = (await app.inject({ method: 'GET', url: '/api/datasets' })).json().items.length;
      expect(after).toBe(before);
    });

    it('refuses a repeated ?connectionId= rather than picking one', async () => {
      const { conn, dataset } = await seed('Repeated');
      const envelope = (
        await app.inject({ method: 'GET', url: `/api/datasets/${dataset.id}/export` })
      ).json();
      const res = await app.inject({
        method: 'POST',
        url: `/api/import?connectionId=${conn.id}&connectionId=${conn.id}`,
        payload: envelope,
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s the export of an unknown dataset', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/datasets/ds_nope/export' });
      expect(res.statusCode).toBe(404);
    });
  });
});
