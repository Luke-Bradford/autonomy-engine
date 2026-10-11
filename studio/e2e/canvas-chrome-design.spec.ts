import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import {
  CONTROL_H,
  computedStyles as styles,
  DENSITIES,
  drawnHeights,
  expectAppearance,
  expectControlHeights,
  preferAppearance,
} from './support/appearance';
import { editorMenuItem, openCanvas } from './support/canvas';
import { connectById, viewportSettled } from './support/canvasGraph';
import { offRampText } from './support/typeRamp';
import { mintVersion, nodeById, seedVersion, type SeedDoc } from './support/seedDoc';

/**
 * #1594 OR40 S6k — the editor's canvas chrome on the design system, at 1440x900
 * in compact light and comfortable dark: the empty-canvas guide, the
 * implicit-chain advisory, the minimap, the version preview bar (with and
 * without its refusal), the connect refusal with its back-edge offer, and the
 * leave prompt.
 *
 * Measured: all text on the type ramp; spacing on the 4px scale at the values
 * below; surfaces at `--radius-surface`; and every button in a surface at
 * `--control-h`.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

const EMPTY = '.canvas-empty';
const CARD = '.canvas-empty__card';
const ADVISORY = '.canvas-advisory';
const REFUSAL = '.canvas-refusal';
const MINIMAP = '.react-flow__minimap';
const CONTROLS = '.react-flow__controls';
const PREVIEW = '[data-testid="canvas-preview"]';
const BAR = '[data-testid="version-preview-bar"]';
const LEAVE = '.editor-leave-prompt';

/** A panel surface: 8px by 12px, at the surface radius. */
const PANEL_BOX = {
  'padding-top': '8px',
  'padding-left': '12px',
  'border-top-left-radius': '6px',
};

/** v1 is routed; the head, v2, is not, so the canvas opens under the advisory. */
const V1: SeedDoc = {
  nodes: [
    { id: 'a', position: { x: 0, y: 0 } },
    { id: 'b', position: { x: 320, y: 0 } },
  ],
  edges: [{ from: 'a', to: 'b', on: 'success' }],
};
const V2: SeedDoc = { nodes: V1.nodes };

async function openTwoVersions(page: Page, name: string): Promise<void> {
  const { pipelineId, pipelineVersionId } = await seedVersion(page, name, V1);
  await mintVersion(page, pipelineId, V2, pipelineVersionId, name);
  await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
  await fluentRootReady(page);
  await page.locator('.react-flow__renderer').waitFor();
  for (const n of V2.nodes) await expect(nodeById(page, n.id)).toHaveClass(/\bdraggable\b/);
  await viewportSettled(page);
}

for (const { density, theme } of RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6k — the canvas chrome: guide, advisory, minimap, preview, refusal and leave prompt on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);

    // The empty canvas's guide and its starter templates.
    await openCanvas(page, `S6k empty ${density} ${Date.now()}`);
    await expectAppearance(page, theme, d);
    await expect(page.locator(EMPTY)).toBeVisible();
    expect(await offRampText(page, d, EMPTY), 'guide: ramp').toEqual([]);
    const guide = await styles(
      page,
      [EMPTY, CARD, '.canvas-empty__lead', '.canvas-empty__templates', '.canvas-empty__template'],
      ['padding-top', 'padding-left', 'margin-bottom', 'row-gap', 'border-top-left-radius'],
    );
    expect(guide[EMPTY]?.['padding-top'], 'guide: inset').toBe('16px');
    expect(guide[CARD], 'guide: card').toMatchObject({
      'padding-top': '12px',
      'padding-left': '12px',
      'border-top-left-radius': '6px',
    });
    expect(guide['.canvas-empty__lead']?.['margin-bottom'], 'guide: lead').toBe('8px');
    expect(guide['.canvas-empty__templates']?.['row-gap'], 'guide: templates').toBe('8px');
    expect(guide['.canvas-empty__template'], 'guide: template').toMatchObject({
      'padding-top': '8px',
      'padding-left': '12px',
      'row-gap': '0px',
      'border-top-left-radius': '4px',
    });

    // An edge-less doc: the advisory, and the minimap beside it.
    await openTwoVersions(page, `S6k chrome ${density} ${Date.now()}`);
    await expect(page.locator(ADVISORY)).toBeVisible();
    expect(await offRampText(page, d, ADVISORY), 'advisory: ramp').toEqual([]);
    const chrome = await styles(
      page,
      [ADVISORY, MINIMAP, CONTROLS],
      ['padding-top', 'padding-left', 'border-top-left-radius', 'margin-top', 'margin-right'],
    );
    expect(chrome[ADVISORY], 'advisory').toMatchObject({ ...PANEL_BOX, 'margin-top': '16px' });
    expect(chrome[MINIMAP], 'minimap').toMatchObject({
      'margin-right': '16px',
      'border-top-left-radius': '6px',
    });
    // The zoom controls share the minimap's bottom band, at the same inset.
    expect(chrome[CONTROLS]?.['margin-top'], 'controls').toBe('16px');

    // The preview of an older version, then of the head, which it refuses to restore.
    await (await editorMenuItem(page, /^(Show|Hide) version history/)).click();
    const rows = page.locator('.version-history-row');
    await expect(rows).toHaveCount(2);
    await rows.nth(1).click();
    await expect(page.locator(BAR)).toContainText('Viewing v1 — read-only');
    for (const label of ['preview', 'preview with a refusal']) {
      expect(await offRampText(page, d, BAR), `${label}: ramp`).toEqual([]);
      const bar = await styles(
        page,
        [PREVIEW, BAR],
        ['row-gap', 'column-gap', 'padding-top', 'padding-left', 'border-top-left-radius'],
      );
      expect(bar[PREVIEW]?.['row-gap'], `${label}: under the bar`).toBe('12px');
      expect(bar[BAR], `${label}: bar`).toMatchObject({
        'column-gap': '12px',
        ...PANEL_BOX,
      });
      await expectControlHeights(page, `${BAR} button`, d, label);
      if (label === 'preview') {
        await rows.nth(0).click();
        await expect(page.locator('.version-preview-refusal')).toBeVisible();
      }
    }
    await page.locator(BAR).getByRole('button', { name: 'Back to editing' }).click();
    await expect(page.locator(BAR)).toHaveCount(0);
    await (await editorMenuItem(page, /^Hide version history/)).click();
    await expect(rows).toHaveCount(0);
    await viewportSettled(page);

    // A forward edge that would close a loop: refused, with the back-edge offer.
    await connectById(page, 'a', 'b');
    await expect(page.locator(ADVISORY)).toHaveCount(0);
    await connectById(page, 'b', 'a');
    const refusal = page.locator(REFUSAL);
    await expect(refusal.getByRole('button', { name: 'Make it a back-edge' })).toBeVisible();
    expect(await offRampText(page, d, REFUSAL), 'refusal: ramp').toEqual([]);
    expect(
      (await styles(page, [REFUSAL], [...Object.keys(PANEL_BOX), 'column-gap']))[REFUSAL],
      'refusal',
    ).toEqual({ ...PANEL_BOX, 'column-gap': '8px' });
    expect(await drawnHeights(page, `${REFUSAL} button`), 'refusal: controls').toEqual([
      { name: 'Make it a back-edge', h: CONTROL_H[d] },
      { name: 'Dismiss', h: CONTROL_H[d] },
    ]);
    // The dismiss is the shared icon button: a square glyph, not a text button.
    const dismiss = refusal.getByRole('button', { name: 'Dismiss' });
    expect((await dismiss.boundingBox())?.width, 'refusal: dismiss is square').toBe(CONTROL_H[d]);
    await dismiss.click();
    await expect(refusal).toHaveCount(0);

    // Leaving with that edge unsaved asks first.
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Pipelines' })
      .click();
    await expect(page.locator(LEAVE)).toBeVisible();
    expect(await offRampText(page, d, LEAVE), 'leave prompt: ramp').toEqual([]);
    const leave = await styles(
      page,
      [LEAVE, `${LEAVE} .unsaved-confirm p`],
      ['padding-top', 'padding-left', 'border-top-left-radius', 'margin-bottom'],
    );
    expect(leave[LEAVE], 'leave prompt').toMatchObject({
      'padding-top': '12px',
      'padding-left': '12px',
      'border-top-left-radius': '6px',
    });
    expect(leave[`${LEAVE} .unsaved-confirm p`]?.['margin-bottom'], 'leave prompt: text').toBe(
      '8px',
    );
    await expectControlHeights(page, `${LEAVE} button`, d, 'leave prompt');
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator(LEAVE)).toHaveCount(0);

    await expectQuiet(page, problems);
  });
}
