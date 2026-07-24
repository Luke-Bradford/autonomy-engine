import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, createWorkspaceGit } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G6c-1 — CAS Publish + the `active` pointer projection. Publish is a
 * GIT-MODE concept (a DB-only workspace has no active pointer, it binds-to-latest
 * — that is G6c-2), and only from a version whose git provenance is known. The
 * pointer is a PROJECTION of the `pipeline.published` workspace-audit log, so it
 * is observable via both `GET /api/pipelines/:id/active` and `GET
 * /api/workspace/audit`.
 */
describe('pipelines publish route (#3 G6c-1 — CAS Publish + active pointer)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Put the owner in git mode (a connected repo). Publish requires this. */
  function connectRepo() {
    return createWorkspaceGit(app.db, {
      ownerId: 'local',
      repoUrl: 'https://example.com/repo.git',
      collabBranch: 'main',
      observedCollabHead: 'deadbeef',
      lastFetchAt: Date.now(),
      lastFetchError: null,
    });
  }

  /** A version WITH git provenance — the only kind CAS Publish accepts. */
  function gitVersion(pipelineId: string, commit: string, blob: string) {
    return createPipelineVersion(
      app.db,
      {
        pipelineId,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      },
      {
        sourceCommit: commit,
        sourceBranch: 'main',
        sourceFilePath: 'pipelines/p.json',
        sourceBlobSha: blob,
      },
    );
  }

  /** A version with NO git provenance (authored via the versions route / tests). */
  function plainVersion(pipelineId: string) {
    return createPipelineVersion(app.db, {
      pipelineId,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
  }

  const publish = (id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/pipelines/${id}/publish`, payload: body });
  const active = (id: string) => app.inject({ method: 'GET', url: `/api/pipelines/${id}/active` });
  const audit = () => app.inject({ method: 'GET', url: '/api/workspace/audit' });

  it('publishes a git-provenanced version and projects the active pointer + audit', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = gitVersion(pipeline.id, 'commit1', 'blob1');

    const res = await publish(pipeline.id, { toVersionId: v1.id, expectedActiveVersionId: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      published: true,
      active: { versionId: v1.id, commit: 'commit1', blob: 'blob1' },
    });

    // Observable via the dedicated GET.
    expect((await active(pipeline.id)).json()).toEqual({
      active: { versionId: v1.id, commit: 'commit1', blob: 'blob1' },
    });

    // Observable in the audit log as a pipeline.published event.
    const items = (await audit()).json().items as { payload: Record<string, unknown> }[];
    expect(items).toHaveLength(1);
    const [event] = items;
    expect(event?.payload).toEqual({
      type: 'pipeline.published',
      pipeline: pipeline.resourceId,
      from: null,
      to: v1.id,
      commit: 'commit1',
      blob: 'blob1',
      by: 'local',
    });
  });

  it('GET active is null before any publish (and NOT git-gated)', async () => {
    // No repo connected — a DB-only workspace still answers (null), never 404s.
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const res = await active(pipeline.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: null });
  });

  it('advances the pointer under correct CAS, refuses a stale expectation (409)', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = gitVersion(pipeline.id, 'c1', 'b1');
    const v2 = gitVersion(pipeline.id, 'c2', 'b2');

    expect(
      (await publish(pipeline.id, { toVersionId: v1.id, expectedActiveVersionId: null }))
        .statusCode,
    ).toBe(200);
    // Correct CAS: expect v1 → advance to v2.
    const adv = await publish(pipeline.id, { toVersionId: v2.id, expectedActiveVersionId: v1.id });
    expect(adv.statusCode).toBe(200);
    expect(adv.json().active.versionId).toBe(v2.id);
    expect((await active(pipeline.id)).json().active.versionId).toBe(v2.id);

    // Stale CAS: still expecting v1, but active is now v2 → refuse.
    const stale = await publish(pipeline.id, {
      toVersionId: v1.id,
      expectedActiveVersionId: v1.id,
    });
    expect(stale.statusCode).toBe(409);
    // The active pointer is UNCHANGED by a refused publish.
    expect((await active(pipeline.id)).json().active.versionId).toBe(v2.id);
  });

  it('a first publish with a non-null expectation is stale (nothing is active yet) → 409', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = gitVersion(pipeline.id, 'c1', 'b1');
    const res = await publish(pipeline.id, {
      toVersionId: v1.id,
      expectedActiveVersionId: 'pv_ghost',
    });
    expect(res.statusCode).toBe(409);
    expect((await active(pipeline.id)).json()).toEqual({ active: null });
  });

  it('re-publishing the already-active version is an idempotent no-op (no new event)', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = gitVersion(pipeline.id, 'c1', 'b1');

    expect(
      (await publish(pipeline.id, { toVersionId: v1.id, expectedActiveVersionId: null }))
        .statusCode,
    ).toBe(200);
    const noop = await publish(pipeline.id, { toVersionId: v1.id, expectedActiveVersionId: v1.id });
    expect(noop.statusCode).toBe(200);
    expect(noop.json()).toEqual({
      published: false,
      active: { versionId: v1.id, commit: 'c1', blob: 'b1' },
    });
    // The audit records EFFECT, not attempts — still exactly ONE published event.
    const items = (await audit()).json().items as { payload: { type: string } }[];
    expect(items.filter((e) => e.payload.type === 'pipeline.published')).toHaveLength(1);
  });

  it('refuses publishing a version with no git provenance (409)', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v = plainVersion(pipeline.id);
    const res = await publish(pipeline.id, { toVersionId: v.id, expectedActiveVersionId: null });
    expect(res.statusCode).toBe(409);
  });

  it('refuses publishing with no repo connected (409) — publish is git-mode only', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v = gitVersion(pipeline.id, 'c1', 'b1');
    const res = await publish(pipeline.id, { toVersionId: v.id, expectedActiveVersionId: null });
    expect(res.statusCode).toBe(409);
  });

  it('refuses publishing a version that belongs to a DIFFERENT pipeline (404)', async () => {
    connectRepo();
    const p1 = createPipeline(app.db, { ownerId: 'local', name: 'P1' });
    const p2 = createPipeline(app.db, { ownerId: 'local', name: 'P2' });
    const vOfP2 = gitVersion(p2.id, 'c1', 'b1');
    const res = await publish(p1.id, { toVersionId: vOfP2.id, expectedActiveVersionId: null });
    expect(res.statusCode).toBe(404);
  });

  it('refuses publishing an archived pipeline (409)', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v = gitVersion(pipeline.id, 'c1', 'b1');
    expect(
      (await app.inject({ method: 'POST', url: `/api/pipelines/${pipeline.id}/archive` }))
        .statusCode,
    ).toBe(200);
    const res = await publish(pipeline.id, { toVersionId: v.id, expectedActiveVersionId: null });
    expect(res.statusCode).toBe(409);
  });

  it("refuses publishing another owner's pipeline (404 — authz)", async () => {
    connectRepo();
    const other = createPipeline(app.db, { ownerId: 'other', name: 'Not Yours' });
    const v = gitVersion(other.id, 'c1', 'b1');
    const res = await publish(other.id, { toVersionId: v.id, expectedActiveVersionId: null });
    expect(res.statusCode).toBe(404);
  });

  it('404s publishing a pipeline that does not exist', async () => {
    connectRepo();
    const res = await publish('pipe_ghost', { toVersionId: 'pv_x', expectedActiveVersionId: null });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a body missing expectedActiveVersionId (400 — no fail-open CAS default)', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v = gitVersion(pipeline.id, 'c1', 'b1');
    const res = await publish(pipeline.id, { toVersionId: v.id });
    expect(res.statusCode).toBe(400);
  });
});
