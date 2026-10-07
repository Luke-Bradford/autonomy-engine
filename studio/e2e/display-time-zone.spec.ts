import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { triggerForm } from './support/panels';
import { fluentRootReady } from './support/theme';

/**
 * #1484 OR35 principle 4 — every timestamp in ONE display zone the viewer
 * picks in Settings, absolute with the zone named, to the millisecond on the
 * run page, and durations in one format.
 *
 * The browser runs in New York, so "local" and the chosen UTC differ by four or
 * five hours: a page that ignored the setting would print the New York wall
 * clock, and every expected string below is derived from the `<time>`
 * element's own ISO instant in UTC, so it cannot agree with New York by luck.
 */
test.use({ timezoneId: 'America/New_York' });

test('#1484 — a display time zone chosen in Settings dates the runs grid and the run page', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  const pipelineName = `Display zone ${Date.now()}`;
  const { pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'e2e display zone');

  // Settings: the picker starts on local and takes UTC.
  await page.goto('/#/settings');
  await fluentRootReady(page);
  const picker = page.getByLabel('Display time zone', { exact: true });
  await expect(picker).toHaveValue('local');
  await picker.selectOption('UTC');
  await expect(picker).toHaveAccessibleDescription(/^Times read like .* UTC$/);

  // A reload proves the choice is the viewer's stored preference.
  await page.goto('/#/monitor/runs');
  await page.reload();
  await fluentRootReady(page);
  const row = page.getByRole('row').filter({ hasText: runId });
  await expect(row).toHaveCount(1);

  const headers = await page.getByRole('columnheader').allTextContents();
  const startedAt = headers.findIndex((h) => h.trim().startsWith('Started'));
  const durationAt = headers.findIndex((h) => h.trim().startsWith('Duration'));
  const started = row.getByRole('cell').nth(startedAt);
  const startedTime = started.locator('time');
  const iso = await startedTime.getAttribute('datetime');
  expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const utc = iso!;
  // Compact in the grid: month-day and the UTC clock to the second.
  await expect(startedTime).toHaveText(`${utc.slice(5, 10)} ${utc.slice(11, 19)}`);
  // The full form on hover: the date, the clock to the ms, the zone, and how long ago.
  const escaped = `${utc.slice(0, 10)} ${utc.slice(11, 23)}`.replace(/[.]/g, '\\.');
  await expect(startedTime).toHaveAttribute(
    'title',
    new RegExp(`^${escaped} UTC · (now|\\d+ seconds? ago|\\d+ minutes? ago)$`),
  );
  // The compact cell carries no zone, so the header names it.
  await expect(page.getByRole('columnheader', { name: 'Started' })).toContainText('Started UTC');

  // The compact form fits the 124px column without clipping.
  const fits = await started.evaluate((td) => td.scrollWidth <= td.clientWidth);
  expect(fits).toBe(true);

  // One duration format: seconds to the ms, trailing zeros dropped, or m/s.
  await expect(row.getByRole('cell').nth(durationAt)).toHaveText(
    /^(\d+(\.\d{1,3})?s|\d+m \d{2}s)$/,
  );

  // The run page: Started to the millisecond, in UTC, naming the zone.
  await row.getByRole('cell').nth(startedAt).click();
  await expect(page).toHaveURL(new RegExp(`/monitor/runs/${runId}$`));
  const detailStarted = page.locator('dt', { hasText: /^Started$/ }).locator('+ dd time');
  await expect(detailStarted).toHaveText(`${utc.slice(0, 10)} ${utc.slice(11, 23)} UTC`);

  await expectQuiet(page, problems);
});

test('#1524 — a trigger window start is typed in the display time zone, and says so', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.goto('/#/settings');
  await fluentRootReady(page);
  await page.getByLabel('Display time zone', { exact: true }).selectOption('UTC');

  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await page.getByRole('button', { name: /New trigger/i }).click();
  const form = triggerForm(page);
  await form.getByLabel(/^Mode/).selectOption('tumbling');
  const start = form.getByLabel(/^Start time/);
  await expect(start).toHaveAccessibleName(/\(UTC time\)/);
  await start.fill('2026-08-01T09:00');
  // The browser is in New York (UTC-4 in August): read in ITS zone, 09:00 is
  // 13:00Z. Read in the chosen UTC, it is 09:00Z.
  await expect(form.getByTestId('window-bounds-utc')).toHaveText(
    /^Windows are keyed from 2026-08-01T09:00:00\.000Z, entered in UTC time/,
  );

  await expectQuiet(page, problems);
});
