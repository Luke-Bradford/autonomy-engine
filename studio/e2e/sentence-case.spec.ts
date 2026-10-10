import { expect, test, type Page } from '@playwright/test';
import { ACRONYMS, sentenceCaseProblem } from '../packages/web/src/testing/sentenceCase';
import { openCanvas } from './support/canvas';
import { addActivity, canvasNodes, toolbox } from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #1594 OR40 S4 — sentence case on the rendered page, at 1440x900 in both
 * densities.
 *
 * The unit test holds the label SOURCES (catalog, nav, kind labels) and the
 * stylesheets to the rule. This holds what the browser draws: no element is
 * capitalised by its computed style, no heading, tab, button or column header
 * reads in capitals, and the palette and tab names are sentence case as shown.
 */

type Density = 'compact' | 'comfortable';

async function setDensity(page: Page, density: Density) {
  await page.goto('/#/settings');
  await fluentRootReady(page);
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption(density);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

/** Everything on the page that is drawn in capitals, by style or by its own text. */
function capitals(page: Page, acronyms: readonly string[]) {
  return page.evaluate((acronyms) => {
    const kept = new Set(acronyms);
    // A time column names the viewer's zone ("Started GMT+1", "BST"): a value,
    // not a label, so the browser's own short zone name is kept.
    const zone = new Intl.DateTimeFormat('en', { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    for (const w of (zone ?? '').split(/[^\p{L}]+/u)) kept.add(w);
    const found: string[] = [];
    // `getClientRects`, not `offsetParent`: a fixed-position element has no offset parent.
    const visible = (el: Element) => el.getClientRects().length > 0;
    for (const el of document.querySelectorAll('body *')) {
      const t = getComputedStyle(el).textTransform;
      if ((t === 'uppercase' || t === 'capitalize') && visible(el) && el.textContent?.trim()) {
        found.push(`${el.tagName.toLowerCase()}.${el.className}: text-transform ${t}`);
      }
    }
    const named = 'h1, h2, h3, h4, button, [role="tab"], th, legend, label';
    for (const el of document.querySelectorAll(named)) {
      if (!visible(el)) continue;
      for (const word of (el.textContent ?? '').split(/[^\p{L}]+/u)) {
        // The glossary's one banned variant: the term is "Parameters".
        if (/^params?$/i.test(word)) {
          found.push(`${el.tagName.toLowerCase()} "${el.textContent?.trim()}": ${word}`);
        }
        if (
          word.length > 1 &&
          word === word.toUpperCase() &&
          /\p{Lu}/u.test(word) &&
          !kept.has(word)
        ) {
          found.push(`${el.tagName.toLowerCase()} "${el.textContent?.trim()}": ${word}`);
        }
      }
    }
    return found;
  }, acronyms);
}

/** The visible names of the palette's activities and of every tab on the page. */
function shownNames(page: Page) {
  return page.evaluate(() => {
    // Read what is drawn as the name: a tab also holds a hidden copy of its label
    // that reserves the semibold width (Fluent's reserved-space slot), and an
    // issue badge ("⚠ 1") is not part of the name.
    const text = (el: Element) => {
      const copy = el.cloneNode(true) as Element;
      copy
        .querySelectorAll('[aria-hidden="true"], [class*="reserved-space"]')
        .forEach((n) => n.remove());
      return (copy.textContent ?? '').replace(/⚠\s*\d+/gu, '').trim();
    };
    return {
      palette: [...document.querySelectorAll('.activity-toolbox__item')].map(text),
      tabs: [...document.querySelectorAll('[role="tab"]')].map(text),
    };
  });
}

for (const density of ['compact', 'comfortable'] as const) {
  test(`#1594 OR40 S4 — sentence case on Pipelines, Runs and the editor (${density})`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await setDensity(page, density);

    await page.goto('/#/author/pipelines');
    await fluentRootReady(page);
    await expect(
      page.getByRole('heading', { name: 'Factory resources', exact: true }),
    ).toBeVisible();
    expect(await capitals(page, ACRONYMS), 'Pipelines').toEqual([]);

    // Runs before the editor: leaving an unsaved editor by URL trips its blocker.
    await page.goto('/#/monitor/runs');
    await fluentRootReady(page);
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
    expect(await capitals(page, ACRONYMS), 'Runs').toEqual([]);

    await openCanvas(page, `e2e s4 case ${density} ${Date.now()}`);
    await addActivity(page, 'Copy data');
    await canvasNodes(page).first().click();
    await expect(page.getByRole('tab').first()).toBeVisible();
    // The palette's group headings were the most visible capitals in the app.
    await expect(toolbox(page).getByRole('button', { name: 'Control flow' })).toBeVisible();
    expect(await capitals(page, ACRONYMS), 'editor').toEqual([]);

    // The pipeline's own properties, on the Parameters tab: the glossary term,
    // its section and its Add button.
    await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
    await page.getByRole('tab', { name: 'Parameters', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add parameter', exact: true })).toBeVisible();
    expect(await capitals(page, ACRONYMS), 'pipeline parameters').toEqual([]);

    const shown = await shownNames(page);
    expect(shown.palette.length, 'palette entries').toBeGreaterThan(10);
    expect(shown.palette).toContain('Copy data');
    expect(shown.tabs.length, 'tabs').toBeGreaterThan(0);
    const offRule = [...shown.palette, ...shown.tabs]
      .map((n) => [n, sentenceCaseProblem(n)] as const)
      .filter(([, p]) => p !== null);
    expect(offRule).toEqual([]);

    await expectQuiet(page, problems);
  });
}
