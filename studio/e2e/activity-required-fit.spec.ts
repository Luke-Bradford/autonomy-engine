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

/**
 * One read per tab: each REQUIRED control's label and how far its first line
 * (28px, a compact control's height) runs past the panel's visible bottom, with
 * the panel scrolled to the top. A first line is what an author needs to see the
 * field and start typing: a textarea grows with its text, and a whole one need
 * not fit for the field to be found.
 *
 * Required is read three ways, so no way of drawing a required field escapes:
 * `aria-required`/`required` on the control, a label carrying the required mark
 * (its control by `for`), and a row list whose label carries the mark. A control
 * with no box at all reports `null`: hidden is not "on screen".
 */
function requiredOverflow(page: Page) {
  return properties(page)
    .getByRole('tabpanel')
    .evaluate((panelEl) => {
      const panel = panelEl.closest<HTMLElement>('.property-panel')!;
      panel.scrollTop = 0;
      const visibleBottom = panel.getBoundingClientRect().top + panel.clientHeight;
      const found = new Map<HTMLElement, string>();
      const q = (sel: string) => [...panelEl.querySelectorAll<HTMLElement>(sel)];
      for (const el of q(
        '[aria-required="true"], input[required], textarea[required], select[required]',
      )) {
        found.set(el, el.getAttribute('aria-label') ?? el.id);
      }
      for (const label of panelEl.querySelectorAll<HTMLLabelElement>('label:has(.required-mark)')) {
        const control = label.htmlFor ? document.getElementById(label.htmlFor) : null;
        if (control !== null) found.set(control, label.textContent ?? '');
      }
      for (const head of q('.object-list-label:has(.required-mark)')) {
        found.set(head.closest<HTMLElement>('[role="group"]')!, head.textContent ?? '');
      }
      return [...found].map(([el, field]) => {
        const box = el.getBoundingClientRect();
        return {
          field: (field || el.tagName).trim(),
          overflow:
            box.height === 0
              ? null
              : Math.round(box.top + Math.min(box.height, 28) - visibleBottom),
        };
      });
    });
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
    expect(tabCount, `${name} has property tabs`).toBeGreaterThan(0);
    for (let i = 0; i < tabCount; i += 1) {
      const tab = tabs(page).getByRole('tab').nth(i);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      // The panel id ends in the tab's catalog key (`…-panel-location`).
      const label = (await tab.getAttribute('aria-controls'))?.split('-panel-')[1] ?? String(i);
      for (const { field, overflow } of await requiredOverflow(page)) {
        measured += 1;
        if (overflow === null) misses.push(`${name} › ${label} › ${field}: not drawn`);
        else if (overflow > 0) misses.push(`${name} › ${label} › ${field}: ${overflow}px below`);
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

test("a field's explanation is behind the ? beside its label, and still describes the field", async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 field help', {
    nodes: [{ id: 'h', type: 'http_request', position: { x: 0, y: 0 }, config: { url: '/a' } }],
  });
  await nodeById(page, 'h').click();

  const url = properties(page).getByRole('textbox', { name: 'Request URL', exact: true });
  const about = /joined to the connection's base URL/;
  // Described while the note is CLOSED: Chromium's own accessible description.
  await expect(url).toHaveAccessibleDescription(about);
  const note = properties(page).getByRole('note').filter({ hasText: about });
  await expect(note).toBeHidden();
  // The label's text and its required mark share one 28px row.
  const label = properties(page).locator('label', { hasText: /^Request URL$/ });
  expect((await label.boundingBox())!.height).toBeLessThanOrEqual(28);

  await properties(page).getByLabel('About Request URL', { exact: true }).click();
  await expect(note).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(note).toBeHidden();
  await expectQuiet(page, problems);
});
