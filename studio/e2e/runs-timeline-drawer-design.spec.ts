import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { expectOnRampWithEachHelp, offRampText } from './support/typeRamp';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { seedConnection } from './support/seedResources';

/**
 * #1594 OR40 S6h — the cross-run timeline (the Runs page's Timeline view) and
 * the run page's activity-run drawer on the design system, at 1440x900 in
 * compact light and comfortable dark.
 *
 * The timeline is the `Section` primitive: a named level-2 region whose `?` is
 * what a lane and an overlap mean, with each lane a level-3 heading. The drawer
 * is measured on its own (`#run-detail-drawer`), on every one of its four tabs,
 * for each of two activity runs: a `file_list` that recorded its input and
 * output, and a `fail` that recorded an error. On each, all text is on the type
 * ramp with every `?` closed and then with each open in turn, and nothing
 * scrolls the page sideways.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

const DRAWER = '#run-detail-drawer';
const TABS = ['Input', 'Output', 'Error', 'Logs'] as const;

/** The page's sideways overflow, in ONE evaluate. */
function sideways(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const root = document.scrollingElement!;
    return Math.max(root.scrollWidth - root.clientWidth, content.scrollWidth - content.clientWidth);
  });
}

for (const { density, theme } of RUNS) {
  test(`#1594 OR40 S6h — the cross-run timeline and the run drawer: Sections, on the ramp with each ? open, no sideways scroll (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-s6h-')));
    try {
      writeFileSync(join(root, 'a.txt'), 'a');
      await page.setViewportSize({ width: 1440, height: 900 });
      await preferAppearance(page, theme, density as Density);

      const connectionId = await seedConnection(page, {
        name: `S6h files ${density}`,
        kind: 'fs',
        config: { roots: [root] },
      });
      const pipelineName = `S6h drawer ${density}`;
      const { pipelineVersionId } = await seedVersion(page, pipelineName, {
        nodes: [
          {
            id: 'ls',
            type: 'file_list',
            connectionId,
            config: { path: root },
            position: { x: 0, y: 0 },
          },
          {
            id: 'stop',
            type: 'fail',
            config: { message: 'S6h planned stop' },
            position: { x: 260, y: 0 },
          },
        ],
        edges: [{ id: 'e1', from: 'ls', to: 'stop', on: 'success' }],
      });
      const runId = await fireAndSettle(page, pipelineVersionId, `S6h ${density}`);

      // --- The cross-run timeline -------------------------------------------
      await page.goto(`/#/monitor/runs?q=${encodeURIComponent(pipelineName)}`);
      await fluentRootReady(page);
      await expectAppearance(page, theme, density as Density);
      await page.getByRole('button', { name: 'Timeline', exact: true }).click();
      const timeline = page.getByRole('region', { name: 'Timeline', exact: true });
      await expect(
        timeline.getByRole('heading', { level: 2, name: 'Timeline', exact: true }),
      ).toBeVisible();
      await expect(timeline.locator('summary[aria-label="About Timeline"]')).toBeVisible();
      await expect(
        timeline.getByRole('heading', { level: 3, name: pipelineName, exact: true }),
      ).toBeVisible();
      await expect(timeline.locator('.run-timeline-length').first()).toBeVisible();
      // Labels, not prose: what a lane and an overlap mean is the `?`, so the
      // axis note is the window alone.
      await expect(timeline.locator('.timeline-axis-note')).not.toContainText('same axis');
      expect(await sideways(page), 'timeline: sideways scroll').toBe(0);
      await expectOnRampWithEachHelp(page, density as Density, 'timeline');

      // --- The run drawer ---------------------------------------------------
      await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
      await fluentRootReady(page);
      const opens = page.locator('.activity-runs__table .activity-runs__open');
      await expect(opens).toHaveCount(2);
      for (let row = 0; row < 2; row += 1) {
        await opens.nth(row).click();
        const drawer = page.locator(DRAWER);
        await expect(drawer.getByRole('heading', { level: 2, name: /^Node / })).toBeVisible();
        // Labels, not prose: what Duration measures is its `?`, and its note
        // opens inside the drawer, not clipped by its edge.
        const about = drawer.locator('summary[aria-label="About Duration"]');
        await expect(about).toBeVisible();
        const note = drawer.getByText(/wall clock for this attempt/i);
        await expect(note).toHaveCount(1);
        await expect(note).toBeHidden();
        await about.click();
        await expect(note).toBeVisible();
        const clip = await page.evaluate((selector) => {
          const d = document.querySelector(selector)!.querySelector('.run-drawer__body')!;
          const box = d.getBoundingClientRect();
          const n = d.querySelector('details[open] > span')!.getBoundingClientRect();
          return {
            left: n.left - box.left,
            right: box.right - n.right,
            scroll: d.scrollWidth - d.clientWidth,
          };
        }, DRAWER);
        expect(clip.left, 'Duration note: past the drawer left').toBeGreaterThanOrEqual(0);
        expect(clip.right, 'Duration note: past the drawer right').toBeGreaterThanOrEqual(0);
        expect(clip.scroll, 'Duration note: drawer scrolls sideways').toBe(0);
        await page.keyboard.press('Escape');
        await expect(note).toBeHidden();
        const tabs = drawer.getByRole('tablist', { name: 'Activity run details' });
        for (const name of TABS) {
          const tab = tabs.getByRole('tab', { name, exact: true });
          await tab.click();
          await expect(tab).toHaveAttribute('aria-selected', 'true');
          const label = `drawer row ${row + 1} ${name}`;
          expect(await sideways(page), `${label}: sideways scroll`).toBe(0);
          // Not every tab has a `?` (an empty one says so in a line).
          if ((await drawer.locator('summary:visible').count()) > 0) {
            await expectOnRampWithEachHelp(page, density as Density, label, DRAWER);
          } else {
            expect(await offRampText(page, density as Density, DRAWER), label).toEqual([]);
          }
          await expect(drawer).toBeVisible();
        }
      }

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
