import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { canvasNodes, toolbox } from './support/canvasGraph';
import { nodeMenuAction, properties } from './support/panels';

/**
 * #1477 OR29 acceptance — at 1280×720, with the dock at its default height, every
 * catalog activity's REQUIRED fields are on screen on their tab without a scroll.
 *
 * The catalog is iterated through the Activities toolbox, which lists every
 * catalog entry, so an activity added to the catalog is measured here without
 * this file changing. Every miss is collected and reported at once.
 */
test.use({ viewport: { width: 1280, height: 720 } });

const tabs = (page: Page) => properties(page).getByRole('tablist', { name: 'Activity properties' });

/** A control the form marks required: `aria-required`, or a native `required`. */
const REQUIRED = '[aria-required="true"], input[required], textarea[required], select[required]';

/**
 * One read per tab: each required control's accessible label and how far it runs
 * past the panel's visible bottom, with the panel scrolled to the top.
 */
function requiredOverflow(page: Page) {
  return properties(page)
    .getByRole('tabpanel')
    .evaluate((panelEl, selector) => {
      const panel = panelEl.closest<HTMLElement>('.property-panel')!;
      panel.scrollTop = 0;
      const visibleBottom = panel.getBoundingClientRect().top + panel.clientHeight;
      return [...panelEl.querySelectorAll<HTMLElement>(selector)].map((el) => ({
        field:
          el.getAttribute('aria-label') ??
          (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ??
          el.tagName,
        overflow: Math.round(el.getBoundingClientRect().bottom - visibleBottom),
      }));
    }, REQUIRED);
}

test('every catalog activity shows its required fields without a scroll at 1280×720', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 required fit', { nodes: [] });

  const item = '.activity-toolbox__item';
  const containers = await toolbox(page)
    .getByRole('list', { name: 'Containers', exact: true })
    .locator(item)
    .allTextContents();
  const activities = (await toolbox(page).locator(item).allTextContents()).filter(
    (name) => !containers.includes(name),
  );
  expect(activities.length).toBeGreaterThan(10);

  const misses: string[] = [];
  let measured = 0;
  for (const name of activities) {
    // The canvas is emptied after each one, so the one node is the one just added.
    await toolbox(page).getByRole('button', { name, exact: true }).click();
    await expect(canvasNodes(page)).toHaveCount(1);
    const id = (await canvasNodes(page).getAttribute('data-id'))!;
    await nodeById(page, id).click();

    const tabCount = await tabs(page).getByRole('tab').count();
    for (let i = 0; i < tabCount; i += 1) {
      const tab = tabs(page).getByRole('tab').nth(i);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const label = (await tab.getAttribute('aria-controls')) ?? String(i);
      for (const { field, overflow } of await requiredOverflow(page)) {
        measured += 1;
        if (overflow > 0) misses.push(`${name} › ${label} › ${field}: ${overflow}px below`);
      }
    }
    await nodeMenuAction(page, 'Delete node');
    await expect(nodeById(page, id)).toHaveCount(0);
  }

  // A selector that matched nothing would pass vacuously.
  expect(measured).toBeGreaterThan(activities.length);
  expect(misses).toEqual([]);
  await expectQuiet(page, problems);
});
