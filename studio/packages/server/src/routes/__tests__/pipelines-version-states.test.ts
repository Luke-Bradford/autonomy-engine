import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import {
  appendWorkspaceEvent,
  createPipeline,
  createPipelineVersion,
  createWorkspaceGit,
} from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #1476 OR28 — `GET /api/pipelines/version-states`: the pipelines list's one
 * read of every live pipeline's saved head and active version. It must say
 * what `/active` and the versions list say, pipeline by pipeline.
 */
describe('GET /api/pipelines/version-states (#1476 OR28)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const doc = (pipelineId: string) => ({
    pipelineId,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  });
  const gitVersion = (pipelineId: string, n: number) =>
    createPipelineVersion(app.db, doc(pipelineId), {
      sourceCommit: `commit${String(n)}`,
      sourceBranch: 'main',
      sourceFilePath: 'pipelines/p.json',
      sourceBlobSha: `blob${String(n)}`,
    });
  const publish = (id: string, toVersionId: string, expectedActiveVersionId: string | null) =>
    app.inject({
      method: 'POST',
      url: `/api/pipelines/${id}/publish`,
      payload: { toVersionId, expectedActiveVersionId },
    });
  const states = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pipelines/version-states' });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: { pipelineId: string }[] }).items;
  };
  const stateOf = async (pipelineId: string) =>
    (await states()).find((s) => s.pipelineId === pipelineId);

  function connectRepo() {
    createWorkspaceGit(app.db, {
      ownerId: 'local',
      repoUrl: 'https://example.com/repo.git',
      collabBranch: 'main',
      workingBranch: 'studio/local/work',
      observedCollabHead: 'deadbeef',
      lastFetchAt: Date.now(),
      lastFetchError: null,
    });
  }

  it('names the saved head; a Debug version is never it', async () => {
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const empty = createPipeline(app.db, { ownerId: 'local', name: 'Empty' });
    createPipelineVersion(app.db, doc(p.id));
    createPipelineVersion(app.db, doc(p.id));
    // Debug versions number in their own sequence (debug 1, 2, 3); three of
    // them would read as v3 if the head counted them.
    for (let i = 0; i < 3; i++) createPipelineVersion(app.db, doc(p.id), { debug: true });
    createPipelineVersion(app.db, doc(empty.id), { debug: true });

    expect(await stateOf(p.id)).toEqual({ pipelineId: p.id, latestVersion: 2, active: null });
    expect(await stateOf(empty.id)).toEqual({
      pipelineId: empty.id,
      latestVersion: null,
      active: null,
    });
  });

  it('names the LATEST publish per pipeline, as /active does', async () => {
    connectRepo();
    const a = createPipeline(app.db, { ownerId: 'local', name: 'A' });
    const b = createPipeline(app.db, { ownerId: 'local', name: 'B' });
    const a1 = gitVersion(a.id, 1);
    const a2 = gitVersion(a.id, 2);
    const b1 = gitVersion(b.id, 3);
    gitVersion(b.id, 4);
    expect((await publish(a.id, a2.id, null)).statusCode).toBe(200);
    expect((await publish(b.id, b1.id, null)).statusCode).toBe(200);
    // Back to v1: the newest event wins — not the first, not the highest version.
    expect((await publish(a.id, a1.id, a2.id)).statusCode).toBe(200);

    expect(await stateOf(a.id)).toEqual({
      pipelineId: a.id,
      latestVersion: 2,
      active: { versionId: a1.id, version: 1 },
    });
    expect(await stateOf(b.id)).toEqual({
      pipelineId: b.id,
      latestVersion: 2,
      active: { versionId: b1.id, version: 1 },
    });
    for (const p of [a, b]) {
      const active = (
        await app.inject({ method: 'GET', url: `/api/pipelines/${p.id}/active` })
      ).json() as { active: { versionId: string } };
      expect((await stateOf(p.id)) as unknown).toMatchObject({
        active: { versionId: active.active.versionId },
      });
    }
  });

  it("a pointer naming another pipeline's version is not given that version's number", async () => {
    const a = createPipeline(app.db, { ownerId: 'local', name: 'A' });
    const b = createPipeline(app.db, { ownerId: 'local', name: 'B' });
    createPipelineVersion(app.db, doc(a.id));
    const bv = createPipelineVersion(app.db, doc(b.id));
    appendWorkspaceEvent(app.db, 'local', {
      type: 'pipeline.published',
      pipeline: a.resourceId,
      from: null,
      to: bv.id,
      commit: 'c',
      blob: 'b',
      by: 'local',
    });
    expect(await stateOf(a.id)).toEqual({
      pipelineId: a.id,
      latestVersion: 1,
      active: { versionId: bv.id, version: null },
    });
  });

  it("is owner-scoped: another owner's pipelines and publishes never show", async () => {
    const mine = createPipeline(app.db, { ownerId: 'local', name: 'Mine' });
    const theirs = createPipeline(app.db, { ownerId: 'other', name: 'Theirs' });
    const theirVersion = createPipelineVersion(app.db, doc(theirs.id));
    // Same resourceId on another owner's log (resource ids are unique per owner).
    appendWorkspaceEvent(app.db, 'other', {
      type: 'pipeline.published',
      pipeline: mine.resourceId,
      from: null,
      to: theirVersion.id,
      commit: 'c',
      blob: 'b',
      by: 'other',
    });
    const items = await states();
    expect(items.map((s) => s.pipelineId)).toEqual([mine.id]);
    expect(items[0]).toMatchObject({ active: null });
  });

  it("another owner's NEWER publish on the same resourceId does not hide this owner's", async () => {
    const mine = createPipeline(app.db, { ownerId: 'local', name: 'Mine' });
    const v1 = createPipelineVersion(app.db, doc(mine.id));
    const theirs = createPipeline(app.db, { ownerId: 'other', name: 'Theirs' });
    const theirVersion = createPipelineVersion(app.db, doc(theirs.id));
    const event = (to: string, by: string) =>
      ({
        type: 'pipeline.published',
        pipeline: mine.resourceId,
        from: null,
        to,
        commit: 'c',
        blob: 'b',
        by,
      }) as const;
    appendWorkspaceEvent(app.db, 'local', event(v1.id, 'local'));
    // Pushes the other owner's per-owner `seq` past this owner's.
    for (let i = 0; i < 3; i++)
      appendWorkspaceEvent(app.db, 'other', event(theirVersion.id, 'other'));
    expect(await stateOf(mine.id)).toMatchObject({ active: { versionId: v1.id, version: 1 } });
  });

  it('lists live pipelines only: an archived one is not on the list it serves', async () => {
    const live = createPipeline(app.db, { ownerId: 'local', name: 'Live' });
    const gone = createPipeline(app.db, { ownerId: 'local', name: 'Gone' });
    expect(
      (await app.inject({ method: 'POST', url: `/api/pipelines/${gone.id}/archive` })).statusCode,
    ).toBe(200);
    expect((await states()).map((s) => s.pipelineId)).toEqual([live.id]);
  });
});
