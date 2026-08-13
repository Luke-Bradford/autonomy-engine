import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CATALOG_VERSION,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginatedResponseSchema,
  RerunAcceptedSchema,
  RunDetailSchema,
  RunSchema,
  RunSummarySchema,
} from '@autonomy-studio/shared';
import {
  appendRunEvent,
  createPipeline,
  createPipelineVersion,
  createRun,
} from '../../repo/index.js';
import { eq } from 'drizzle-orm';
import { pipelineVersions, runs } from '../../db/schema.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #1083 — `GET /api/runs` answers the `{ items, nextCursor }` envelope, so every
 * assertion about WHICH runs come back reads `items`. Hoisted rather than
 * repeated inline: the shape is the contract, and a test that reached past it
 * would keep passing if the envelope regressed to a bare array.
 */
function runIdsOf(res: { json: () => { items: { id: string }[] } }): string[] {
  return res.json().items.map((r) => r.id);
}

describe('runs routes (read-only)', () => {
  let app: FastifyInstance;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For runs' });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    pipelineVersionId = version.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists and fetches runs seeded directly via the repo layer (there is no create-run route)', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: { topic: 'hello' },
    });

    const listRes = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(listRes.statusCode).toBe(200);
    expect(runIdsOf(listRes)).toContain(run.id);

    const getRes = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual(run);
    // RS6 — an original run surfaces `rerunOf: null` on the read API.
    expect(getRes.json().rerunOf).toBeNull();
  });

  it("GET /api/runs?rerunOf=<id> filters to a source run's reruns (RS6 grouping)", async () => {
    const source = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const rerun = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
      rerunOf: source.id,
    });

    const res = await app.inject({ method: 'GET', url: `/api/runs?rerunOf=${source.id}` });
    expect(res.statusCode).toBe(200);
    const ids = runIdsOf(res);
    expect(ids).toEqual([rerun.id]);
    expect(res.json().items[0].rerunOf).toBe(source.id);
  });

  it("GET /api/runs?rerunOf= is owner-scoped — never lists another owner's reruns (authz != authn)", async () => {
    // Authentication is not authorization: the `rerunOf` grouping filter is ANDed
    // with the principal's ownerId, so a caller cannot enumerate another owner's
    // rerun lineage even by supplying their source-run id.
    const source = createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
      rerunOf: source.id,
    });

    const res = await app.inject({ method: 'GET', url: `/api/runs?rerunOf=${source.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]); // principal is `local`, not `someone-else`
  });

  /**
   * U26 — the filter pane's query surface. The repo tests own WHICH rows each
   * axis selects; these own the ROUTE's contract: what it accepts, what it
   * refuses, and that no axis escapes the owner scope.
   */
  describe('U26 — the Monitor filter axes', () => {
    it('filters by status, pipeline and window, all ANDed with the owner scope', async () => {
      const other = createPipeline(app.db, { ownerId: 'local', name: 'Another pipeline' });
      const otherVersion = createPipelineVersion(app.db, {
        pipelineId: other.id,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      const pipelineId = app.db
        .select({ id: pipelineVersions.pipelineId })
        .from(pipelineVersions)
        .where(eq(pipelineVersions.id, pipelineVersionId))
        .get()!.id;

      const seed = (versionId: string, ownerId: string) =>
        createRun(app.db, {
          ownerId,
          pipelineVersionId: versionId,
          triggerId: null,
          parentRunId: null,
          params: {},
        });
      const wanted = seed(pipelineVersionId, 'local');
      const wrongPipeline = seed(otherVersion.id, 'local');
      const foreign = seed(pipelineVersionId, 'someone-else');
      for (const id of [wanted.id, wrongPipeline.id, foreign.id]) {
        app.db.update(runs).set({ status: 'failure' }).where(eq(runs.id, id)).run();
      }

      const res = await app.inject({
        method: 'GET',
        url: `/api/runs?status=failure&pipelineId=${pipelineId}&since=24h`,
      });
      expect(res.statusCode).toBe(200);
      const ids = runIdsOf(res);
      expect(ids).toContain(wanted.id);
      // One exclusion per axis: the wrong pipeline, and — the one that matters —
      // another owner's run that satisfies every axis the caller supplied.
      expect(ids).not.toContain(wrongPipeline.id);
      expect(ids).not.toContain(foreign.id);
    });

    it('a `since` window EXCLUDES a run older than it', async () => {
      const stale = createRun(app.db, {
        ownerId: 'local',
        pipelineVersionId,
        triggerId: null,
        parentRunId: null,
        params: {},
      });
      // Two hours ago — outside `1h`, inside `24h`. Asserting BOTH is what makes
      // this a window test rather than an "is the param wired" test.
      app.db
        .update(runs)
        .set({ startedAt: Date.now() - 2 * 60 * 60 * 1000 })
        .where(eq(runs.id, stale.id))
        .run();

      const within = await app.inject({ method: 'GET', url: '/api/runs?since=24h' });
      expect(runIdsOf(within)).toContain(stale.id);
      const outside = await app.inject({ method: 'GET', url: '/api/runs?since=1h' });
      expect(runIdsOf(outside)).not.toContain(stale.id);
    });

    /**
     * A fielded axis REFUSES a value outside its vocabulary rather than quietly
     * matching nothing — a silently-empty list is indistinguishable from "you
     * have no failures", which is the wrong answer to a typo.
     */
    it.each([
      ['status', 'status=not-a-status'],
      ['since', 'since=garbage'],
      ['since (empty string)', 'since='],
      ['pipelineId (empty string)', 'pipelineId='],
    ])('refuses an out-of-vocabulary %s with a 400', async (_label, query) => {
      const res = await app.inject({ method: 'GET', url: `/api/runs?${query}` });
      expect(res.statusCode).toBe(400);
    });

    /**
     * The oracle guard. A pipeline id belonging to someone else must be
     * INDISTINGUISHABLE from one that exists nowhere — both an empty 200, never
     * a 404 that would confirm the id is real.
     */
    it('answers a foreign and a nonexistent pipelineId identically (no existence oracle)', async () => {
      const theirs = createPipeline(app.db, { ownerId: 'someone-else', name: 'Not yours' });
      const foreign = await app.inject({
        method: 'GET',
        url: `/api/runs?pipelineId=${theirs.id}`,
      });
      const unknown = await app.inject({ method: 'GET', url: '/api/runs?pipelineId=pl_nope' });
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json().items).toEqual([]);
      expect(unknown.statusCode).toBe(foreign.statusCode);
      expect(unknown.json()).toEqual(foreign.json());
    });
  });

  it('GET /api/runs/:id/events returns the append-only event log in order', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendRunEvent(app.db, { runId: run.id, type: 'run.started', payload: {} });
    appendRunEvent(app.db, { runId: run.id, type: 'run.finished', payload: { status: 'success' } });

    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/events` });
    expect(res.statusCode).toBe(200);
    const events = res.json();
    expect(events).toHaveLength(2);
    expect(events.map((e: { type: string }) => e.type)).toEqual(['run.started', 'run.finished']);
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(1);
  });

  it('GET /api/runs/:id/cost SUMS the metered events, fail-closed on an absent costEstimate', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const metered = (fields: Record<string, unknown>) => ({
      type: 'activity.metered',
      runId: run.id,
      nodeId: 'n1',
      attemptId: 'n1#1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      ...fields,
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.started',
      payload: { type: 'run.started' },
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'activity.metered',
      payload: metered({ inputTokens: 100, outputTokens: 200, costEstimate: 0.0055 }),
    });
    // unpriced response — no costEstimate → must not be summed as 0, flips complete
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'activity.metered',
      payload: metered({ inputTokens: 10, outputTokens: 20 }),
    });

    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/cost` });
    expect(res.statusCode).toBe(200);
    const cost = res.json();
    expect(cost.currency).toBe('USD');
    expect(cost.responseCount).toBe(2);
    expect(cost.pricedResponseCount).toBe(1);
    expect(cost.costUnknownResponseCount).toBe(1);
    expect(cost.totalCostEstimate).toBeCloseTo(0.0055, 10);
    expect(cost.complete).toBe(false);
  });

  it('GET /api/runs/:id/cost 404s for a run owned by someone else', async () => {
    const other = createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${other.id}/cost` });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/runs/:id/rerun-from-failed → 202 { runId } for an owned FAILED run', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId, // a ZERO-node version — reseed frontier is empty, R2 drives trivially
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    // A minimal valid failed log (parses through EngineEventSchema on load).
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.started',
      payload: { type: 'run.started', runId: run.id, pipelineVersionId, params: {} },
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.finished',
      payload: { type: 'run.finished', runId: run.id, outcome: 'failure', reason: 'boom' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/rerun-from-failed`,
    });
    expect(res.statusCode).toBe(202);
    // #899 — the 202 body is validated through the SHARED schema the client parses
    // with, so a divergence between the two ends fails HERE rather than at runtime
    // in the browser.
    const { runId } = RerunAcceptedSchema.parse(res.json());
    expect(runId).not.toBe(run.id);
  });

  it('POST /api/runs/:id/rerun-from-failed → 409 when a rerun is already in flight (#896)', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.started',
      payload: { type: 'run.started', runId: run.id, pipelineVersionId, params: {} },
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.finished',
      payload: { type: 'run.finished', runId: run.id, outcome: 'failure', reason: 'boom' },
    });
    // An existing rerun, seeded `running` rather than produced by a first call —
    // a real R2 drives in the background and would settle on its own schedule.
    const inFlight = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
      rerunOf: run.id,
      status: 'running',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/rerun-from-failed`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
    // The message names the live rerun: with no cancel control in the UI, the id is
    // the only thing that lets an operator go and look at it.
    expect(res.json().message).toContain(inFlight.id);
  });

  it('POST /api/runs/:id/rerun-from-failed → 409 for a SUCCESSFUL run (not eligible)', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.started',
      payload: { type: 'run.started', runId: run.id, pipelineVersionId, params: {} },
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.finished',
      payload: { type: 'run.finished', runId: run.id, outcome: 'success' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/rerun-from-failed`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
  });

  it('POST /api/runs/:id/rerun-from-failed → 404 for a missing OR other-owner run (no oracle)', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/runs/run_missing/rerun-from-failed',
    });
    expect(missing.statusCode).toBe(404);

    const other = createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendRunEvent(app.db, {
      runId: other.id,
      type: 'run.started',
      payload: { type: 'run.started', runId: other.id, pipelineVersionId, params: {} },
    });
    appendRunEvent(app.db, {
      runId: other.id,
      type: 'run.finished',
      payload: { type: 'run.finished', runId: other.id, outcome: 'failure' },
    });
    const otherRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${other.id}/rerun-from-failed`,
    });
    expect(otherRes.statusCode).toBe(404);
  });

  /**
   * R2 — the list route serves a `RunSummary`, not a bare `Run`. Every response
   * element is parsed through the SHARED schema, so this is a contract check
   * against the type the web client parses with, not a hand-written shape.
   */
  it('lists runs as RunSummary — pipeline name, version number and trigger name joined', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const res = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    const rows = paginatedResponseSchema(RunSummarySchema).parse(res.json()).items;
    const summary = rows.find((r) => r.id === run.id);
    expect(summary).toBeDefined();
    expect(typeof summary?.pipelineName).toBe('string');
    expect(summary?.pipelineName.length).toBeGreaterThan(0);
    expect(typeof summary?.pipelineVersion).toBe('number');
    // No trigger on this run — named null, and NOT dropped from the list.
    expect(summary?.triggerName).toBeNull();
    // Still additive over `Run`: an old reader parsing with RunSchema survives.
    // Parsed from THIS run's summary, not `[0]` — the new ORDER BY no longer
    // guarantees which run is first.
    expect(() => RunSchema.parse(summary)).not.toThrow();
  });

  /**
   * #1083 — the HTTP half of the keyset walk. The repo tests own WHICH rows a
   * page holds; these own the BOUNDARY: that the route accepts `limit`/`cursor`
   * at all, that a malformed cursor is a loud 400 rather than a silent first
   * page, and that the owner scope survives a resumed request.
   */
  describe('pagination (#1083)', () => {
    /**
     * ITS OWN APP, deliberately, where the rest of this file shares one. The
     * `DEFAULT_PAGE_SIZE` case has to seed more runs than a page holds, and on
     * the shared db those rows become the newest page for every test after it —
     * which is exactly how this block first broke a sibling assertion that had
     * been passing for a year.
     *
     * PER-TEST, not per-block, for the same reason one step further in: these
     * cases seed overlapping stamp ranges, so a shared db would leave each one
     * asserting "the newest page" against the previous test's rows too. A fresh
     * db makes the fixtures the ONLY runs, which is what every assertion here
     * actually claims.
     */
    let pageApp: FastifyInstance;
    let pageVersionId: string;

    beforeEach(async () => {
      pageApp = await buildTestApp();
      const pipeline = createPipeline(pageApp.db, { ownerId: 'local', name: 'For paging' });
      const version = createPipelineVersion(pageApp.db, {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      pageVersionId = version.id;
    });

    afterEach(async () => {
      await pageApp.close();
    });

    function seedRuns(count: number, ownerId = 'local', offset = 0) {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const run = createRun(pageApp.db, {
          ownerId,
          pipelineVersionId: pageVersionId,
          triggerId: null,
          parentRunId: null,
          params: {},
        });
        // Distinct, ordered stamps so "newest-first across pages" is checkable
        // rather than dependent on same-millisecond creation.
        pageApp.db
          .update(runs)
          .set({ startedAt: 2_000_000 + offset + i * 1_000 })
          .where(eq(runs.id, run.id))
          .run();
        ids.push(run.id);
      }
      return ids.reverse();
    }

    it('honours ?limit and hands back a cursor that resumes the SAME order', async () => {
      const newestFirst = seedRuns(5);

      const first = await pageApp.inject({ method: 'GET', url: '/api/runs?limit=2' });
      expect(first.statusCode).toBe(200);
      expect(runIdsOf(first)).toEqual(newestFirst.slice(0, 2));
      const cursor = first.json().nextCursor;
      expect(cursor).not.toBeNull();

      const second = await pageApp.inject({
        method: 'GET',
        url: `/api/runs?limit=2&cursor=${encodeURIComponent(cursor)}`,
      });
      expect(second.statusCode).toBe(200);
      // The rows AFTER the first page, in the same descending order — not the
      // first page again, which is what a cursor silently ignored would give.
      expect(runIdsOf(second)).toEqual(newestFirst.slice(2, 4));
    });

    it('refuses a malformed cursor with a 400 — never a silent first page', async () => {
      seedRuns(3);
      // Fail-CLOSED. Serving page one for an unreadable cursor would hand the
      // caller a different result set than the one they asked to resume, and
      // nothing in the response would say so.
      for (const cursor of ['not-base64!!', 'bm90LWpzb24', '']) {
        const res = await pageApp.inject({
          method: 'GET',
          url: `/api/runs?cursor=${encodeURIComponent(cursor)}`,
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('refuses a limit outside [1, MAX_PAGE_SIZE] rather than clamping it', async () => {
      for (const limit of ['0', '-1', String(MAX_PAGE_SIZE + 1), 'all']) {
        const res = await pageApp.inject({ method: 'GET', url: `/api/runs?limit=${limit}` });
        expect(res.statusCode).toBe(400);
      }
      const ok = await pageApp.inject({ method: 'GET', url: `/api/runs?limit=${MAX_PAGE_SIZE}` });
      expect(ok.statusCode).toBe(200);
    });

    it('defaults to DEFAULT_PAGE_SIZE, so an omitted limit is still BOUNDED', async () => {
      // The property this route existed without: no query string may produce an
      // unbounded body. One row past the default proves the cap is applied and
      // not merely large.
      seedRuns(DEFAULT_PAGE_SIZE + 1);
      const res = await pageApp.inject({ method: 'GET', url: '/api/runs' });
      expect(res.json().items).toHaveLength(DEFAULT_PAGE_SIZE);
      expect(res.json().nextCursor).not.toBeNull();
    });

    it('keeps the owner scope on a RESUMED page, not only the first', async () => {
      const mine = seedRuns(3);
      // Interleaved into the same stamp range, so a dropped scope on page two
      // would surface these rather than leaving them sorted out of reach.
      const theirs = seedRuns(3, 'someone-else', 500);

      const first = await pageApp.inject({ method: 'GET', url: '/api/runs?limit=1' });
      expect(runIdsOf(first)).toEqual([mine[0]]);
      const cursor = first.json().nextCursor;

      // A limit wide enough to hold every remaining row of BOTH owners, so the
      // page is bounded by the scope rather than by the page size.
      const second = await pageApp.inject({
        method: 'GET',
        url: `/api/runs?limit=10&cursor=${encodeURIComponent(cursor)}`,
      });
      expect(runIdsOf(second)).toEqual(mine.slice(1));
      for (const id of theirs) expect(runIdsOf(second)).not.toContain(id);
      // The walk is over: the caller's own rows ran out, and another owner's
      // rows must not extend it.
      expect(second.json().nextCursor).toBeNull();
    });
  });

  it('there is no POST /api/runs route (runs are created by the engine/scheduler, not this API)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { pipelineVersionId },
    });
    expect([404, 405]).toContain(res.statusCode);
  });

  it('owner scoping: a run belonging to a different owner is filtered from list and 404s on get', async () => {
    const other = createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const listRes = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(runIdsOf(listRes)).not.toContain(other.id);

    const getRes = await app.inject({ method: 'GET', url: `/api/runs/${other.id}` });
    expect(getRes.statusCode).toBe(404);

    const eventsRes = await app.inject({ method: 'GET', url: `/api/runs/${other.id}/events` });
    expect(eventsRes.statusCode).toBe(404);
  });

  it('404 for a missing run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/run_missing' });
    expect(res.statusCode).toBe(404);
  });

  describe('R1 — GET /api/runs/:id/detail (the run-detail read-model)', () => {
    it('resolves the run AND its bound version doc in one call', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'R1 detail' });
      const version = createPipelineVersion(app.db, {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes: [
          { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', type: 'http_request', position: { x: 200, y: 0 }, config: {} },
        ],
        edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' }],
        catalogVersion: CATALOG_VERSION,
      });
      const run = createRun(app.db, {
        ownerId: 'local',
        pipelineVersionId: version.id,
        triggerId: null,
        parentRunId: null,
        params: { topic: 'r1' },
      });

      const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/detail` });
      expect(res.statusCode).toBe(200);

      // Parsed through the SHARED schema, so this asserts the wire contract the
      // web client re-parses, not just "some JSON came back".
      const detail = RunDetailSchema.parse(res.json());
      expect(detail.run.id).toBe(run.id);
      expect(detail.pipelineVersion.id).toBe(version.id);
      // The DOC is the whole point — U11 cannot project node state without it.
      expect(detail.pipelineVersion.nodes.map((n) => n.id)).toEqual(['a', 'b']);
      expect(detail.pipelineVersion.edges).toHaveLength(1);
    });

    it("404s for a run belonging to a different owner — a run handle must not leak someone else's doc", async () => {
      // The version doc carries node config and param defaults, so this route
      // hands out strictly MORE than `GET /api/runs/:id`. The ownership proof is
      // the run's, and it has to actually run.
      const other = createRun(app.db, {
        ownerId: 'someone-else',
        pipelineVersionId,
        triggerId: null,
        parentRunId: null,
        params: {},
      });

      const res = await app.inject({ method: 'GET', url: `/api/runs/${other.id}/detail` });
      expect(res.statusCode).toBe(404);
    });

    it('404s for a missing run (same response as the other-owner case — no oracle)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/runs/run_missing/detail' });
      expect(res.statusCode).toBe(404);
    });
  });

  it('filters by pipelineVersionId/triggerId/parentRunId query params', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs?pipelineVersionId=${pipelineVersionId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(runIdsOf(res)).toContain(run.id);
  });

  it('validation: a non-string query param value -> 400', async () => {
    const res = await app.inject({
      method: 'GET',
      // Fastify parses repeated query keys into an array, which fails the
      // Zod string schema — invalid shape, not a value the repo should ever see.
      url: '/api/runs?pipelineVersionId=a&pipelineVersionId=b',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('validation: an empty-string query param value -> 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?triggerId=' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });
});
