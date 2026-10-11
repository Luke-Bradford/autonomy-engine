import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  computedStyles as styles,
  DENSITIES,
  expectAppearance,
  expectControlHeights,
  ICON_SIZE,
  preferAppearance,
} from './support/appearance';
import { fireAndSettle, IF_FOREACH_THEN_FAIL, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';
import { offRampText } from './support/typeRamp';

/**
 * #1594 OR40 S6o — the run page's and the Runs page's remaining pieces on the
 * design system, at 1440x900 in compact light and comfortable dark: the failure
 * banner, the activity runs' bar, group lines and depth indents, and on the Runs
 * page the pipeline's lifetime spend, whose `?` is now the shared one, the
 * editor icon and the Pipeline cell's line.
 *
 * Measured: all text on the type ramp; spacing on the 4px scale at the values
 * below; the banner's button `--control-h`; a nested activity 16px a level in
 * from the cell's own 8px; the spend `?` a circle at `--icon-size` whose note
 * opens on the page.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

const BODY: Record<Density, string> = { compact: '13px', comfortable: '14px' };

const DEPTH_1 = ".activity-runs__table tr[data-depth='1'] > td:first-child";
const DEPTH_2 = ".activity-runs__table tr[data-depth='2'] > td:first-child";

for (const { density, theme } of RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6o — the run page's banner and activity runs, and the Runs page's spend, on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    const name = `S6o run ${density} ${Date.now()}`;
    const { pipelineId, pipelineVersionId } = await seedVersion(page, name, IF_FOREACH_THEN_FAIL);
    const runId = await fireAndSettle(page, pipelineVersionId, name);

    // --- The run page ----------------------------------------------------
    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    await expectAppearance(page, theme, d);
    // 7 activity rows, the ForEach's group line and a line per item.
    await expect(page.locator('.activity-runs__table tbody tr')).toHaveCount(10);
    await expect(page.locator('.run-failure')).toBeVisible();

    expect(await offRampText(page, d, '.run-failure'), 'banner: ramp').toEqual([]);
    expect(await offRampText(page, d, '.activity-runs'), 'activity runs: ramp').toEqual([]);
    await expectControlHeights(page, '.run-failure button', d, 'banner');

    const run = await styles(
      page,
      [
        '.run-failure',
        '.run-failure__actions',
        '.activity-runs__bar',
        '.activity-runs__bar > h2',
        '.activity-runs__search input',
        DEPTH_1,
        DEPTH_2,
        '.activity-runs__group > td',
        '.activity-runs__toggle',
      ],
      [
        'padding-top',
        'padding-left',
        'row-gap',
        'column-gap',
        'margin-top',
        'margin-right',
        'margin-bottom',
        'font-size',
        'font-weight',
      ],
    );
    expect(run['.run-failure']).toMatchObject({
      'padding-top': '4px',
      'padding-left': '12px',
      'row-gap': '4px',
      'column-gap': '12px',
      'margin-bottom': '8px',
      'font-size': BODY[d],
    });
    expect(run['.run-failure__actions']).toMatchObject({ 'column-gap': '12px' });
    expect(run['.activity-runs__bar']).toMatchObject({
      'column-gap': '8px',
      'margin-top': '4px',
      'font-size': BODY[d],
    });
    expect(run['.activity-runs__bar > h2']).toMatchObject({ 'margin-right': '8px' });
    expect(run['.activity-runs__search input']).toMatchObject({ 'font-size': BODY[d] });
    expect(run[DEPTH_1]).toMatchObject({ 'padding-left': '24px' });
    expect(run[DEPTH_2]).toMatchObject({ 'padding-left': '40px' });
    expect(run['.activity-runs__group > td']).toMatchObject({ 'font-weight': '600' });
    expect(run['.activity-runs__toggle']).toMatchObject({ 'column-gap': '4px' });

    // --- The Runs page, filtered to the pipeline --------------------------
    await page.goto(`/#/monitor/runs?pipeline=${encodeURIComponent(pipelineId)}`);
    await fluentRootReady(page);
    const spend = page.getByRole('region', { name: 'Lifetime spend' });
    await expect(spend).toBeVisible();
    await expect(page.locator('.runs-grid__row')).toHaveCount(1);

    const help = spend.getByTitle('About lifetime spend');
    const circle = await help.boundingBox();
    expect(circle, 'the spend ?').not.toBeNull();
    expect(Math.round(circle!.width), 'the spend ?: width').toBe(ICON_SIZE[d]);
    expect(Math.round(circle!.height), 'the spend ?: height').toBe(ICON_SIZE[d]);

    await help.click();
    const note = spend.getByRole('note');
    await expect(note).toBeVisible();
    await expect(note).toContainText(/not just the runs listed below/);

    // The line, its open note and the `?` beside the label, in ONE evaluate.
    const line = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const label = box('.runs-summary-line__label');
      const q = box('.runs-summary-line summary');
      const n = box('.runs-summary-line [role="note"]');
      return {
        centres: Math.abs(label.top + label.height / 2 - (q.top + q.height / 2)),
        noteLeft: n.left - box('.runs-summary-line').left,
        noteRight: window.innerWidth - n.right,
      };
    });
    expect(line.centres, 'the ? on the label line').toBeLessThanOrEqual(1);
    expect(line.noteLeft, 'the note anchors to the line').toBe(0);
    expect(line.noteRight, 'the note inside the viewport').toBeGreaterThanOrEqual(0);
    expect(await offRampText(page, d, '.runs-summary-line'), 'spend open: ramp').toEqual([]);

    const runs = await styles(
      page,
      ['.runs-summary-line', '.run-editor-link', '.runs-grid__pipeline-line', '.runs-grid__zone'],
      ['column-gap', 'font-size', 'font-weight', 'border-top-left-radius'],
    );
    expect(runs['.runs-summary-line']).toMatchObject({ 'column-gap': '4px' });
    expect(runs['.run-editor-link']).toMatchObject({
      'font-size': `${ICON_SIZE[d]}px`,
      'border-top-left-radius': '4px',
    });
    expect(runs['.runs-grid__pipeline-line']).toMatchObject({ 'column-gap': '4px' });
    expect(runs['.runs-grid__zone']).toMatchObject({ 'font-weight': '400' });

    await expectQuiet(page, problems);
  });
}
