import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import {
  CONTROL_H,
  DENSITIES,
  ROW_H,
  drawnHeights,
  expectAppearance,
  preferAppearance,
} from './support/appearance';
import { openRowMenu, pane, tree } from './support/authorPane';
import { expectInlineRow, inlineItems } from './support/inlineRow';
import { offRampText } from './support/typeRamp';
import { openSeededCanvas, seedVersion } from './support/seedDoc';
import { toolbox as toolboxRegion } from './support/canvasGraph';

/**
 * #1594 OR40 S6i — the left panes on the design system, at 1440x900 in compact
 * light and comfortable dark: the hub pane every Author, Monitor and Manage
 * page shares (with Author's Factory resources tree in it), and the editor's
 * Activities toolbox. S6a–S6h measured `.content` only, so neither had been
 * checked against the ramp.
 *
 * Measured: all text on the type ramp, the empty and error states included;
 * pane and tree rows `--row-h`; the filters, the toolbox rows, the inline name
 * form and Dismiss `--control-h`; the pane's title, filter and links share one
 * left edge, a name sits under its group's label and a filed one a step in;
 * the name row fits a pane at its minimum width; and a toolbox group's label
 * does not move when a search swaps its disclosure for a static heading.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

/** The left edge of an element's first drawn text, which is where a reader's eye lands. */
function textLefts(page: Page, selector: string) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) =>
            (n.textContent ?? '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
        });
        const node = walker.nextNode();
        if (!node) return { text: '', left: NaN };
        const range = document.createRange();
        range.selectNodeContents(node);
        return { text: (node.textContent ?? '').trim(), left: range.getBoundingClientRect().left };
      });
  }, selector);
}

function sideways(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement!;
    const pane = document.querySelector('.secondary-pane__body');
    return Math.max(
      root.scrollWidth - root.clientWidth,
      pane ? pane.scrollWidth - pane.clientWidth : 0,
    );
  });
}

function left(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => el.getBoundingClientRect().left);
}

for (const { density, theme } of RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6i — the hub pane and Factory resources: on the ramp, rows and controls to size, one left edge (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    // A filed pipeline and a top-level one, so the tree draws a folder row too.
    const filed = await seedVersion(page, `S6i filed ${density}`, { nodes: [] });
    const moved = await page.request.patch(`/api/pipelines/${filed.pipelineId}`, {
      data: { folder: `S6i folder ${density}` },
    });
    expect(moved.status(), await moved.text()).toBe(200);
    await seedVersion(page, `S6i top ${density}`, { nodes: [] });

    // Monitor and Manage: a plain list of hub sections.
    for (const route of ['/#/monitor/runs', '/#/manage/connections']) {
      await page.goto(route);
      await fluentRootReady(page);
      await expectAppearance(page, theme, d);
      await expect(page.locator('.secondary-pane__link--active')).toBeVisible();
      expect(await offRampText(page, d, '.secondary-pane__body'), route).toEqual([]);
      for (const row of await drawnHeights(page, '.secondary-pane__link'))
        expect(row.h, `${route} ${row.name}`).toBe(ROW_H[d]);
      const title = (await textLefts(page, '.secondary-pane__title'))[0]!;
      for (const link of await textLefts(page, '.secondary-pane__link'))
        expect(Math.abs(link.left - title.left), `${route} ${link.text} text left`).toBeLessThan(1);
      expect(await sideways(page), route).toBe(0);
    }

    // Author: the Factory resources tree.
    await page.goto('/#/author/pipelines');
    await fluentRootReady(page);
    await expect(
      tree(page).locator('.factory-resources__folder-name', {
        hasText: `S6i folder ${density}`,
      }),
    ).toBeVisible();
    await expect(tree(page).getByRole('link', { name: `S6i filed ${density}` })).toBeVisible();
    expect(await offRampText(page, d, '.secondary-pane__body'), 'tree').toEqual([]);
    for (const row of await drawnHeights(
      page,
      '.factory-resources__row .secondary-pane__link, .factory-resources__folder-header',
    ))
      expect(row.h, `tree row ${row.name}`).toBe(ROW_H[d]);
    for (const c of await drawnHeights(page, '.factory-resources__toolbar :is(input, button)'))
      expect(c.h, `${c.name} height`).toBe(CONTROL_H[d]);
    expectInlineRow(
      'pane toolbar',
      await inlineItems(page, '.factory-resources__toolbar :is(input, button)'),
    );
    // The title, the filter and the group's chevron GLYPH start on one line.
    const titleText = (await textLefts(page, '.secondary-pane__title'))[0]!.left;
    expect(
      Math.abs((await left(page, '.factory-resources__filter')) - titleText),
      'filter',
    ).toBeLessThan(1);
    expect(
      Math.abs(
        (await left(page, '.factory-resources__group > .factory-resources__disclosure svg')) -
          titleText,
      ),
      'group chevron',
    ).toBeLessThan(1);
    // A top-level name sits under its group's label; a filed one a step in.
    const groupLabel = (await textLefts(page, '.factory-resources__group-link'))[0]!.left;
    const names = await textLefts(page, '.factory-resources__row .secondary-pane__link');
    const top = names.find((n) => n.text === `S6i top ${density}`)!;
    const filedName = names.find((n) => n.text === `S6i filed ${density}`)!;
    expect(Math.abs(top.left - groupLabel), 'name under the group label').toBeLessThan(1);
    expect(Math.abs(filedName.left - top.left - 24), 'filed name one step in').toBeLessThan(1);
    expect(await sideways(page), 'tree').toBe(0);

    // The no-match state is drawn on the ramp too.
    const filter = pane(page).getByRole('searchbox', { name: 'Filter pipelines' });
    await filter.fill('zzz-s6i-no-such');
    await expect(pane(page).getByText(/No pipelines match/)).toBeVisible();
    expect(await offRampText(page, d, '.secondary-pane__body'), 'no match').toEqual([]);
    await filter.fill('');

    // The inline name row a "New pipeline" opens: one control style, on the ramp.
    await pane(page).getByRole('button', { name: 'New pipeline' }).click();
    const nameRow = pane(page).locator('.factory-resources__name-row');
    await expect(nameRow.locator('input')).toBeFocused();
    for (const c of await drawnHeights(page, '.factory-resources__name-row :is(input, button)'))
      expect(c.h, `name row ${c.name} height`).toBe(CONTROL_H[d]);
    expectInlineRow(
      'name row buttons',
      await inlineItems(page, '.factory-resources__name-row button'),
    );
    expect(await offRampText(page, d, '.secondary-pane__body'), 'name row').toEqual([]);
    expect(await sideways(page), 'name row').toBe(0);

    // A refused create: the alert and its Dismiss, on the ramp and to size.
    await page.route('**/api/pipelines', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'S6i refused' }),
          })
        : route.continue(),
    );
    await nameRow.locator('input').fill(`S6i refused ${density}`);
    await nameRow.locator('input').press('Enter');
    const alert = pane(page).getByRole('alert');
    await expect(alert).toBeVisible();
    expect(await offRampText(page, d, '.secondary-pane__body'), 'action error').toEqual([]);
    for (const c of await drawnHeights(page, '.factory-resources__error button'))
      expect(c.h, `${c.name} height`).toBe(CONTROL_H[d]);
    await alert.getByRole('button', { name: 'Dismiss' }).click();
    await expect(alert).toHaveCount(0);
    await page.unroute('**/api/pipelines');

    // At the pane's minimum width, a Duplicate row's field and buttons still fit.
    // The key, shape and 180 are the shipped `PANE_STORAGE_KEY` / `PANE_MIN_WIDTH`,
    // written out as `appearance.ts` writes its keys: a renamed key fails here.
    await page.evaluate(() =>
      localStorage.setItem(
        'autonomy-studio.pane',
        JSON.stringify({ width: 180, collapsed: false }),
      ),
    );
    await page.reload();
    await fluentRootReady(page);
    expect(
      await page
        .locator('.secondary-pane__body')
        .evaluate((el) => el.getBoundingClientRect().width),
      'pane at its minimum',
    ).toBe(180);
    await openRowMenu(page, `S6i top ${density}`);
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(nameRow.locator('input')).toBeFocused();
    const fit = await page.evaluate(() => {
      // The content box's right edge: inside the pane's border and any scrollbar.
      const body = document.querySelector('.secondary-pane__body') as HTMLElement;
      const contentRight = body.getBoundingClientRect().left + body.clientLeft + body.clientWidth;
      return [...document.querySelectorAll('.factory-resources__name-row :is(input, button)')].map(
        (el) => ({
          name: el.textContent || el.tagName,
          over: el.getBoundingClientRect().right - contentRight,
        }),
      );
    });
    for (const f of fit) expect(f.over, `${f.name} past the pane`).toBeLessThanOrEqual(0);
    expect(await sideways(page), 'narrow name row').toBe(0);

    await expectQuiet(page, problems, [/Failed to load resource.*500/]);
  });

  test(`#1594 OR40 S6i — the Activities toolbox: on the ramp, rows and filter to size, labels still on a search (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    await openSeededCanvas(page, `S6i toolbox ${density}`, {
      nodes: [{ id: 'w', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${0}' } }],
    });
    await expectAppearance(page, theme, d);
    const toolbox = toolboxRegion(page);
    await expect(toolbox.locator('.activity-toolbox__item').first()).toBeVisible();

    expect(await offRampText(page, d, '.activity-toolbox'), 'toolbox').toEqual([]);
    // A row is `--control-h`; a long name wraps rather than being cut, and only
    // that row grows.
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('.activity-toolbox__item')].map((el) => {
        const label = el.querySelector(':scope > span:not([aria-hidden])')!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        return {
          name: (el.textContent ?? '').trim(),
          h: Math.round(el.getBoundingClientRect().height),
          lines,
        };
      }),
    );
    expect(items.filter((i) => i.lines === 1).length).toBeGreaterThan(3);
    for (const i of items) {
      if (i.lines === 1) expect(i.h, `${i.name} height`).toBe(CONTROL_H[d]);
      else expect(i.h, `${i.name} (wrapped) height`).toBeGreaterThan(CONTROL_H[d]);
    }
    for (const c of await drawnHeights(page, '.activity-toolbox__filter'))
      expect(c.h, `${c.name} height`).toBe(CONTROL_H[d]);

    // A search swaps each group's disclosure for a static heading; the label stays put.
    const before = await textLefts(page, '.activity-toolbox__disclosure');
    expect(before.length).toBeGreaterThan(1);
    await toolbox.getByRole('searchbox', { name: 'Filter activities' }).fill('a');
    await expect(toolbox.locator('.activity-toolbox__heading').first()).toBeVisible();
    const after = await textLefts(page, '.activity-toolbox__heading');
    let compared = 0;
    for (const h of after) {
      const was = before.find((b) => b.text === h.text);
      if (!was) continue;
      compared += 1;
      expect(Math.abs(h.left - was.left), `${h.text} label moved`).toBeLessThan(1);
    }
    expect(compared).toBeGreaterThan(0);
    expect(await offRampText(page, d, '.activity-toolbox'), 'toolbox searching').toEqual([]);

    await expectQuiet(page, problems);
  });
}
