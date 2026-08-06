import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import {
  appendRunEvent,
  archivePipeline,
  createPipeline,
  createPipelineVersion,
  createRun,
  createTrigger,
  getPipeline,
  getTrigger,
} from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * A minimal version doc. #904 — the POST body also declares the version the
 * save is BASED ON; `null` means "I expect this pipeline to have no versions
 * yet", which is what every use of this constant is (each mints a first
 * version). A second version on the same pipeline must chain — `versionBodyOn`.
 */
const emptyVersionBody = {
  params: [],
  outputs: [],
  nodes: [],
  edges: [],
  basedOnVersionId: null,
};

/** The same doc, based on an existing head — for minting a SECOND version. */
const versionBodyOn = (basedOnVersionId: string) => ({ ...emptyVersionBody, basedOnVersionId });

describe('pipelines routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('full CRUD round-trip for Pipeline, owner-scoped', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'My pipeline' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.ownerId).toBe('local');

    const getRes = await app.inject({ method: 'GET', url: `/api/pipelines/${created.id}` });
    expect(getRes.json()).toEqual(created);

    const listRes = await app.inject({ method: 'GET', url: '/api/pipelines' });
    expect(listRes.json().items.map((p: { id: string }) => p.id)).toContain(created.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${created.id}`,
      payload: { name: 'Renamed' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().name).toBe('Renamed');

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/pipelines/${created.id}` });
    expect(deleteRes.statusCode).toBe(204);

    const missing = await app.inject({ method: 'GET', url: `/api/pipelines/${created.id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('#5 S6b — concurrency cap: create with a cap, PATCH it, clear it with an explicit null, reject invalid caps', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'Capped', concurrency: 2 },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.concurrency).toBe(2);

    // Absent from a PATCH → preserved (partial semantics).
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${created.id}`,
      payload: { name: 'Still capped' },
    });
    expect(rename.json().concurrency).toBe(2);

    // PATCH to a new cap.
    const raise = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${created.id}`,
      payload: { concurrency: 5 },
    });
    expect(raise.statusCode).toBe(200);
    expect(raise.json().concurrency).toBe(5);

    // Explicit null CLEARS the cap (uncapped) — distinct from absent.
    const clear = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${created.id}`,
      payload: { concurrency: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().concurrency).toBeNull();

    // The WRITE boundary refuses a non-positive-integer cap.
    for (const bad of [0, -1, 1.5]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/pipelines/${created.id}`,
        payload: { concurrency: bad },
      });
      expect(res.statusCode).toBe(400);
    }

    // A default create is uncapped.
    const plain = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'Uncapped' },
    });
    expect(plain.json().concurrency).toBeNull();
  });

  it('PipelineVersion: create + immutability (no update/delete route), version increments', async () => {
    const pipelineRes = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'Versioned' },
    });
    const pipeline = pipelineRes.json();

    const v1Res = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipeline.id}/versions`,
      payload: {
        params: [{ name: 'topic', type: 'string', required: true }],
        outputs: [],
        nodes: [],
        edges: [],
        basedOnVersionId: null,
      },
    });
    expect(v1Res.statusCode).toBe(201);
    const v1 = v1Res.json();
    expect(v1.version).toBe(1);
    expect(v1.catalogVersion).toBe(CATALOG_VERSION);

    const v2Res = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipeline.id}/versions`,
      payload: versionBodyOn(v1.id),
    });
    const v2 = v2Res.json();
    expect(v2.version).toBe(2);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/pipelines/${pipeline.id}/versions`,
    });
    expect(listRes.json().map((v: { id: string }) => v.id)).toEqual([v1.id, v2.id]);

    const getV1 = await app.inject({
      method: 'GET',
      url: `/api/pipelines/${pipeline.id}/versions/1`,
    });
    expect(getV1.statusCode).toBe(200);
    expect(getV1.json()).toEqual(v1);

    // No update/delete route exists for a specific version at all — Fastify
    // has no matching route for these methods on this path.
    const patchAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${pipeline.id}/versions/1`,
      payload: {},
    });
    expect([404, 405]).toContain(patchAttempt.statusCode);
    const deleteAttempt = await app.inject({
      method: 'DELETE',
      url: `/api/pipelines/${pipeline.id}/versions/1`,
    });
    expect([404, 405]).toContain(deleteAttempt.statusCode);
  });

  it('deleting a pipeline that has run history is a 409 conflict', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'HasRuns' });
    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipeline.id}/versions`,
      payload: emptyVersionBody,
    });
    const version = versionRes.json();
    createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId: version.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/pipelines/${pipeline.id}` });
    expect(deleteRes.statusCode).toBe(409);
    expect(deleteRes.json().error).toBe('conflict');
  });

  it('GET /api/pipelines/:id/cost rolls up cost across ALL versions of the pipeline, fail-closed', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'CostPipe' });
    const mkVersion = async (basedOnVersionId: string | null) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload: { ...emptyVersionBody, basedOnVersionId },
      });
      return res.json().id as string;
    };
    const v1 = await mkVersion(null);
    const v2 = await mkVersion(v1);

    const mkRun = (pipelineVersionId: string) =>
      createRun(app.db, {
        ownerId: 'local',
        pipelineVersionId,
        triggerId: null,
        parentRunId: null,
        params: {},
      });
    const runV1 = mkRun(v1);
    const runV2 = mkRun(v2);
    mkRun(v1); // a zero-cost run (no metered events) — counts toward runCount only

    const metered = (runId: string, fields: Record<string, unknown>) => ({
      type: 'activity.metered',
      runId,
      nodeId: 'n1',
      attemptId: 'n1#1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      ...fields,
    });
    appendRunEvent(app.db, {
      runId: runV1.id,
      type: 'activity.metered',
      payload: metered(runV1.id, { inputTokens: 100, outputTokens: 100, costEstimate: 0.01 }),
    });
    // runV2 has an unpriced response → runV2 incomplete, rollup incomplete
    appendRunEvent(app.db, {
      runId: runV2.id,
      type: 'activity.metered',
      payload: metered(runV2.id, { inputTokens: 50, outputTokens: 50, costEstimate: 0.005 }),
    });
    appendRunEvent(app.db, {
      runId: runV2.id,
      type: 'activity.metered',
      payload: metered(runV2.id, { inputTokens: 10, outputTokens: 10 }),
    });

    const res = await app.inject({ method: 'GET', url: `/api/pipelines/${pipeline.id}/cost` });
    expect(res.statusCode).toBe(200);
    const rollup = res.json();
    expect(rollup.runCount).toBe(3);
    expect(rollup.responseCount).toBe(3);
    expect(rollup.pricedResponseCount).toBe(2);
    expect(rollup.costUnknownResponseCount).toBe(1);
    expect(rollup.totalCostEstimate).toBeCloseTo(0.015, 10);
    expect(rollup.incompleteRunCount).toBe(1);
    expect(rollup.complete).toBe(false);
  });

  it('GET /api/pipelines/:id/cost 404s for a pipeline owned by someone else', async () => {
    const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'NotMineCost' });
    const res = await app.inject({ method: 'GET', url: `/api/pipelines/${other.id}/cost` });
    expect(res.statusCode).toBe(404);
  });

  it('owner scoping: a pipeline belonging to a different owner is not visible', async () => {
    const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'Not mine' });
    const listRes = await app.inject({ method: 'GET', url: '/api/pipelines' });
    expect(listRes.json().items.map((p: { id: string }) => p.id)).not.toContain(other.id);
    const getRes = await app.inject({ method: 'GET', url: `/api/pipelines/${other.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  describe('#3 G5a — POST /api/pipelines/:id/archive', () => {
    function seedBoundEnabledTrigger(pipelineId: string) {
      const version = createPipelineVersion(app.db, {
        pipelineId,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      return createTrigger(app.db, {
        ownerId: 'local',
        name: 'Nightly',
        pipelineVersionId: version.id,
        params: {},
        mode: 'schedule',
        schedule: '0 2 * * *',
        webhook: null,
        concurrency: { policy: 'skip_if_running' },
        runWindows: null,
        enabled: true,
      });
    }

    it('archives the pipeline, disables its dependent triggers, and drops it off the list', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'ToArchive' });
      const trigger = seedBoundEnabledTrigger(pipeline.id);

      const res = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/archive`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().archived).toBe(true);
      expect(getTrigger(app.db, trigger.id)!.enabled).toBe(false);

      // Dropped from the default list, still reachable by id.
      const listRes = await app.inject({ method: 'GET', url: '/api/pipelines' });
      expect(listRes.json().items.map((p: { id: string }) => p.id)).not.toContain(pipeline.id);
      const getRes = await app.inject({ method: 'GET', url: `/api/pipelines/${pipeline.id}` });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().archived).toBe(true);
    });

    it('is idempotent (a second archive still 200s)', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'ArchiveTwice' });
      const first = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/archive`,
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/archive`,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().archived).toBe(true);
    });

    it('404s for a missing pipeline and for one owned by someone else (authz)', async () => {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/pipelines/pipe_missing/archive',
      });
      expect(missing.statusCode).toBe(404);

      const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'NotMineArchive' });
      const notMine = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${other.id}/archive`,
      });
      expect(notMine.statusCode).toBe(404);
      // Untouched — authz refused before any write (still un-archived).
      expect(getPipeline(app.db, other.id)!.archived).toBe(false);
    });
  });

  /**
   * #907 — archive is a "stop editing this", not merely a "stop running this".
   *
   * The two halves are tested together deliberately, because shipping the
   * refusal without the way back would be a ONE-WAY TRAP: `restorePipeline`
   * existed (#3 G5c) with no HTTP route, reachable only from the git-import
   * apply, so an operator who archived over the API could never author that
   * pipeline again from the app.
   */
  describe('#907 — an archived pipeline refuses a save, and restore is the way back', () => {
    /* Scoped to ONE pipeline's `resourceId`, because the audit log is shared by
       every test in this file (one app, one db) — a bare count of
       `pipeline.restored` would also see the restores the sibling cases above
       performed, and would pass for the wrong reason. */
    const restoreEventsFor = async (resourceId: string): Promise<unknown[]> => {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/audit' });
      return res
        .json()
        .items.map((e: { payload: { type: string; resourceId?: string } }) => e.payload)
        .filter(
          (p: { type: string; resourceId?: string }) =>
            p.type === 'pipeline.restored' && p.resourceId === resourceId,
        );
    };

    const saveOn = async (pipelineId: string, basedOnVersionId: string | null) =>
      app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipelineId}/versions`,
        payload: {
          basedOnVersionId,
          params: [],
          outputs: [],
          nodes: [],
          edges: [],
          catalogVersion: CATALOG_VERSION,
        },
      });

    it('refuses a version write on an archived pipeline (409), minting nothing', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'ArchivedNoSave' });
      await app.inject({ method: 'POST', url: `/api/pipelines/${pipeline.id}/archive` });

      const res = await saveOn(pipeline.id, null);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('conflict');
      // The message must name the remedy, not just the refusal — this string is
      // what the canvas renders verbatim on a failed Save.
      expect(res.json().message).toMatch(/archived/);
      expect(res.json().message).toMatch(/unarchive/i);
      // Nothing was minted: the head is still absent.
      const versions = await app.inject({
        method: 'GET',
        url: `/api/pipelines/${pipeline.id}/versions`,
      });
      expect(versions.json()).toEqual([]);
    });

    it('accepts the same save once the pipeline is restored', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'RestoreThenSave' });
      await app.inject({ method: 'POST', url: `/api/pipelines/${pipeline.id}/archive` });
      expect((await saveOn(pipeline.id, null)).statusCode).toBe(409);

      const restored = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/restore`,
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().archived).toBe(false);

      expect((await saveOn(pipeline.id, null)).statusCode).toBe(201);
      // Back on the default list, which archive had dropped it from.
      const listRes = await app.inject({ method: 'GET', url: '/api/pipelines' });
      expect(listRes.json().items.map((p: { id: string }) => p.id)).toContain(pipeline.id);
    });

    /**
     * The one semantic a restore must NOT quietly reverse. `restorePipeline`'s
     * docblock settles it: re-enabling a trigger is authoring intent, gated by
     * the G7/G8 readiness reconcile — never a side effect of un-archiving. A
     * restore that re-armed a nightly schedule would fire a pipeline the
     * operator had told the system they were done with.
     */
    it('leaves the triggers archive disabled DISABLED', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'RestoreKeepsOff' });
      const version = createPipelineVersion(app.db, {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      const trigger = createTrigger(app.db, {
        ownerId: 'local',
        name: 'Nightly',
        pipelineVersionId: version.id,
        params: {},
        mode: 'schedule',
        schedule: '0 2 * * *',
        webhook: null,
        concurrency: { policy: 'skip_if_running' },
        runWindows: null,
        enabled: true,
      });

      await app.inject({ method: 'POST', url: `/api/pipelines/${pipeline.id}/archive` });
      expect(getTrigger(app.db, trigger.id)!.enabled).toBe(false);
      await app.inject({ method: 'POST', url: `/api/pipelines/${pipeline.id}/restore` });
      expect(getTrigger(app.db, trigger.id)!.enabled).toBe(false);
    });

    it('emits `pipeline.restored` on a REAL state change only, and is idempotent', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'RestoreTwice' });
      await app.inject({ method: 'POST', url: `/api/pipelines/${pipeline.id}/archive` });

      const first = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/restore`,
      });
      expect(first.statusCode).toBe(200);
      expect(await restoreEventsFor(pipeline.resourceId)).toEqual([
        {
          type: 'pipeline.restored',
          resourceId: pipeline.resourceId,
          name: 'RestoreTwice',
          by: 'local',
        },
      ]);

      // Restoring a LIVE pipeline is an idempotent no-op: 200, same shape, and
      // NO second event — the audit records effect, not attempts.
      const second = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/restore`,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().archived).toBe(false);
      expect(await restoreEventsFor(pipeline.resourceId)).toHaveLength(1);
    });

    it('404s for a missing pipeline and for one owned by someone else (authz)', async () => {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/pipelines/pipe_missing/restore',
      });
      expect(missing.statusCode).toBe(404);

      const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'NotMineRestore' });
      archivePipeline(app.db, other.id);
      const notMine = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${other.id}/restore`,
      });
      expect(notMine.statusCode).toBe(404);
      // Untouched — authz refused before any write (still archived).
      expect(getPipeline(app.db, other.id)!.archived).toBe(true);
    });
  });

  it('validation: bad body -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('404 for a missing pipeline / pipeline version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pipelines/pipe_missing' });
    expect(res.statusCode).toBe(404);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'X' });
    const versionRes = await app.inject({
      method: 'GET',
      url: `/api/pipelines/${pipeline.id}/versions/999`,
    });
    expect(versionRes.statusCode).toBe(404);
  });

  /**
   * #904 — the save CAS. Two authors with the same pipeline open both save;
   * without a basis check the second one's version becomes the head carrying
   * NONE of the first's work, and neither is told (versions are immutable, so
   * nothing is destroyed — the first author's save is simply orphaned off the
   * head, invisibly).
   *
   * The basis is REQUIRED and NOT defaulted, so the refusal is total: there is
   * no shape of this request that mints a version without stating what it
   * believes it is advancing from.
   */
  describe('#904 — a version write declares the head it is based on', () => {
    const mkPipeline = (name: string) => createPipeline(app.db, { ownerId: 'local', name });
    const post = async (pipelineId: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/pipelines/${pipelineId}/versions`, payload });

    it('refuses a save based on a version that is no longer the head (the lost update)', async () => {
      const pipeline = mkPipeline('TwoTabs');
      const v1 = (await post(pipeline.id, emptyVersionBody)).json();

      // Author A saves, moving the head to v2.
      const a = await post(pipeline.id, versionBodyOn(v1.id));
      expect(a.statusCode).toBe(201);

      // Author B, whose canvas is still open on v1, saves. Before this ticket
      // this returned 201 and v3 became the head with none of A's work in it.
      const b = await post(pipeline.id, versionBodyOn(v1.id));
      expect(b.statusCode).toBe(409);
      expect(b.json().error).toBe('stale_write');
      // Names the head's NUMBER, so the client can say what it is rebasing onto.
      expect(b.json().message).toContain('v2');

      // And it wrote nothing: the refusal is not a partial mint.
      const list = await app.inject({
        method: 'GET',
        url: `/api/pipelines/${pipeline.id}/versions`,
      });
      expect(list.json().map((v: { version: number }) => v.version)).toEqual([1, 2]);
    });

    it('accepts a save based on the current head', async () => {
      const pipeline = mkPipeline('InStep');
      const v1 = (await post(pipeline.id, emptyVersionBody)).json();
      const v2res = await post(pipeline.id, versionBodyOn(v1.id));
      expect(v2res.statusCode).toBe(201);
      expect(v2res.json().version).toBe(2);
      // And again, chained off the new head — the basis advances with the save.
      expect((await post(pipeline.id, versionBodyOn(v2res.json().id))).statusCode).toBe(201);
    });

    it('accepts a null basis ONLY while the pipeline has no versions', async () => {
      const pipeline = mkPipeline('FirstOnly');
      expect((await post(pipeline.id, emptyVersionBody)).statusCode).toBe(201);

      // The same body a second time now claims "no versions yet", which is
      // false. Refused — a null basis is a real assertion, not a way to opt out.
      const second = await post(pipeline.id, emptyVersionBody);
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe('stale_write');
    });

    it('refuses a body with NO basis at all (400 — no fail-open CAS default)', async () => {
      const pipeline = mkPipeline('NoBasis');
      const res = await post(pipeline.id, { params: [], outputs: [], nodes: [], edges: [] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_error');
    });

    /* BOTH refusal branches, because they build their message separately and
       only one of them was covered: the `head === null` arm is the one that
       receives a basis for a pipeline with no versions, so it is if anything
       the likelier place to reach for the caller's id. An error may name only
       ids the handler resolved and owner-checked itself — never request
       input. */
    it.each([
      ['a pipeline that has versions', true],
      ['a pipeline that has none', false],
    ])('does not echo the caller‘s basis id back in the refusal — %s', async (_label, seed) => {
      const pipeline = mkPipeline(`NoEcho ${String(seed)}`);
      if (seed) await post(pipeline.id, emptyVersionBody);
      const res = await post(pipeline.id, versionBodyOn('pv_<script>alert(1)</script>'));
      expect(res.statusCode).toBe(409);
      expect(res.body).not.toContain('script');
    });

    it('refuses a basis belonging to a DIFFERENT pipeline', async () => {
      const mine = mkPipeline('Mine');
      const theirs = mkPipeline('Theirs');
      const theirV1 = (await post(theirs.id, emptyVersionBody)).json();
      // `mine` has no versions, so the only accepting basis is `null`. A real id
      // from elsewhere is still not this pipeline's head.
      const res = await post(mine.id, versionBodyOn(theirV1.id));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('stale_write');
    });
  });

  it('constraint violation: creating a version for a nonexistent pipeline 404s (owner-scoped lookup fails first)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pipelines/pipe_does_not_exist/versions',
      payload: emptyVersionBody,
    });
    expect(res.statusCode).toBe(404);
  });

  // #444 — the write gate over HTTP. The repo tests own the RULES; these own
  // the wire contract: the status, the code, and the body shape the canvas
  // actually renders.
  describe('POST /versions refuses an invalid doc (#444)', () => {
    async function postDoc(payload: Record<string, unknown>) {
      const pipelineRes = await app.inject({
        method: 'POST',
        url: '/api/pipelines',
        payload: { name: 'Gated' },
      });
      const pipeline = pipelineRes.json();
      const res = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload,
      });
      return { pipeline, res };
    }

    it('400 invalid_pipeline_doc for a forward cycle, and stores NOTHING', async () => {
      const { pipeline, res } = await postDoc({
        ...emptyVersionBody,
        nodes: [
          { id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } },
          { id: 'b', type: 'agent_task', config: {}, position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'a', to: 'b', on: 'success' },
          { id: 'e2', from: 'b', to: 'a', on: 'success' },
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_pipeline_doc');

      const list = await app.inject({
        method: 'GET',
        url: `/api/pipelines/${pipeline.id}/versions`,
      });
      expect(list.json()).toEqual([]);
    });

    /**
     * #859 — a container config field that is DEAD on its kind is refused here.
     *
     * `maxRounds` is a loop's round cap. It had a `foreach`-only refusal, so a
     * `stage` carrying one validated clean and could be minted into an immutable
     * version; it is now one `kind !== 'loop'` rule covering both.
     *
     * This lives at the WIRE contract rather than only in `validate-doc.test.ts`
     * because the mint being refused is the whole reachability story: it is what
     * makes an illegal container field unminttable through EVERY supported path
     * (canvas save, API, portable import, git apply all funnel through
     * `createPipelineVersion`). An e2e used to seed exactly this doc to reach
     * `ContainerPanel`'s repair path, and closing #859 removed that spec's
     * subject rather than breaking it — see #939.
     */
    it('400 invalid_pipeline_doc for a maxRounds on a stage (#859)', async () => {
      const { res } = await postDoc({
        ...emptyVersionBody,
        nodes: [{ id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } }],
        containers: [{ id: 'st', kind: 'stage', children: ['a'], maxRounds: 3 }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_pipeline_doc');
      expect(res.json().issues).toContainEqual({
        message: "container 'st': maxRounds is only meaningful on a loop, not a stage",
      });
    });

    it('carries a `message` AND object-shaped `issues` — the shape the client renders', async () => {
      const { res } = await postDoc({
        ...emptyVersionBody,
        nodes: [
          {
            id: 'a',
            type: 'agent_task',
            config: { prompt: '${params.nope}' },
            position: { x: 0, y: 0 },
          },
        ],
      });
      const body = res.json();

      // REGRESSION PIN on the client contract (`@autonomy-studio/shared`'s
      // `ApiErrorBody`). `messageFromBody` returns `message` when present, and
      // otherwise joins `issues` READ AS OBJECTS (`issue.path`/`issue.message`).
      // So `message` is what the canvas renders today, and the object shape is
      // what keeps `issues` renderable rather than joining to `; ` if `message`
      // were ever dropped. Both halves pinned.
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
      expect(body.issues).toEqual([
        { message: 'nodes.a.config.prompt: ${params.nope} is not a declared param' },
      ]);
    });

    it('still accepts a VALID doc (201) — the gate refuses invalid docs, not all docs', async () => {
      const { res } = await postDoc({
        ...emptyVersionBody,
        nodes: [{ id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } }],
      });
      expect(res.statusCode).toBe(201);
    });
  });
});
