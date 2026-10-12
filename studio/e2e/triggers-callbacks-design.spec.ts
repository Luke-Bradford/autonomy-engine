import { expect, test } from '@playwright/test';
import { allCapsText } from './support/allCaps';
import {
  computedStyles as styles,
  DENSITIES,
  DESIGN_RUNS,
  expectAppearance,
  PAD,
  pads,
  preferAppearance,
} from './support/appearance';
import { triggerMenuItem } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { childGaps } from './support/gaps';
import { chooseRowAction } from './support/rowMenu';
import { fireManualTrigger, seedTrigger, seedVersion, type SeedDoc } from './support/seedDoc';
import { fluentRootReady } from './support/theme';
import { offRampText } from './support/typeRamp';

/**
 * #1594 OR40 S6t — the editor's Triggers column, the one-time secret card and
 * the run page's pending callbacks on the design system, at 1440x900 in compact
 * light and comfortable dark: the column's panel, header, rows, empty state and
 * actions; a webhook trigger's secret as the Triggers page reveals it; and a
 * parked run's callback URL and its Complete wait editor.
 *
 * Measured: all their text on the type ramp, their declared spacing on the 4px
 * scale, and the RENDERED gap between each part and the next — a paragraph's
 * browser margin or a collapsed card margin shows there and nowhere else.
 */

type Density = (typeof DENSITIES)[number];

const HOLD: SeedDoc = {
  nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } }],
};

/** A callback wait: the run parks on it (as in `external-wait.spec.ts`). */
const APPROVAL = {
  nodes: [
    {
      id: 'approve',
      type: 'webhook',
      config: { timeoutSeconds: '${600}', outputs: [{ name: 'decision', type: 'string' }] },
      position: { x: 0, y: 0 },
    },
  ],
};

const CARD = [...PAD, 'row-gap', 'border-top-left-radius'] as const;

for (const { density, theme } of DESIGN_RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6t — the Triggers column, the secret card and pending callbacks on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);

    // --- The editor's Triggers column, empty ---------------------------------
    const stamp = `${density}-${String(Date.now())}`;
    const { pipelineId, pipelineVersionId } = await seedVersion(page, `e2e-s6t-${stamp}`, HOLD);
    const editor = `/#/author/pipelines/${encodeURIComponent(pipelineId)}`;
    await page.goto(editor);
    await fluentRootReady(page);
    await expectAppearance(page, theme, d);
    await (await triggerMenuItem(page, /^Edit triggers…/)).click();
    const column = page.getByTestId('pipeline-triggers');
    await expect(column.getByText('No triggers fire this pipeline yet.')).toBeVisible();
    // Header, empty line, actions: no paragraph margin in the gap.
    expect(await childGaps(page, '.pipeline-triggers__list-view'), 'empty column').toEqual([
      '↓8',
      '↓8',
    ]);
    expect(await offRampText(page, d, '.pipeline-triggers'), 'empty column: ramp').toEqual([]);

    // --- ...and with triggers ------------------------------------------------
    await seedTrigger(page, pipelineVersionId, `s6t-manual-${stamp}`, { enabled: false });
    await seedTrigger(page, pipelineVersionId, `s6t-hook-${stamp}`, {
      mode: 'webhook',
      webhook: { secretRef: 'e2e_s6t_unprovisioned' },
      enabled: false,
    });
    await page.reload();
    await fluentRootReady(page);
    await (await triggerMenuItem(page, /^Edit triggers…/)).click();
    await expect(column.getByRole('listitem')).toHaveCount(2);

    const t = await styles(
      page,
      [
        '.pipeline-triggers',
        '.pipeline-triggers__list-view',
        '.pipeline-triggers__header',
        '.pipeline-triggers__header h2',
        '.pipeline-triggers__list',
        '.pipeline-triggers__row',
        '.pipeline-triggers__actions',
      ],
      [...PAD, 'row-gap', 'column-gap', 'margin-top', 'margin-bottom', 'border-top-left-radius'],
    );
    // The column is a panel like the Activities and version-history columns.
    expect(t['.pipeline-triggers']).toMatchObject({ 'border-top-left-radius': '6px' });
    expect(t['.pipeline-triggers__list-view']).toMatchObject({ ...pads(12, 12), 'row-gap': '8px' });
    expect(t['.pipeline-triggers__header']).toMatchObject({ 'column-gap': '4px' });
    expect(t['.pipeline-triggers__header h2']).toMatchObject({
      'margin-top': '0px',
      'margin-bottom': '0px',
    });
    expect(t['.pipeline-triggers__list']).toMatchObject({ 'row-gap': '4px' });
    expect(t['.pipeline-triggers__row']).toMatchObject({
      ...pads(4, 8),
      'column-gap': '8px',
      'border-top-left-radius': '4px',
    });
    expect(t['.pipeline-triggers__actions']).toMatchObject({
      'row-gap': '8px',
      'column-gap': '8px',
    });
    expect(await childGaps(page, '.pipeline-triggers__list-view'), 'column').toEqual(['↓8', '↓8']);
    expect(await childGaps(page, '.pipeline-triggers__list'), 'rows').toEqual(['↓4']);
    expect(await offRampText(page, d, '.pipeline-triggers'), 'triggers column: ramp').toEqual([]);
    expect(await allCapsText(page, '.pipeline-triggers'), 'triggers column: ALL CAPS').toEqual([]);

    // --- Manage → Triggers: a webhook trigger's one-time secret --------------
    await page.goto('/#/manage/triggers');
    await page.getByRole('heading', { name: 'Triggers' }).waitFor();
    await chooseRowAction(page, 'Provision webhook secret', `s6t-hook-${stamp}`);
    const reveal = page.getByRole('status').filter({ hasText: 'Webhook secret for' });
    await expect(reveal).toBeVisible();
    const s = await styles(page, ['.secret-reveal'], CARD);
    expect(s['.secret-reveal']).toMatchObject({
      ...pads(12, 12),
      'row-gap': '8px',
      'border-top-left-radius': '6px',
    });
    expect(await childGaps(page, '.secret-reveal'), 'secret card').toEqual(['↓8', '↓8', '↓8']);
    // The page header's 8px above it, and the one table style's own 16px below.
    const around = await reveal.evaluate((card) => {
      const box = card.getBoundingClientRect();
      const header = document.querySelector('main .page-header')!.getBoundingClientRect();
      const table = document.querySelector('main table')!.getBoundingClientRect();
      return [Math.round(box.top - header.bottom), Math.round(table.top - box.bottom)];
    });
    expect(around, 'header → secret card → table').toEqual([8, 16]);
    expect(await offRampText(page, d, '.secret-reveal'), 'secret card: ramp').toEqual([]);
    expect(await allCapsText(page, '.secret-reveal'), 'secret card: ALL CAPS').toEqual([]);

    // --- A parked run's pending callbacks ------------------------------------
    const parked = await seedVersion(page, `e2e-s6t-approval-${stamp}`, APPROVAL);
    const runId = await fireManualTrigger(page, parked.pipelineVersionId, `s6t-park-${stamp}`);
    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    const waits = page.getByRole('list', { name: 'Pending callbacks' });
    await expect(waits.getByRole('listitem')).toHaveCount(1, { timeout: 20_000 });
    // Name, contract line, then Show callback URL and Complete wait side by side.
    expect(await childGaps(page, '.external-waits > li'), 'a wait').toEqual(['↓8', '↓8', '→8']);

    await waits.getByRole('button', { name: 'Show callback URL' }).click();
    // Name, contract line, the callback URL card, then Complete wait under it.
    expect(await childGaps(page, '.external-waits > li'), 'URL shown').toEqual(['↓8', '↓8', '↓8']);
    await waits.getByRole('button', { name: /^Complete wait for / }).click();
    await expect(waits.locator('.external-wait-complete')).toBeVisible();
    // Name, contract line, the callback URL card, the editor.
    expect(await childGaps(page, '.external-waits > li'), 'a wait, opened').toEqual([
      '↓8',
      '↓8',
      '↓8',
    ]);
    expect(await childGaps(page, '.external-waits .secret-reveal'), 'URL card').toEqual([
      '↓8',
      '↓8',
    ]);
    expect(await childGaps(page, '.external-wait-complete'), 'editor').toEqual(['↓8', '↓8']);

    const w = await styles(
      page,
      ['.external-waits .secret-reveal', '.external-wait-complete'],
      CARD,
    );
    for (const card of ['.external-waits .secret-reveal', '.external-wait-complete']) {
      expect(w[card], card).toMatchObject({
        ...pads(12, 12),
        'row-gap': '8px',
        'border-top-left-radius': '6px',
      });
    }
    // The body field takes the editor's content width, exactly.
    const field = await waits.locator('.external-wait-complete').evaluate((card) => {
      const input = card.querySelector('textarea')!.getBoundingClientRect();
      const s = getComputedStyle(card);
      const content = card.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      return Math.round(input.width - content);
    });
    expect(field, 'the body field spans the editor').toBe(0);
    expect(await offRampText(page, d, '.external-waits'), 'callbacks: ramp').toEqual([]);
    expect(await allCapsText(page, '.external-waits'), 'callbacks: ALL CAPS').toEqual([]);

    await expectQuiet(page, problems);
  });
}
