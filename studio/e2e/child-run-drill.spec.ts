import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1231 (U20 slice 1) — a composed run is readable in BOTH directions.
 *
 * #796 made a `call_pipeline` child really execute and #735 gave the parent a
 * `call.started`, so the call node sits `waiting` for the whole time the child
 * is in flight. Neither gave the operator a way to LOOK at the child, and the
 * child's own page never said it was one. This walks the loop a human walks:
 * parent → the call node's drill-in → the child → back up.
 *
 * Asserted in a BROWSER rather than as a unit test because the two halves live
 * on the same route reached twice, and the thing that breaks is a route, not a
 * render: both links are followed for real, so a path that 404s fails here.
 * (The unit tests own the wording and the presence rules.)
 *
 * The child is a `wait ${0}` and NOT the `agent_cli` + `/bin/echo` pair the
 * nearest precedent (`run-cost-summary.spec.ts`) uses, because that spec is
 * about SPEND and this one is not. The suite runs `workers: 1,
 * fullyParallel: false` against one shared DB, and `monitor-ai-activity.spec.ts`
 * asserts an EMPTY AI window on the premise that "a fresh e2e DB has no runs at
 * all" — a premise every earlier-sorting spec that bills an exchange falsifies.
 * This spec needs no exchange, so it takes the node that needs no connection at
 * all: nothing here is egress-adjacent and nothing here is billable. (The
 * order-dependency that made that visible is real and is filed separately.)
 */
test('#1231 — a call node names its child run, and the child names its caller', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const childDoc: SeedDoc = {
    nodes: [{ id: 'childWork', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
  };
  const { pipelineVersionId: childPv } = await seedVersion(page, '#1231 child', childDoc);

  const parentDoc: SeedDoc = {
    nodes: [
      {
        id: 'callChild',
        type: 'call_pipeline',
        config: {},
        call: { pipelineVersionId: childPv, params: {} },
        position: { x: 0, y: 0 },
      },
    ],
  };
  const { pipelineVersionId: parentPv } = await seedVersion(page, '#1231 parent', parentDoc);
  const parentRunId = await fireAndSettle(page, parentPv, '#1231 parent run');

  /* PREMISE, before any UI. A refused spawn answers with a `call.returned`
     carrying the id of a run that was never created (`callFailed`), so without
     this the assertions below could pass against a parent that never spawned
     anything — and the whole point of sourcing the drill from `call.started` is
     that it cannot offer such an id. */
  const childrenRes = await page.request.get(
    `/api/runs?parentRunId=${encodeURIComponent(parentRunId)}`,
  );
  expect(childrenRes.status()).toBe(200);
  const children = ((await childrenRes.json()) as { items: { id: string; status: string }[] }).items;
  expect(children).toHaveLength(1);
  const childRunId = children[0]!.id;
  expect(children[0]!.status).toBe('success');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(parentRunId)}`);
  await fluentRootReady(page);

  /* Open the drill-in by ROW rather than by the button's label: the button is
     named by the activity's ordinal label (`Execute Pipeline 1`), which is a
     presentation fact this spec has no stake in, while the raw node id beside it
     is what the doc and the event feed are keyed on. */
  const callRow = page.getByRole('row').filter({ hasText: 'callChild' });
  await callRow.getByRole('button').first().click();

  const panel = page.getByRole('region', { name: 'Child runs' });
  await expect(panel.getByText(/own log, its own outputs and its own spend/)).toBeVisible();

  /* DOWN. Followed for real — an href assertion would pass against a route that
     does not exist. */
  await panel.getByRole('link', { name: `Child run ${childRunId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/monitor/runs/${childRunId}$`));

  /* UP. The child page must say WHOSE child it is — before this row it was
     indistinguishable from any other run. */
  await expect(page.getByText('Called by')).toBeVisible();
  await page.getByRole('link', { name: `Parent run ${parentRunId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/monitor/runs/${parentRunId}$`));

  /* Back where we started, and the parent is NOT itself a child: the absence of
     the row is what "nothing called this" looks like, so a row that rendered
     unconditionally would pass every assertion above and still be wrong. */
  await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
  await expect(page.getByText('Called by')).toHaveCount(0);

  await expectQuiet(page, problems);
});
