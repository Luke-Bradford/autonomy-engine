import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * R2 + U10 — the Monitor's front door becomes readable.
 *
 * The runs list rendered `pipelineVersionId` RAW as its only identity column, so
 * every row read `pv_…` and an operator with more than one pipeline could not
 * tell their runs apart without opening each. It had no duration (two absolute
 * timestamps, subtract them yourself) and no filter at all.
 *
 * The fixture is a settled run of a NAMED pipeline, fired through the public API
 * exactly as an operator would. `fail` is a control activity — egress-free, no
 * connection and no network — so the run reaches a terminal status on a test
 * machine and its duration is a real measured elapsed rather than a live one.
 *
 * Every assertion is scoped to THIS run's row. The e2e database is shared with
 * the rest of the suite, so a global "the Manual tab is empty" claim would be
 * true only until another spec created a rerun; "our triggered run is absent
 * from the Child tab" is true no matter what else has run.
 */
test('R2/U10 — the runs list names the pipeline, times the run, and filters by origin', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const pipelineName = `Run list readable ${Date.now()}`;
  const { pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  const triggerName = 'e2e run-list trigger';
  const runId = await fireAndSettle(page, pipelineVersionId, triggerName);

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);

  const row = page.getByRole('row').filter({ hasText: runId });
  await expect(row).toHaveCount(1);

  // R2 — the pipeline's NAME and version number, and NOT the opaque key it
  // replaced. Asserting the id's ABSENCE is the half that matters: printing the
  // name beside the id would satisfy a name-only check while leaving the column
  // exactly as unreadable as before.
  await expect(row).toContainText(pipelineName);
  await expect(row).toContainText('v1');
  await expect(page.getByText(pipelineVersionId, { exact: true })).toHaveCount(0);
  // Demoted, not discarded — still reachable for whoever needs the raw key.
  await expect(row.locator(`[title="${pipelineVersionId}"]`)).toHaveCount(1);

  // R2 — the trigger's name, joined server-side.
  await expect(row).toContainText(triggerName);

  // R2 — a real measured duration for a settled run: some number followed by a
  // unit, and specifically NOT the em-dash that means "no answer".
  const duration = row.getByRole('cell').nth(5);
  await expect(duration).toHaveText(/^\d+(\.\d+)?(ms|s|m \d+s|h \d+m)$/);

  // U10 — the origin tabs. This run was fired by a trigger, so it belongs to
  // Triggered and to no other origin tab.
  await expect(page.getByRole('tab')).toHaveCount(4);
  await page.getByRole('tab', { name: /Triggered/ }).click();
  await expect(page.getByRole('tab', { name: /Triggered/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(1);

  await page.getByRole('tab', { name: /Child/ }).click();
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(0);

  await page.getByRole('tab', { name: /Manual/ }).click();
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(0);

  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(1);

  await expectQuiet(page, problems);
});
