import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
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
 * Both fixtures are egress-free (`fireAndSettle`'s rule): `fail` is a control
 * activity needing no connection and making no network call, and `wait` is
 * resolved by the engine itself. `seconds` is a whole-value `${}` expression
 * because `validateWaitConfig` refuses a bare literal at save time.
 */
const FAILING_DOC = {
  nodes: [{ id: 'stop', type: 'fail', config: { message: 'planned' }, position: { x: 0, y: 0 } }],
};

const SUCCEEDING_DOC = {
  nodes: [{ id: 'go', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
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
  await expect(page.getByRole('button', { name: sourceRunId })).toBeVisible();
  expect(page.url(), 'the monitor should follow the NEW run, not stay on the source').not.toContain(
    sourceRunId,
  );

  await expectQuiet(page, problems);
});

test('#895 — a run that SUCCEEDED is offered no rerun-from-failed', async ({ page }) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#895 succeeding', SUCCEEDING_DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, '#895 no-rerun');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* The withhold half, and it is the one worth an e2e: the server would refuse a
     successful run with `409 the run succeeded (nothing to resume from)`, so
     offering the control here would be offering something that cannot work. */
  await expect(page.getByRole('button', { name: 'Rerun from failed' })).toHaveCount(0);
  await expect(page.getByText(/may incur additional cost/)).toHaveCount(0);

  await expectQuiet(page, problems);
});
