import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, nodeById, openSeededCanvas, seedVersion } from './support/seedDoc';
import { TITLED_PAGES } from './support/pages';
import { fluentRootReady } from './support/theme';

/**
 * #1594 OR40 S5 — the page's structure, read from the rendered DOM on every
 * page: its title is its ONE h1 (the shell's wordmark is not a heading), the
 * headings in `main` never skip a level going down, and nothing in `main` is an
 * `aside` (a `complementary` landmark must be top level, so a named panel in the
 * page is a `region`). The editor's Activities, Properties and Problems are
 * named regions.
 */
test.use({ viewport: { width: 1440, height: 900 } });

interface Structure {
  h1s: string[];
  /** Each step down that skips a level: `h2 "Runs" → h4 "Inputs"`. */
  skips: string[];
  firstLevel: number | null;
  asidesInMain: string[];
  /** Headings outside `main` that are not inside a `nav` (the pane's title is
   *  an h2 in its own nav, outside the page's outline). */
  strayHeadings: string[];
  headingsInRail: number;
}

/** Headings a screen reader lists: rendered (a visually hidden one counts) and
 *  not `aria-hidden`. */
function read(page: Page): Promise<Structure> {
  return page.evaluate(() => {
    const listed = (el: Element) =>
      el.checkVisibility() && el.closest('[aria-hidden="true"]') === null;
    const levelOf = (el: Element) => Number(el.tagName.slice(1));
    const label = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim()}"`;
    const inMain = [...document.querySelectorAll('main :is(h1, h2, h3, h4, h5, h6)')].filter(
      listed,
    );
    const skips: string[] = [];
    inMain.forEach((el, i) => {
      const prev = inMain[i - 1];
      if (prev !== undefined && levelOf(el) > levelOf(prev) + 1) {
        skips.push(`${label(prev)} → ${label(el)}`);
      }
    });
    return {
      h1s: [...document.querySelectorAll('h1')]
        .filter(listed)
        .map((h) => (h.textContent ?? '').trim()),
      skips,
      firstLevel: inMain[0] === undefined ? null : levelOf(inMain[0]),
      asidesInMain: [...document.querySelectorAll('main :is(aside, [role="complementary"])')].map(
        (el) => `${el.tagName.toLowerCase()}.${el.className}`,
      ),
      strayHeadings: [...document.querySelectorAll(':is(h1, h2, h3, h4, h5, h6)')]
        .filter((h) => listed(h) && h.closest('main, nav') === null)
        .map(label),
      headingsInRail: document.querySelectorAll(
        'nav[aria-label="Primary"] :is(h1, h2, h3, h4, h5, h6)',
      ).length,
    };
  });
}

function expectStructure(view: string, s: Structure, title: string | RegExp) {
  expect(s.h1s, `${view}: one h1, the page title`).toHaveLength(1);
  if (typeof title === 'string') expect(s.h1s[0], `${view}: the h1 is the page title`).toBe(title);
  else expect(s.h1s[0], `${view}: the h1 is the page title`).toMatch(title);
  expect(s.firstLevel, `${view}: main starts at its h1`).toBe(1);
  expect(s.skips, `${view}: no heading skips a level`).toEqual([]);
  expect(s.asidesInMain, `${view}: no aside inside main`).toEqual([]);
  expect(s.strayHeadings, `${view}: every heading outside main is in a nav`).toEqual([]);
  expect(s.headingsInRail, `${view}: the rail's wordmark is not a heading`).toBe(0);
}

test('#1594 OR40 S5 — one h1 per page, no skipped heading level, no aside in main', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const problems = collectPageProblems(page);
  const stamp = Date.now();
  const { pipelineVersionId } = await seedVersion(page, `Structure run ${stamp}`, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'e2e heading structure');

  for (const { path, title } of TITLED_PAGES) {
    await page.goto(`/#${path}`);
    await fluentRootReady(page);
    await expect(page.locator('.page-header > h1')).toHaveText(title);
    expectStructure(path, await read(page), title);
  }

  // The run page, then with an activity run open in its drawer.
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  await expect(page.locator('.run-header .run-status')).toHaveText('failure');
  const runTitle = new RegExp(`^Structure run ${stamp} `); // the name, then its version
  expectStructure('run', await read(page), runTitle);
  for (const tab of ['Gantt', 'Variables', 'Cost', 'Events']) {
    await page
      .getByRole('tablist', { name: 'Run views' })
      .getByRole('tab', { name: tab, exact: true })
      .click();
    expectStructure(`run, ${tab}`, await read(page), runTitle);
  }
  await page.locator('.activity-runs__table tbody tr').first().getByRole('button').first().click();
  await expect(page.getByRole('region', { name: /^Node / })).toBeVisible();
  expectStructure('run drawer', await read(page), runTitle);

  // The editor: pipeline properties, an activity, a multi-selection.
  const name = `Structure canvas ${stamp}`;
  await openSeededCanvas(page, name, {
    nodes: [
      { id: 'n1', type: 'fail', config: { message: 'x' }, position: { x: 0, y: 0 } },
      { id: 'n2', type: 'fail', config: { message: 'y' }, position: { x: 300, y: 0 } },
    ],
  });
  expectStructure('editor', await read(page), name);
  await expect(page.getByRole('region', { name: 'Activities', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Properties', exact: true })).toBeVisible();
  // Closed until opened, and still a named region while hidden.
  await expect(
    page.getByRole('region', { name: 'Problems', exact: true, includeHidden: true }),
  ).toHaveCount(1);
  await nodeById(page, 'n1').click();
  expectStructure('editor, activity', await read(page), name);
  await nodeById(page, 'n2').click({ modifiers: ['Meta'] });
  await expect(page.getByRole('heading', { name: '2 selected' })).toBeVisible();
  expectStructure('editor, two selected', await read(page), name);

  await expectQuiet(page, problems);
});
