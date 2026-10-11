import { rmSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { CONTROL_H, DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { expectInlineRow, type InlineItem } from './support/inlineRow';
import { seedVersion } from './support/seedDoc';
import { offRampText } from './support/typeRamp';
import { disconnectWorkspaceGit, makeBareRepo } from './support/workspaceGit';

/**
 * #1594 OR40 S6c — the Git page on the design system, measured at 1440x900 in
 * both densities (compact light, comfortable dark), on both of its surfaces:
 * not connected, and connected with both checks run over a seeded pipeline, so
 * the drift table, the incoming readings and the import's blocked reason are
 * on screen too.
 *
 * On each: every piece of text on the type ramp, with each `?` note open in
 * turn as well as all closed; each section the one `Section` (a named region);
 * no `.page-hint` paragraph; every text input and button at the published
 * control height; the heading-row buttons a `Toolbar` row; a form's label 12px
 * from its control; the facts list 8px under its heading row; and no sideways
 * scroll. The connection is workspace-wide state, undone in `finally`.
 */

type Density = (typeof DENSITIES)[number];

/** The page's shape and measurements, read in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const shown = (el: Element) => el.getClientRects().length > 0;
    const heights = [
      ...content.querySelectorAll('input:not([type=checkbox]):not([type=radio]), button'),
    ]
      .filter((el) => shown(el) && !el.closest('summary'))
      .map((el) => {
        const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim();
        return `${name || el.getAttribute('type')}=${Math.round(el.getBoundingClientRect().height)}`;
      });
    const toolbars = [...content.querySelectorAll('.section__head')].map((head) =>
      [...head.querySelectorAll('button')]
        .filter((b) => !b.closest('summary'))
        .map((b) => {
          const r = b.getBoundingClientRect();
          return {
            name: (b.textContent ?? '').trim(),
            left: r.left,
            right: r.right,
            centre: r.top + r.height / 2,
          };
        }),
    );
    const labelGaps = [...content.querySelectorAll('.field-form > .labelled-control')]
      .filter(shown)
      .map((row) => {
        const label = row.querySelector('label')!.getBoundingClientRect();
        const control = row.querySelector('input')!.getBoundingClientRect();
        return Math.round(control.left - label.right);
      });
    const factsGaps = [...content.querySelectorAll('section.section')].flatMap((region) => {
      const facts = region.querySelector(':scope > .section__body > dl');
      if (!facts) return [];
      const head = region.querySelector('.section__head')!.getBoundingClientRect();
      return [Math.round(facts.getBoundingClientRect().top - head.bottom)];
    });
    const root = document.scrollingElement!;
    return {
      prose: content.querySelectorAll('.page-hint').length,
      sections: [...content.querySelectorAll('section.section')].map(
        (el) => el.querySelector('.section__title')?.textContent,
      ),
      heights,
      toolbars,
      labelGaps,
      factsGaps,
      sideways: Math.max(
        root.scrollWidth - root.clientWidth,
        content.scrollWidth - content.clientWidth,
      ),
    };
  });
}

function expectMeasured(
  m: Awaited<ReturnType<typeof measure>>,
  density: Density,
  sections: string[],
  facts: number[],
) {
  expect(m).toMatchObject({ prose: 0, sections, sideways: 0, factsGaps: facts });
  expect(m.heights.length).toBeGreaterThan(0);
  for (const entry of m.heights) expect(entry).toMatch(new RegExp(`=${CONTROL_H[density]}$`));
  expect(m.labelGaps.length).toBeGreaterThan(0);
  for (const gap of m.labelGaps) expect(gap).toBe(12);
  m.toolbars.forEach((row: InlineItem[], i) => expectInlineRow(`${sections[i]} heading row`, row));
}

/** The type ramp with every `?` closed, then with each one open in turn. */
async function expectOnRamp(page: Page, density: Density) {
  expect(await offRampText(page, density)).toEqual([]);
  const helps = page.locator('.content summary');
  const count = await helps.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    await helps.nth(i).click();
    await expect(page.locator('.content details[open]')).toHaveCount(1);
    expect(await offRampText(page, density), `with ? ${i + 1} of ${count} open`).toEqual([]);
  }
  await page.keyboard.press('Escape');
}

for (const density of DENSITIES) {
  const theme = density === 'compact' ? 'light' : 'dark';
  test(`#1594 OR40 S6c — the Git page is on the design system (${density}, ${theme})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const problems = collectPageProblems(page);
    await disconnectWorkspaceGit(request);
    const repo = makeBareRepo('e2e-git-design-');
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await preferAppearance(page, theme, density);
      await page.goto('/#/manage/git');
      await fluentRootReady(page);
      await expectAppearance(page, theme, density);

      // Not connected.
      const notConnected = page.getByRole('region', { name: 'Not connected', exact: true });
      await expect(notConnected.getByRole('form', { name: 'Connect a repository' })).toBeVisible();
      await expectOnRamp(page, density);
      expectMeasured(await measure(page), density, ['Not connected'], []);

      // Connected, with a pipeline to commit and both checks run.
      await seedVersion(page, `git-design-${density}-${Date.now()}`, {
        nodes: [{ id: 'n1', position: { x: 0, y: 0 } }],
      });
      const connected = await request.post('/api/workspace/git', { data: { repoUrl: repo } });
      expect(connected.ok(), await connected.text()).toBe(true);
      await page.reload();
      await fluentRootReady(page);
      const commit = page.getByRole('region', { name: 'Commit', exact: true });
      const incoming = page.getByRole('region', { name: 'Incoming', exact: true });
      await commit.getByRole('button', { name: 'Check for changes' }).click();
      await expect(commit.getByRole('table')).toBeVisible();
      await incoming.getByRole('button', { name: 'Check for incoming' }).click();
      await expect(incoming.getByLabel('Incoming changes')).toBeVisible();
      await expect(incoming.getByRole('button', { name: 'Import' })).toBeVisible();

      await expectOnRamp(page, density);
      const m = await measure(page);
      expectMeasured(m, density, ['Connected', 'Access token', 'Commit', 'Incoming'], [8]);
      // Connected's Refresh and Disconnect are the one pair; measure that it is there.
      expect(m.toolbars.map((row) => row.length)).toEqual([2, 1, 1, 1]);

      await expectQuiet(page, problems);
    } finally {
      await disconnectWorkspaceGit(request);
      rmSync(repo, { recursive: true, force: true });
    }
  });
}
