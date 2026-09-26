import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #895 — the rerun-from-failed action.
 *
 * The RS series shipped the whole producer — the frontier algorithm, the reseed
 * event pair, `POST /api/runs/:id/rerun-from-failed`, the durable `rerunOf`
 * lineage column — and NOTHING in the web app called it. An operator staring at
 * a failed run had no way to rerun it short of `curl`. This spec is the one that
 * proves the path is joined up end to end, because it is the only level at which
 * the real producer actually runs: the unit tests mock the request, so they can
 * show the page ASKS, never that a rerun HAPPENS.
 *
 * Both fixtures are egress-free, which is `fireAndSettle`'s standing requirement:
 * `fail` is a control activity needing no connection and making no network call,
 * and `wait` is resolved by the engine's own alarm rather than by anything
 * outside the process (`seconds` is a whole-value `${}` expression because
 * `validateWaitConfig` refuses a bare literal at save time). That second class
 * is recorded in `seedDoc.ts`'s own docblock alongside the other two.
 */
const FAILING_DOC = {
  nodes: [{ id: 'stop', type: 'fail', config: { message: 'planned' }, position: { x: 0, y: 0 } }],
};

const SUCCEEDING_DOC = {
  nodes: [{ id: 'go', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
};

/**
 * #918 — a doc with a successful PREFIX to copy, which the two fixtures above
 * deliberately do not have (a lone `fail` reseeds an empty frontier).
 *
 * `filter` is the only egress-free activity that succeeds carrying a real
 * declared output: `kind:'control'`, no connection, never dispatched — the
 * reducer evaluates `filter(items, predicate)` itself and the driver appends
 * `node.succeeded{outputs:{result}}`. `items` comes from a param DEFAULT rather
 * than from the fire call, because `fireManualTrigger` sends no params and
 * `resolveRunParams` applies defaults at run start. Then `stop` fails on the
 * success edge, so R1 ends `failure` with `pick` on the reseed frontier.
 */
const COPIED_FRONTIER_DOC = {
  params: [{ name: 'nums', type: 'json' as const, required: false, default: [1, 4, 2, 5] }],
  nodes: [
    {
      id: 'pick',
      type: 'filter',
      config: { items: '${params.nums}', predicate: '${greater(item, 2)}' },
      position: { x: 0, y: 0 },
    },
    { id: 'stop', type: 'fail', config: { message: 'planned' }, position: { x: 240, y: 0 } },
  ],
  edges: [{ from: 'pick', to: 'stop', on: 'success' as const }],
};

test('#895 — a failed run reruns from the monitor, and the new run says where it came from', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#895 failing', FAILING_DOC);
  const sourceRunId = await fireAndSettle(page, pipelineVersionId, '#895 rerun');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(sourceRunId)}`);
  await fluentRootReady(page);

  // The action is offered, and the spec's cost warning is on screen beside it —
  // a rerun re-executes from the failure onward, so it is not free.
  const action = page.getByRole('button', { name: 'Rerun from failed' });
  await expect(action).toBeVisible();
  await expect(page.getByText(/may incur additional cost/)).toBeVisible();

  // A run that is not a rerun says nothing about lineage, rather than "—".
  await expect(page.getByText('Rerun of')).toHaveCount(0);

  await action.click();

  /* The page must land on the NEW run, not stay on the old one. `rerunOf` is
     read off the rendered lineage row, which is also the assertion that the
     server really minted R2 and linked it: the row cannot appear unless the
     producer ran and wrote the column. */
  await expect(page.getByText('Rerun of')).toBeVisible();
  /* #1232 — the lineage control is an ANCHOR now, not `navigate` on a button.
     Both halves are pinned because neither implies the other: the `href` is
     what a middle-click, a copy-link and an open-in-new-tab use and a click can
     never demonstrate, and the WALK below is what proves the href points at a
     route that resolves. `home-recent-runs.spec.ts` sets the RegExp form, which
     stays honest under hash routing. */
  const sourceLink = page.getByRole('link', { name: `Source run ${sourceRunId}` });
  await expect(sourceLink).toHaveAttribute('href', new RegExp(`/monitor/runs/${sourceRunId}$`));
  expect(page.url(), 'the monitor should follow the NEW run, not stay on the source').not.toContain(
    sourceRunId,
  );

  // The drill BACK. The row is a way to the source run, not merely a label of
  // one — which is the whole reason it is a control rather than a `<code>`.
  await sourceLink.click();
  await expect(page.getByRole('heading', { name: new RegExp(sourceRunId) })).toBeVisible();
  expect(page.url(), 'the lineage link must land on the SOURCE run').toContain(sourceRunId);
  // …and the source run is a rerun of nothing, so it carries no lineage row.
  await expect(page.getByText('Rerun of')).toHaveCount(0);

  await expectQuiet(page, problems);
});

/**
 * RS6 — the rerun-history grouping and the Run-type column. The #895 walk above
 * proves the UPWARD link (a rerun names its source); this proves the DOWNWARD
 * one (a source lists its reruns) and that the runs list says which rows are
 * reruns at all. Both read the durable `runs.rerun_of` column the real reseed
 * producer writes, so neither can pass unless a rerun was actually minted.
 */
test('RS6 — a failed run lists its reruns, and the runs list says which runs are reruns', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, 'RS6 history', FAILING_DOC);
  const sourceRunId = await fireAndSettle(page, pipelineVersionId, 'RS6 history');

  /* The absence is asserted only once the lineage read has LANDED — before it,
     the row is absent whatever the answer, and the check would prove nothing. */
  const reruns = page.waitForResponse((r) => r.url().includes('rerunOf='));
  await page.goto(`/#/monitor/runs/${encodeURIComponent(sourceRunId)}`);
  await fluentRootReady(page);
  expect((await reruns).status()).toBe(200);
  await expect(page.getByText('Reruns', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Rerun from failed' }).click();
  await expect(page.getByText('Rerun of')).toBeVisible();
  const rerunId = decodeURIComponent(page.url().split('/monitor/runs/')[1]!);
  expect(rerunId).not.toBe(sourceRunId);

  // Back up to the source: it now lists the rerun, as a link that resolves.
  await page.getByRole('link', { name: `Source run ${sourceRunId}` }).click();
  await expect(page.getByRole('heading', { name: new RegExp(sourceRunId) })).toBeVisible();
  await expect(page.getByText('Reruns', { exact: true })).toBeVisible();
  const rerunLink = page.getByRole('link', { name: `Rerun run ${rerunId}` });
  await expect(rerunLink).toHaveAttribute('href', new RegExp(`/monitor/runs/${rerunId}$`));
  await rerunLink.click();
  await expect(page.getByRole('heading', { name: new RegExp(rerunId) })).toBeVisible();

  // The runs list: the rerun's Type cell says so and names its source; the
  // source reads Original.
  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  const headers = await page.getByRole('columnheader').allTextContents();
  const typeColumn = headers.indexOf('Type');
  expect(typeColumn, 'the runs list has a Type column').toBeGreaterThanOrEqual(0);
  const typeOf = (runId: string) =>
    page.getByRole('row').filter({ hasText: runId }).getByRole('cell').nth(typeColumn);
  await expect(typeOf(rerunId)).toHaveText('Rerun from failed');
  await expect(typeOf(rerunId)).toHaveAttribute('title', `Rerun of run ${sourceRunId}`);
  await expect(typeOf(sourceRunId)).toHaveText('Original');

  await expectQuiet(page, problems);
});

test('#895 — a run that SUCCEEDED is offered no rerun-from-failed', async ({ page }) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#895 succeeding', SUCCEEDING_DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, '#895 no-rerun');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* PIN THE STATUS FIRST. `fireAndSettle` returns on ANY terminal status, so
     without this the test's own sentence is unproven: a fixture that ended
     `skipped` or `interrupted` would satisfy every assertion below while the
     title claimed it had succeeded. The absences only mean something once the
     run is known to be the case the title names. */
  await expect(page.locator('.run-status')).toHaveText('success');

  /* The withhold half, and it is the one worth an e2e: the server would refuse a
     successful run with `409 the run succeeded (nothing to resume from)`, so
     offering the control here would be offering something that cannot work. */
  await expect(page.getByRole('button', { name: 'Rerun from failed' })).toHaveCount(0);
  await expect(page.getByText(/may incur additional cost/)).toHaveCount(0);

  await expectQuiet(page, problems);
});

test('#918 — a rerun says which of its nodes it REUSED, and shows what they produced', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(
    page,
    '#918 copied frontier',
    COPIED_FRONTIER_DOC,
  );
  const sourceRunId = await fireAndSettle(page, pipelineVersionId, '#918 rerun');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(sourceRunId)}`);
  await fluentRootReady(page);

  /* PIN R1 FIRST, for the reason the succeeded-run spec above states: every
     assertion after the rerun is about a frontier that only exists because
     `pick` really succeeded and `stop` really failed. A fixture that ended some
     other way would satisfy the rest while the title claimed otherwise. */
  await expect(page.locator('.run-status')).toHaveText('failure');
  const sourceRow = page.getByRole('button', { name: 'Filter 1' }).locator('xpath=ancestor::tr');
  await expect(sourceRow.getByText('success')).toBeVisible();
  // In R1 the node EXECUTED, so it must make no claim about being reused.
  await expect(sourceRow.getByText(/reused from run/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Rerun from failed' }).click();
  await expect(page.getByText('Rerun of')).toBeVisible();

  /* THE DEFECT, at the level that proves the whole path: the copied node's
     result is carried by `run.reseeded` alone — no `node.succeeded` is appended
     for it in R2 — so before #918 this row had no Outputs section at all, while
     `${nodes.pick.output.result}` resolved for it downstream. */
  const copiedRow = page.getByRole('button', { name: 'Filter 1' }).locator('xpath=ancestor::tr');
  await expect(copiedRow.getByText(`reused from run ${sourceRunId}`)).toBeVisible();

  await page.getByRole('button', { name: 'Filter 1' }).click();
  const panel = page.getByRole('complementary', { name: 'Node Filter 1' });
  /* The HEADING role, not the bare text: the provenance hint above it says
     "the outputs below were computed there", so a text match resolves to two
     elements. */
  await expect(panel.getByRole('heading', { name: 'Outputs' })).toBeVisible();
  // The REAL copied value, computed in R1 by the real engine: [1,4,2,5] filtered
  // by `greater(item, 2)`. Asserting the value rather than the section's mere
  // presence is what makes this more than a "something rendered" check.
  await expect(panel.getByText('{"result":[4,5]}')).toBeVisible();
  await expect(panel.getByText(/reused its result from run/)).toBeVisible();
  await expect(panel.getByText(/not executed in this run/)).toBeVisible();

  await expectQuiet(page, problems);
});

/**
 * RS4 — a rerun that COPIES a call node reuses that node's child run rather
 * than starting a new one, and the copied node says which child that was.
 *
 * Walked in a browser because the link is followed for real: the child id
 * is derived by the engine rather than read off a row, so the one failure
 * that matters is a link to a run that does not exist. The `wait ${0}` child
 * follows `child-run-drill.spec.ts`, and for the same reason: nothing here is
 * billable or egress-adjacent.
 */
test("RS4 — a rerun reuses a copied call node's child, and links to it", async ({ page }) => {
  const problems = collectPageProblems(page);

  const childDoc: SeedDoc = {
    nodes: [
      { id: 'childWork', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } },
    ],
  };
  const { pipelineVersionId: childPv } = await seedVersion(page, 'RS4 child', childDoc);
  const parentDoc: SeedDoc = {
    nodes: [
      {
        id: 'callChild',
        type: 'call_pipeline',
        config: {},
        call: { pipelineVersionId: childPv, params: {} },
        position: { x: 0, y: 0 },
      },
      { id: 'stop', type: 'fail', config: { message: 'planned' }, position: { x: 240, y: 0 } },
    ],
    edges: [{ from: 'callChild', to: 'stop', on: 'success' as const }],
  };
  const { pipelineVersionId: parentPv } = await seedVersion(page, 'RS4 parent', parentDoc);
  const sourceRunId = await fireAndSettle(page, parentPv, 'RS4 rerun');

  const childrenOf = async (runId: string) => {
    const res = await page.request.get(`/api/runs?parentRunId=${encodeURIComponent(runId)}`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { items: { id: string; status: string }[] }).items;
  };
  /* PREMISE: R1's call node really spawned one child, and it succeeded, so
     the call node is on the frontier and `stop` is what failed. */
  const sourceChildren = await childrenOf(sourceRunId);
  expect(sourceChildren).toHaveLength(1);
  expect(sourceChildren[0]!.status).toBe('success');
  const childRunId = sourceChildren[0]!.id;

  await page.goto(`/#/monitor/runs/${encodeURIComponent(sourceRunId)}`);
  await fluentRootReady(page);
  await expect(page.locator('.run-status')).toHaveText('failure');
  await page.getByRole('button', { name: 'Rerun from failed' }).click();
  await expect(page.getByText('Rerun of')).toBeVisible();
  const rerunId = decodeURIComponent(page.url().split('/monitor/runs/')[1]!);
  expect(rerunId).not.toBe(sourceRunId);
  await expect(page.locator('.run-status')).toHaveText('failure');

  /* The call node was COPIED, so the rerun started no child of its own. */
  expect(await childrenOf(rerunId)).toHaveLength(0);

  const callRow = page.getByRole('row').filter({ hasText: 'callChild' });
  await callRow.getByRole('button').first().click();
  const panel = page.getByRole('complementary', { name: /^Node / });
  await expect(panel.getByText(/reused its result from run/)).toBeVisible();
  await expect(panel.getByText(/this rerun did not start another/)).toBeVisible();

  /* Followed for real: an href assertion alone would pass against a run that
     does not exist. */
  await panel.getByRole('link', { name: `Reused child run ${childRunId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/monitor/runs/${childRunId}$`));
  await expect(page.getByRole('link', { name: `Parent run ${sourceRunId}` })).toBeVisible();

  await expectQuiet(page, problems);
});
