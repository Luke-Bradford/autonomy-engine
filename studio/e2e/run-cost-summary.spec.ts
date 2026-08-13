import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * U27 slice 1 (#930) — the run monitor says what the RUN cost.
 *
 * EGRESS-FREE by the same trick #866's spec documents: an `agent_cli` connection
 * runs an arbitrary command, and `cliSpendFact` mints an `activity.metered` for
 * any subprocess that RAN, before any parsing of what it printed. So `/bin/echo`
 * produces a real, durably-appended spend fact with no network, no credential and
 * no provider.
 *
 * It lands on the shape this ticket is about. A CLI spend fact is
 * `meteringStatus:'unpriced'` with no token counts at all, so a run made of them
 * exercises the two run-level readings a naive total gets wrong: the money is a
 * KNOWN covered zero (so not `$0.00`, which reads as "we priced it and it was
 * free", and not "cost unknown", which reads as a measurement gap), and nobody
 * counted tokens (so not `0 in · 0 out`, a measurement never taken).
 *
 * TWO nodes rather than one, deliberately: the run-level figure has to be a SUM
 * over the whole log, and a single-node run cannot tell a sum from a copy of the
 * one node's cost.
 */
test('#930 — the run monitor totals a run’s spend, and never invents a figure', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const created = await page.request.post('/api/connections', {
    data: { name: 'e2e echo cli run-cost', kind: 'agent_cli', config: { command: '/bin/echo' } },
  });
  expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
  const { id: connectionId } = (await created.json()) as { id: string };

  /* Hoisted rather than inlined: an inline literal in the `seedVersion(...)`
     call trips excess-property checking against `SeedDoc`. */
  const doc: SeedDoc = {
    nodes: [
      {
        id: 'first',
        type: 'agent_task',
        config: { task: 'e2e ping one' },
        connectionId,
        position: { x: 0, y: 0 },
      },
      {
        id: 'second',
        type: 'agent_task',
        config: { task: 'e2e ping two' },
        connectionId,
        position: { x: 240, y: 0 },
      },
    ],
    edges: [{ id: 'e1', from: 'first', to: 'second', on: 'success' }],
  };
  const { pipelineVersionId } = await seedVersion(page, '#930 run spend', doc);
  const runId = await fireAndSettle(page, pipelineVersionId, '#930 run');

  /* The PREMISE, asserted before the UI: TWO real `activity.metered` events
     reached the durable log. Without this the assertions below could pass
     against a section that simply renders the empty case. */
  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  expect(eventsRes.status()).toBe(200);
  const events = (await eventsRes.json()) as { type: string; payload: Record<string, unknown> }[];
  const meteredPayloads = events.filter((e) => e.type === 'activity.metered').map((e) => e.payload);
  expect(meteredPayloads).toHaveLength(2);
  for (const p of meteredPayloads) {
    expect(p).toEqual(
      expect.objectContaining({ provider: 'agent_cli', meteringStatus: 'unpriced' }),
    );
  }

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* The RUN-level section, addressed by its landmark rather than by position, so
     it cannot silently match the drill-in's identically-titled one. */
  const section = page.getByRole('region', { name: 'Cost & usage' });
  await expect(section.getByRole('heading', { name: 'Cost & usage', level: 3 })).toBeVisible();

  // A KNOWN zero, said as one — over the WHOLE run.
  await expect(section.getByText('No marginal cost')).toBeVisible();
  await expect(
    section.getByText(/2 billed exchanges, every one a subscription or CLI call/),
  ).toBeVisible();
  // Not a priced zero…
  await expect(section.getByText('$0.00', { exact: true })).toHaveCount(0);
  // …and not a measurement gap either.
  await expect(section.getByText('Cost unknown')).toHaveCount(0);
  // Tokens nobody counted are said to be uncounted, not rendered as zeros.
  await expect(section.getByText('not reported')).toBeVisible();
  await expect(section.getByText(/0 in · 0 out/)).toHaveCount(0);
  // The exchange count is named as a floor: a CLI reports none of the model
  // calls it drives internally.
  await expect(section.getByText(/floor, not a census/)).toBeVisible();
  // A settled run must NOT carry the still-spending caveat.
  await expect(section.getByText(/has not settled/)).toHaveCount(0);
  // Nothing was reused — an ordinary run makes no claim about a source run.
  await expect(section.getByText(/REUSED from run/)).toHaveCount(0);

  await expectQuiet(page, problems);
});

/**
 * U27 slice 2 (#931) — the run LIST states what each run cost, so comparing two
 * runs no longer means opening both.
 *
 * Same egress-free seeding as the test above, and deliberately the same shape of
 * spend: a CLI spend fact is `unpriced` with no token counts, so the cell has to
 * render a KNOWN covered zero. That is the reading a naive column gets wrong in
 * both directions at once — `$0.00` claims we priced it and it was free, "Cost
 * unknown" claims a measurement gap — which is exactly why the cell routes
 * through `costFigure` rather than formatting the number itself.
 *
 * What this proves that a unit test cannot: the figure survives the whole path —
 * the bounded SQL aggregate, `GET /api/runs`' JSON, `RunSummarySchema`'s parse,
 * and the render — rather than only the last step of it.
 */
test('#931 — the run list states what each run cost, and never invents a figure', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const created = await page.request.post('/api/connections', {
    data: {
      name: 'e2e echo cli run-list-cost',
      kind: 'agent_cli',
      config: { command: '/bin/echo' },
    },
  });
  expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
  const { id: connectionId } = (await created.json()) as { id: string };

  const doc: SeedDoc = {
    nodes: [
      {
        id: 'only',
        type: 'agent_task',
        config: { task: 'e2e list ping' },
        connectionId,
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
  const { pipelineVersionId } = await seedVersion(page, '#931 list spend', doc);
  const runId = await fireAndSettle(page, pipelineVersionId, '#931 list run');

  /* The PREMISE, asserted through the LIST's own endpoint before the UI: the
     cost reached the row, not just the event log. Without this the cell
     assertions below could pass against a column rendering the empty case. */
  const listRes = await page.request.get('/api/runs');
  expect(listRes.status()).toBe(200);
  const summaries = (await listRes.json()) as {
    id: string;
    cost: { responseCount: number; unpricedResponseCount: number; complete: boolean };
  }[];
  const summary = summaries.find((r) => r.id === runId);
  expect(summary, `run ${runId} missing from GET /api/runs`).toBeDefined();
  expect(summary?.cost).toEqual(
    expect.objectContaining({ responseCount: 1, unpricedResponseCount: 1, complete: true }),
  );

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);

  await expect(page.getByRole('columnheader', { name: 'Cost' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: runId });
  await expect(row).toHaveCount(1);
  const cost = row.locator('td.run-cost');

  // A KNOWN zero, said as one.
  await expect(cost).toHaveText('No marginal cost');
  // Not a priced zero, and not a measurement gap either.
  await expect(cost).not.toContainText('$0.00');
  await expect(cost).not.toContainText('Cost unknown');
  // A SETTLED run's figure carries no spend-so-far qualifier.
  await expect(cost.locator('.run-cost-unsettled')).toHaveCount(0);

  await expectQuiet(page, problems);
});

/**
 * #932 — a run's total EXCLUDES what its sub-pipelines spent, and now says so.
 *
 * The first spec in the repo to run a `call_pipeline` to completion. Everything
 * before it either authored a call node without firing it
 * (`call-node-authoring.spec.ts`) or stubbed the seam, because until #796 landed
 * P3b there was no real child to run — which is precisely how this defect went
 * live unnoticed: the boundary was documented as "latent", the seam landed, and
 * the run monitor kept printing a total that had quietly started omitting money.
 *
 * WHAT IT PROVES THAT A UNIT TEST CANNOT. The unit tests pin the fold and the
 * sentence; only this can show the two runs are genuinely separate ledgers on the
 * real server — that the parent's `/cost` counts ONE exchange while the child's
 * counts its own, so the exclusion the UI claims is a measured fact rather than a
 * sentence someone typed. If a future change rolled child spend into the parent,
 * the caveat would become a lie and this is what catches it.
 *
 * EGRESS-FREE by the same trick as the specs above, applied on BOTH sides: an
 * `agent_cli` connection running `/bin/echo` mints a real `activity.metered` for
 * a subprocess that ran, with no network and no credential. The parent gets one
 * such node of its own so that its total is non-empty and therefore capable of
 * being wrong in the interesting direction.
 */
test('#932 — the run total says which child runs it leaves out, and links them', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const created = await page.request.post('/api/connections', {
    data: { name: 'e2e echo cli child-spend', kind: 'agent_cli', config: { command: '/bin/echo' } },
  });
  expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
  const { id: connectionId } = (await created.json()) as { id: string };

  /* The CHILD: one node that really spends, under its own run id. */
  const childDoc: SeedDoc = {
    nodes: [
      {
        id: 'childWork',
        type: 'agent_task',
        config: { task: 'e2e child spend' },
        connectionId,
        position: { x: 0, y: 0 },
      },
    ],
  };
  const { pipelineVersionId: childPv } = await seedVersion(page, '#932 child', childDoc);

  /* The PARENT: its OWN spend, then a call node targeting that child version. */
  const parentDoc: SeedDoc = {
    nodes: [
      {
        id: 'parentWork',
        type: 'agent_task',
        config: { task: 'e2e parent spend' },
        connectionId,
        position: { x: 0, y: 0 },
      },
      {
        id: 'callChild',
        type: 'call_pipeline',
        config: {},
        call: { pipelineVersionId: childPv, params: {} },
        position: { x: 240, y: 0 },
      },
    ],
    edges: [{ id: 'e1', from: 'parentWork', to: 'callChild', on: 'success' }],
  };
  const { pipelineVersionId: parentPv } = await seedVersion(page, '#932 parent', parentDoc);
  const runId = await fireAndSettle(page, parentPv, '#932 parent run');

  /* PREMISE, asserted before any UI: the child REALLY ran as its own run. Without
     this the assertions below could pass against a parent that refused the spawn
     — `callFailed` answers a refusal with a `call.returned` carrying the id of a
     run that was never created, which is exactly the case the fold declines to
     report. */
  const childrenRes = await page.request.get(`/api/runs?parentRunId=${encodeURIComponent(runId)}`);
  expect(childrenRes.status()).toBe(200);
  /* A BARE array — `GET /api/runs` returns `RunSummary[]`, not a paginated
     envelope (`listRunSummaries`). Reading `.items` off it yields `undefined`,
     which `toHaveLength` reports as a length mismatch rather than as the shape
     error it is. */
  const children = (await childrenRes.json()) as { id: string; status: string }[];
  expect(children).toHaveLength(1);
  const childRunId = children[0]!.id;
  expect(children[0]!.status).toBe('success');

  /* THE LOAD-BEARING ASSERTION: two separate ledgers. Each run billed exactly one
     CLI exchange, and the parent's total counts ONLY its own — if a change ever
     rolled descendants in, the parent would read 2 here and the caveat beside the
     figure would have become false. */
  const costOf = async (id: string) => {
    const res = await page.request.get(`/api/runs/${encodeURIComponent(id)}/cost`);
    expect(res.status()).toBe(200);
    return (await res.json()) as { responseCount: number };
  };
  expect((await costOf(runId)).responseCount).toBe(1);
  expect((await costOf(childRunId)).responseCount).toBe(1);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  const section = page.getByRole('region', { name: 'Cost & usage' });
  await expect(section.getByText(/called 1 sub-pipeline, and it ran as its own run/)).toBeVisible();
  // Not a census: the linked child may have called others in turn.
  await expect(section.getByText(/anything it called in turn/)).toBeVisible();

  /* The link is the half that makes the understatement usable — an operator told
     money is missing and given no route to it is barely better off. Followed for
     real rather than asserted on its href, so a route that 404s fails here. */
  await section.getByRole('link', { name: childRunId }).click();
  await expect(page).toHaveURL(new RegExp(`/monitor/runs/${childRunId}$`));
  const childSection = page.getByRole('region', { name: 'Cost & usage' });
  await expect(childSection.getByRole('heading', { name: 'Cost & usage' })).toBeVisible();
  // The child's own page makes no exclusion claim: it called nothing.
  await expect(childSection.getByText(/sub-pipeline/)).toHaveCount(0);

  await expectQuiet(page, problems);
});

/**
 * U27 slice 2, the other half (#931) — the run list states what a whole PIPELINE
 * has cost, from `GET /api/pipelines/:id/cost`.
 *
 * That route has existed since #599 with no web caller at all, so what this
 * proves is the path end to end: the bounded SQL rollup, the JSON, the Zod parse,
 * and the render — under the `?pipeline=` filter that scopes it.
 *
 * TWO runs, deliberately. A pipeline rollup is a sum across RUNS, and a
 * single-run pipeline cannot tell a sum from a copy of that one run's cost —
 * `runCount` would read 1 either way. Same egress-free `agent_cli` seeding as the
 * tests above, so the reading is a KNOWN covered zero rather than a priced one.
 *
 * The last navigation is the honesty assertion, and it is the reason the figure
 * sits outside the rows guard: filtered to a status these runs never reached, the
 * list is empty while the pipeline's lifetime spend is still on screen. A figure
 * that vanished there would be missing exactly when it is the only spend to see —
 * and one that stayed while claiming to describe the rows would be lying.
 */
test('#931 — the run list states what a whole pipeline has cost, across every run', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const created = await page.request.post('/api/connections', {
    data: {
      name: 'e2e echo cli pipeline-cost',
      kind: 'agent_cli',
      config: { command: '/bin/echo' },
    },
  });
  expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
  const { id: connectionId } = (await created.json()) as { id: string };

  const doc: SeedDoc = {
    nodes: [
      {
        id: 'only',
        type: 'agent_task',
        config: { task: 'e2e pipeline spend' },
        connectionId,
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
  const { pipelineId, pipelineVersionId } = await seedVersion(page, '#931 pipeline spend', doc);
  await fireAndSettle(page, pipelineVersionId, '#931 rollup run A');
  await fireAndSettle(page, pipelineVersionId, '#931 rollup run B');

  /* The PREMISE, from the route itself, before any UI: two runs and two billed
     exchanges really are in the rollup. Without it every assertion below could
     pass against a section rendering the never-ran case. */
  const rollupRes = await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/cost`);
  expect(rollupRes.status()).toBe(200);
  expect(await rollupRes.json()).toEqual(
    expect.objectContaining({ runCount: 2, responseCount: 2, unpricedResponseCount: 2 }),
  );

  await page.goto(`/#/monitor/runs?pipeline=${encodeURIComponent(pipelineId)}`);
  await fluentRootReady(page);

  const spend = page.getByRole('region', { name: 'Lifetime spend' });
  await expect(spend.getByRole('heading', { name: 'Lifetime spend', level: 3 })).toBeVisible();

  // A KNOWN covered zero — not a priced $0.00, and not a measurement gap.
  await expect(spend.getByText('No marginal cost')).toBeVisible();
  await expect(spend.getByText('$0.00', { exact: true })).toHaveCount(0);
  await expect(spend.getByText('Cost unknown')).toHaveCount(0);

  // The SUM across runs, and the scope that stops it reading as the rows' total.
  await expect(spend.getByText(/Across all 2 runs, every version/)).toBeVisible();
  await expect(spend.getByText(/not just the runs listed below/)).toBeVisible();
  await expect(
    spend.getByText(/2 billed exchanges, every one a subscription or CLI call/),
  ).toBeVisible();
  // The exclusion the rollup's own scoping forces, said out loud.
  await expect(
    spend.getByText(/Excludes what any sub-pipeline this one calls spent/),
  ).toBeVisible();

  // No pipeline filter, no claim about any one pipeline's spend.
  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  await expect(page.getByRole('region', { name: 'Lifetime spend' })).toHaveCount(0);

  // Filtered to a status these runs never reached: no rows, and the lifetime
  // figure is still there — the whole reason it sits outside the rows guard.
  await page.goto(`/#/monitor/runs?pipeline=${encodeURIComponent(pipelineId)}&status=failure`);
  await fluentRootReady(page);
  await expect(page.getByText(/No runs match these filters/)).toBeVisible();
  await expect(spend.getByText('No marginal cost')).toBeVisible();
  await expect(spend.getByText(/Across all 2 runs/)).toBeVisible();

  await expectQuiet(page, problems);
});
