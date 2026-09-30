import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  addActivity,
  canvasNodes,
  fitAndSettle,
  scaleOf,
  viewportSettled,
  WIDE_CANVAS,
} from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { properties } from './support/panels';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { resolvedPaletteColor, setTheme } from './support/theme';

/**
 * #1394 OR3 — a card can be read at a glance: the whole name, and one line
 * saying what the step does.
 *
 * Through the real canvas because the claims are about LAYOUT — a name wrapping
 * to two lines inside a 220px card, a summary eliding on one — and jsdom lays
 * nothing out.
 */

/** Lines a text box occupies, measured in its own (untransformed) layout px. */
function linesOf(el: Locator): Promise<{ lines: number; clipped: boolean }> {
  return el.evaluate((e) => {
    const lineHeight = parseFloat(getComputedStyle(e).lineHeight);
    return {
      lines: Math.round(e.clientHeight / lineHeight),
      clipped: e.scrollHeight > e.clientHeight + 1,
    };
  });
}

function summaryOf(page: Page, id: string): Locator {
  return nodeById(page, id).locator('.flow-node-summary');
}

test.describe('#1394 readable activity cards', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE_CANVAS);
  });

  test('a long name wraps to two lines, whole, and is the tooltip', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'cards-long-name', {
      nodes: [
        {
          id: 'hook',
          type: 'webhook',
          config: { timeoutSeconds: '${3600}' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'w',
          type: 'wait',
          config: { seconds: '${30}' },
          policy: { retry: 2 },
          position: { x: 320, y: 0 },
        },
      ],
    });

    // The longest catalog title — it elided to "Webhook (externa…" at 168px.
    const title = nodeById(page, 'hook').locator('.flow-node-title');
    await expect(title).toHaveText('Webhook (external wait) 1');
    await expect(title).toHaveAttribute('title', 'Webhook (external wait) 1');
    expect(await linesOf(title)).toEqual({ lines: 2, clipped: false });

    // A short name stays on one line — the clamp is a ceiling, not a height.
    expect(await linesOf(nodeById(page, 'w').locator('.flow-node-title'))).toEqual({
      lines: 1,
      clipped: false,
    });

    await expect(summaryOf(page, 'hook')).toHaveText('callback · timeout 1h 00m');
    await expect(summaryOf(page, 'w')).toHaveText('wait 30s');
    await expect(
      nodeById(page, 'w').getByRole('img', { name: 'Retries up to 2 times' }),
    ).toHaveText('↻ 2');
    await expectQuiet(page, problems);
  });

  test('filling in a first field does not resize the card', async ({ page }) => {
    await openSeededCanvas(page, 'cards-reserved-row', {
      nodes: [{ id: 'a', type: 'wait', config: { seconds: '${5}' }, position: { x: 0, y: 0 } }],
    });
    // Added from the palette, so unconfigured: nothing to summarise yet.
    await addActivity(page, 'Wait');
    await fitAndSettle(page, 1);
    const added = canvasNodes(page).nth(1);
    const summary = added.locator('.flow-node-summary');
    await expect(summary).toHaveText('');
    // Both the box and the summary row: a box with several ports is held tall
    // by its port column (`nodeBoxHeight`), so the ROW is what shows a reserve.
    const height = () =>
      added.locator('.flow-node').evaluate((e) => {
        const meta = e.querySelector('.flow-node-meta') as HTMLElement;
        return [(e as HTMLElement).offsetHeight, meta.offsetHeight];
      });
    const before = await height();

    await added.click();
    await properties(page).getByLabel('seconds', { exact: true }).fill('${45}');
    await properties(page).getByRole('button', { name: 'Apply config', exact: true }).click();
    await expect(summary).toHaveText('wait 45s');
    expect(await height()).toEqual(before);
  });

  test('a small graph is framed at 1:1, not blown up', async ({ page }) => {
    await openSeededCanvas(page, 'cards-fit-zoom', {
      nodes: [{ id: 'a', type: 'wait', config: { seconds: '${5}' }, position: { x: 0, y: 0 } }],
    });
    // React Flow's default fit zooms a lone node to 2x.
    expect(Number(scaleOf(await viewportSettled(page)))).toBeLessThanOrEqual(1);
  });

  test('the summary is muted text in both themes', async ({ page }) => {
    await openSeededCanvas(page, 'cards-themes', {
      nodes: [{ id: 'w', type: 'wait', config: { seconds: '${30}' }, position: { x: 0, y: 0 } }],
    });
    const colours: string[] = [];
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      const muted = await resolvedPaletteColor(page, '--muted');
      const drawn = await summaryOf(page, 'w').evaluate((e) => getComputedStyle(e).color);
      expect(drawn, theme).toBe(muted);
      colours.push(drawn);
    }
    // The token resolves per theme rather than to one fixed colour.
    expect(colours[0]).not.toBe(colours[1]);
  });
});
