import { expect, test } from '@playwright/test';
import { addActivity } from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { runFromEditor } from './support/canvas';
import {
  computedStyles as styles,
  DENSITIES,
  DESIGN_RUNS,
  expectAppearance,
  ICON_SIZE,
  preferAppearance,
} from './support/appearance';
import {
  fireAndSettle,
  nodeById,
  openSeededCanvas,
  seedVersion,
  STAGED_WAIT_THEN_FAIL as STAGED,
} from './support/seedDoc';
import { fluentRootReady } from './support/theme';
import { offRampText } from './support/typeRamp';

/**
 * #1594 OR40 S6n — the canvas's own pieces on the design system, at 1440x900 in
 * compact light and comfortable dark: the activity card (glyph, name, summary,
 * badges), its issue count, the port labels and edge labels (always in the DOM
 * at opacity 0, so measured without a hover), the container box with its label
 * and buttons, the run page's Graph tab, and the editor's run chip.
 *
 * Measured: all text on the type ramp; spacing on the 4px scale at the values
 * below; radii from the tokens; the issue count a circle at `--icon-size`; a run
 * card still exactly `RUN_NODE_BASE_HEIGHT` with nothing overflowing it.
 */

type Density = (typeof DENSITIES)[number];

const CANVAS = '.canvas-wrap';
const RUN_CANVAS = '[data-testid="run-canvas"]';

for (const { density, theme } of DESIGN_RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6n — the authoring canvas's cards, ports and containers on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    await openSeededCanvas(page, `S6n canvas ${density} ${Date.now()}`, STAGED);
    await expectAppearance(page, theme, d);

    // A palette-dropped Web has no URL yet, so it carries an issue count.
    await addActivity(page, 'Web');
    const issue = page.locator('.flow-issue-badge');
    await expect(issue).toHaveCount(1);
    await expect(nodeById(page, 'hold').locator('.flow-node-badge')).toHaveCount(1);
    await expect(page.locator('.flow-port-label').first()).toBeAttached();
    await expect(page.locator('.react-flow__edge-text').first()).toBeAttached();

    expect(await offRampText(page, d, CANVAS), 'canvas: ramp').toEqual([]);

    const s = await styles(
      page,
      [
        '.flow-node',
        '.flow-node-body',
        '.flow-node-meta',
        '.flow-node-badge',
        '.flow-port-label',
        '.flow-container',
        '.flow-container-label',
        '.flow-container-delete',
        '.canvas-body',
        CANVAS,
      ],
      [
        'padding-top',
        'padding-left',
        'column-gap',
        'row-gap',
        'height',
        'border-top-left-radius',
        'margin-top',
        'top',
        'left',
        'font-size',
      ],
    );
    expect(s['.flow-node']?.['padding-top'], 'card').toBe('8px');
    expect(s['.flow-node']?.['padding-left'], 'card').toBe('12px');
    expect(s['.flow-node']?.['column-gap'], 'card glyph to name').toBe('8px');
    expect(s['.flow-node']?.['border-top-left-radius'], 'card').toBe('6px');
    expect(s['.flow-node-body']?.['row-gap'], 'name to summary').toBe('4px');
    expect(s['.flow-node-meta']?.['column-gap'], 'summary row').toBe('4px');
    // The reserved summary row is one body line tall in both densities.
    expect(s['.flow-node-meta']?.['height'], 'summary row').toBe('20px');
    expect(s['.flow-node-badge']?.['padding-left'], 'badge').toBe('4px');
    expect(s['.flow-node-badge']?.['border-top-left-radius'], 'badge').toBe('4px');
    expect(s['.flow-port-label']?.['padding-left'], 'port label').toBe('4px');
    expect(s['.flow-port-label']?.['padding-top'], 'port label').toBe('0px');
    expect(s['.flow-port-label']?.['border-top-left-radius'], 'port label').toBe('4px');
    expect(s['.flow-container']?.['border-top-left-radius'], 'container').toBe('6px');
    expect(s['.flow-container-label']?.['top'], 'container label').toBe('4px');
    expect(s['.flow-container-label']?.['left'], 'container label').toBe('12px');
    expect(s['.flow-container-delete']?.['font-size'], 'container delete').toBe(
      d === 'compact' ? '13px' : '14px',
    );
    expect(s['.canvas-body']?.['column-gap'], 'canvas body').toBe('8px');
    expect(s['.canvas-body']?.['margin-top'], 'canvas body').toBe('4px');
    expect(s[CANVAS]?.['border-top-left-radius'], 'canvas frame').toBe('6px');

    // The glyph and the issue count are both `--icon-size`; the count is a
    // circle centred on the card's corner. Sizes are layout boxes (the canvas's
    // zoom scales a client rect); the corner offset is a ratio of two client
    // rects, so the zoom cancels out of it.
    const shape = await page.evaluate(() => {
      const badge = document.querySelector('.flow-issue-badge')!;
      const card = badge.closest('.react-flow__node')!.getBoundingClientRect();
      const r = badge.getBoundingClientRect();
      const zoom = r.width / (badge as HTMLElement).offsetWidth;
      const glyph = document.querySelector('.flow-node-icon svg')!;
      return {
        w: (badge as HTMLElement).offsetWidth,
        h: (badge as HTMLElement).offsetHeight,
        radius: parseFloat(getComputedStyle(badge).borderTopLeftRadius),
        cornerX: Math.round((r.left + r.width / 2 - card.right) / zoom),
        cornerY: Math.round((r.top + r.height / 2 - card.top) / zoom),
        glyph: parseFloat(getComputedStyle(glyph).width),
      };
    });
    expect(shape.w, 'issue count width').toBe(ICON_SIZE[d]);
    expect(shape.h, 'issue count height').toBe(ICON_SIZE[d]);
    expect(shape.radius, 'issue count radius').toBeGreaterThanOrEqual(ICON_SIZE[d] / 2);
    expect(Math.abs(shape.cornerX), 'issue count on the corner (x)').toBeLessThanOrEqual(1);
    expect(Math.abs(shape.cornerY), 'issue count on the corner (y)').toBeLessThanOrEqual(1);
    expect(shape.glyph, 'glyph').toBe(ICON_SIZE[d]);

    await expectQuiet(page, problems);
  });

  test(`#1594 OR40 S6n — the Graph tab's cards on the ramp, inside their fixed height (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    const name = `S6n graph ${density} ${Date.now()}`;
    const { pipelineVersionId } = await seedVersion(page, name, STAGED);
    const runId = await fireAndSettle(page, pipelineVersionId, name);
    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}?rdTab=graph`);
    await fluentRootReady(page);
    await expectAppearance(page, theme, d);
    const canvas = page.locator(RUN_CANVAS);
    // The overlay has landed: the measured wait has its facts.
    await expect(canvas.locator('.run-node-facts')).toHaveCount(1);

    expect(await offRampText(page, d, RUN_CANVAS), 'graph: ramp').toEqual([]);

    const s = await styles(
      page,
      ['.run-canvas', '.run-container', '.run-node', '.run-node-card', '.run-node-foot'],
      ['border-top-left-radius', 'row-gap', 'column-gap', 'height', 'font-size'],
    );
    expect(s['.run-canvas']?.['border-top-left-radius'], 'graph frame').toBe('6px');
    expect(s['.run-container']?.['border-top-left-radius'], 'run container').toBe('6px');
    expect(s['.run-node']?.['row-gap'], 'card to foot').toBe('4px');
    expect(s['.run-node-card']?.['column-gap'], 'glyph to name').toBe('8px');
    expect(s['.run-node-foot']?.['column-gap'], 'status to facts').toBe('8px');
    expect(s['.run-node-foot']?.['height'], 'foot').toBe('16px');
    expect(s['.run-node-foot']?.['font-size'], 'foot').toBe('12px');

    // Each card is still drawn at `RUN_NODE_BASE_HEIGHT`, and nothing in it --
    // the foot's status and facts included -- reaches past its bottom edge.
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('.run-node')].map((node) => {
        const r = node.getBoundingClientRect();
        const bottom = Math.max(
          ...[...node.querySelectorAll('*')]
            // The open button is laid over the whole card (`inset: 0`), so its
            // bottom IS the card's and would make this check vacuous.
            .filter((c) => !c.classList.contains('run-node-open'))
            .map((c) => c.getBoundingClientRect().bottom),
        );
        return {
          id: node.closest('.react-flow__node')?.getAttribute('data-id'),
          h: (node as HTMLElement).offsetHeight,
          overflows: node.scrollHeight > node.clientHeight,
          spill: Math.round(bottom - r.bottom),
        };
      }),
    );
    expect(cards.length, 'cards drawn').toBe(2);
    for (const card of cards) {
      expect(card.h, `${card.id} height`).toBe(104);
      expect(card.overflows, `${card.id} overflows`).toBe(false);
      expect(card.spill, `${card.id} content inside`).toBeLessThanOrEqual(0);
    }

    await expectQuiet(page, problems);
  });

  test(`#1594 OR40 S6n — the editor's run chip on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    await openSeededCanvas(page, `S6n run chip ${density} ${Date.now()}`, {
      nodes: [{ id: 'w', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
    });
    await expectAppearance(page, theme, d);

    await runFromEditor(page);
    await expect(nodeById(page, 'w').getByTestId('node-run-status')).toContainText('success', {
      timeout: 20_000,
    });

    expect(await offRampText(page, d, CANVAS), 'run chip: ramp').toEqual([]);
    const chip = (
      await styles(page, ['.flow-node-run'], ['padding-left', 'column-gap', 'font-size'])
    )['.flow-node-run'];
    expect(chip?.['padding-left'], 'chip').toBe('8px');
    expect(chip?.['column-gap'], 'chip').toBe('8px');
    expect(chip?.['font-size'], 'chip').toBe('12px');

    await expectQuiet(page, problems);
  });
}
