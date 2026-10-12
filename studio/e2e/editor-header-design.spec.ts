import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady, resolvedPaletteColor } from './support/theme';
import {
  computedStyles as styles,
  CONTROL_H,
  DENSITIES,
  DESIGN_RUNS,
  drawnHeights,
  expectAppearance,
  expectControlHeights,
  preferAppearance,
} from './support/appearance';
import { triggerMenuItem } from './support/canvas';
import { dragNodeBy } from './support/canvasGraph';
import { expectInlineRow, inlineItems } from './support/inlineRow';
import { offRampText } from './support/typeRamp';
import { openSeededCanvas, type SeedDoc } from './support/seedDoc';

/**
 * #1594 OR40 S6j — the editor's header on the design system, at 1440x900 in
 * compact light and comfortable dark. `page-header.spec.ts` already measures
 * the header row's own controls; this measures what it cannot see: the state
 * badge, Save's dirty mark, the status strip (a transient, its `+N more` list
 * and the archived banner), and the Trigger now and Debug panels with their
 * parameter fields and error.
 *
 * Measured: all text on the type ramp; spacing on the 4px scale at the values
 * below; the panels' heading at the section step; their parameter rows stacked;
 * the strip's and panels' controls `--control-h`; and the panels' error in the
 * error colour.
 */

type Density = (typeof DENSITIES)[number];

/** The body and section steps per density, as `typeRamp.ts` publishes the ramp. */
const BODY_PX: Record<Density, number> = { compact: 13, comfortable: 14 };
const SECTION_PX: Record<Density, number> = { compact: 14, comfortable: 16 };

const HEADER = '.canvas-page > .page-header';
const STRIP = '[data-testid="editor-status-strip"]';
const PANEL = '.run-now-panel';
const LIST = '.editor-status-strip__list';
const BANNER = '.editor-status-strip__standing > .notice-conflict';

function doc(): SeedDoc {
  return {
    nodes: [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 320, y: 0 } },
    ],
    edges: [{ from: 'a', to: 'b', on: 'success' }],
    params: [
      { name: 'region', type: 'string', required: true, description: 'Where to read from' },
      { name: 'limit', type: 'number', required: false, default: 10 },
      { name: 'dryRun', type: 'boolean', required: false },
      { name: 'filter', type: 'json', required: false },
    ],
  };
}

/** The open run panel, measured: ramp, spacing, heading, stacked fields, controls. */
async function expectPanel(page: Page, d: Density, label: string): Promise<void> {
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  expect(await offRampText(page, d, PANEL), `${label}: ramp`).toEqual([]);
  const s = await styles(
    page,
    [PANEL, `${PANEL} > h2`, `${PANEL} .labelled-control`, `${PANEL} .form-actions`],
    [
      'row-gap',
      'padding-top',
      'padding-left',
      'border-top-left-radius',
      'font-size',
      'flex-direction',
    ],
  );
  expect(s[PANEL], `${label}: panel`).toMatchObject({
    'row-gap': '8px',
    'padding-top': '12px',
    'padding-left': '12px',
    'border-top-left-radius': '6px',
  });
  expect(s[`${PANEL} > h2`]?.['font-size'], `${label}: heading`).toBe(`${SECTION_PX[d]}px`);
  // A field's label over its control, as every other stacked form draws it.
  expect(s[`${PANEL} .labelled-control`], `${label}: field`).toMatchObject({
    'flex-direction': 'column',
    'row-gap': '4px',
  });
  expect(s[`${PANEL} .form-actions`]?.['row-gap'], `${label}: actions`).toBe('8px');
  // A JSON value's text lives in the box's `value`, which the ramp scan cannot see.
  expect(
    await page
      .locator(`${PANEL} .json-editor-input`)
      .evaluate((el) => getComputedStyle(el).fontSize),
    `${label}: JSON text`,
  ).toBe(`${BODY_PX[d]}px`);
  // No paragraph brings the browser's 1em margin into the column's gap.
  const margins = await page.evaluate(
    (sel) => [...document.querySelectorAll(`${sel} p`)].map((p) => getComputedStyle(p).marginTop),
    PANEL,
  );
  expect(margins.length, `${label}: hints`).toBeGreaterThan(0);
  expect(new Set(margins), `${label}: hint margins`).toEqual(new Set(['0px']));
  // Single-line controls only: a JSON value is a multi-line box.
  await expectControlHeights(page, `${PANEL} :is(input, select, button)`, d, label);
  expectInlineRow(`${label} actions`, await inlineItems(page, `${PANEL} .form-actions > button`));
}

for (const { density, theme } of DESIGN_RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6j — the editor header: badge, strip and run panels on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    const pipelineId = await openSeededCanvas(page, `S6j header ${density}`, doc());
    await expectAppearance(page, theme, d);

    // The header row and the state badge.
    expect(await offRampText(page, d, HEADER), 'header: ramp').toEqual([]);
    const badge = await styles(
      page,
      ['.editor-state-badge', '.editor-state-badge__part', '.dirty-dot'],
      ['column-gap', 'padding-top', 'padding-left', 'margin-left'],
    );
    expect(badge['.editor-state-badge']?.['column-gap'], 'badge gap').toBe('4px');
    expect(badge['.editor-state-badge__part'], 'badge pill').toMatchObject({
      'padding-top': '0px',
      'padding-left': '8px',
    });
    expect(badge['.dirty-dot']?.['margin-left'], 'dirty mark').toBe('4px');

    // Trigger now, then the error a malformed value raises.
    await (await triggerMenuItem(page, /^Trigger now/)).click();
    await expectPanel(page, d, 'Trigger now');
    await page.locator(PANEL).getByLabel('filter').fill('{');
    // Format on text that is not JSON shows the editor's problem line.
    await page.locator(PANEL).getByRole('button', { name: 'Format JSON' }).click();
    await expect(page.locator(`${PANEL} .json-editor-problem`)).not.toBeEmpty();
    await page.locator(PANEL).getByRole('button', { name: 'Start run' }).click();
    const error = page.locator(`${PANEL} .form-error`);
    await expect(error).toBeVisible();
    expect(await error.evaluate((el) => getComputedStyle(el).color), 'error colour').toBe(
      await resolvedPaletteColor(page, '--error'),
    );
    await expectPanel(page, d, 'Trigger now with an error');
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toHaveCount(0);

    await page.getByRole('button', { name: 'Debug', exact: true }).click();
    await expectPanel(page, d, 'Debug');
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toHaveCount(0);

    // Two live messages: a save and a copy, so the strip offers `+1 more`.
    await dragNodeBy(page, 1, 0, 120);
    await page.getByRole('button', { name: /^Save version/ }).click();
    await expect(page.locator(STRIP)).toContainText('Saved v2.');
    await page.getByTestId('rf__node-a').click();
    await page.keyboard.press('Meta+c');
    const more = page.locator(STRIP).getByRole('button', { name: '+1 more' });
    await expect(more).toBeVisible();
    expect(await offRampText(page, d, STRIP), 'strip: ramp').toEqual([]);
    const strip = await styles(page, [STRIP], ['column-gap', 'font-size']);
    expect(strip[STRIP], 'strip').toEqual({
      'column-gap': '12px',
      'font-size': `${BODY_PX[d]}px`,
    });
    expect(await drawnHeights(page, `${STRIP} button`), 'strip controls').toEqual([
      { name: '+1 more', h: CONTROL_H[d] },
    ]);
    await more.click();
    await expect(page.locator(LIST)).toBeVisible();
    expect(await offRampText(page, d, LIST), 'list: ramp').toEqual([]);
    expect(
      (await styles(page, [LIST], ['row-gap', 'padding-top', 'border-top-left-radius']))[LIST],
      'list',
    ).toEqual({
      'row-gap': '8px',
      'padding-top': '12px',
      'border-top-left-radius': '6px',
    });
    // Not closed again: the copy notice lapses after 6s, taking `+1 more` with
    // it, and the reload below closes the list anyway.

    // The standing banner: an archived pipeline's.
    const archived = await page.request.post(`/api/pipelines/${pipelineId}/archive`);
    expect(archived.status()).toBe(200);
    await page.reload();
    await fluentRootReady(page);
    await expect(page.locator(BANNER)).toBeVisible();
    expect(await offRampText(page, d, BANNER), 'banner: ramp').toEqual([]);
    expect(
      (await styles(page, [BANNER], ['column-gap', 'padding-left', 'padding-top']))[BANNER],
      'banner',
    ).toEqual({ 'column-gap': '12px', 'padding-left': '8px', 'padding-top': '0px' });
    for (const { name, h } of await drawnHeights(page, `${BANNER} button`)) {
      expect(h, `banner: ${name}`).toBe(CONTROL_H[d]);
    }
    // S6k — the buttons sit inside the banner's border with room to spare, in
    // comfortable density too, where a 32px button once filled it edge to edge.
    const clearances = await page.evaluate((sel) => {
      const banner = document.querySelector(sel)!;
      const box = banner.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(banner).borderTopWidth);
      return [...banner.querySelectorAll('button')].map((b) => {
        const r = b.getBoundingClientRect();
        return Math.min(r.top - box.top - border, box.bottom - border - r.bottom);
      });
    }, BANNER);
    expect(clearances.length, 'banner: buttons').toBeGreaterThan(0);
    expect(Math.min(...clearances), 'banner: button clearance').toBeGreaterThanOrEqual(2);
    // The banner fills the strip exactly, and the strip stays inside the header row.
    const [bannerBox, stripBox, headerBox] = await Promise.all([
      page.locator(BANNER).boundingBox(),
      page.locator(STRIP).boundingBox(),
      page.locator(HEADER).boundingBox(),
    ]);
    expect(bannerBox!.height, 'banner: the strip height').toBe(stripBox!.height);
    expect(stripBox!.y, 'strip: top in the header').toBeGreaterThanOrEqual(headerBox!.y);
    expect(stripBox!.y + stripBox!.height, 'strip: bottom in the header').toBeLessThanOrEqual(
      headerBox!.y + headerBox!.height,
    );

    await expectQuiet(page, problems);
  });
}
