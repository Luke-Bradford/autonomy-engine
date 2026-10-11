import { rmSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { offRampText } from './support/typeRamp';
import { disconnectWorkspaceGit, makeBareRepo } from './support/workspaceGit';

/**
 * #1594 OR40 S6c — the Git page on the design system, measured at 1440x900 in
 * both densities (compact light, comfortable dark), on both of its surfaces:
 * not connected, and connected with both checks run, so the drift report, the
 * incoming readings and the import's blocked reason are on screen too.
 *
 * On each: every piece of text on the type ramp (with a `?` note open as well
 * as closed), each section the one `Section` (a named region), no paragraph of
 * prose, and every text input and button at the published control height. The
 * heading-row buttons are a `Toolbar`: 8px or more apart, centres within 1px.
 * The connection is workspace-wide state, undone in `finally`.
 */

// The published heights, not read from the token: a token that drifts fails
// here instead of moving the check with it.
const CONTROL_H = { compact: 28, comfortable: 32 } as const;

/** The page's shape and its control heights, read in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const heights = [
      ...content.querySelectorAll('input:not([type=checkbox]):not([type=radio]), button'),
    ]
      .filter((el) => el.getClientRects().length > 0 && !el.closest('summary, .section__head h2'))
      .map((el) => {
        const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim();
        return `${name || el.getAttribute('type')}=${Math.round(el.getBoundingClientRect().height)}`;
      });
    const toolbars = [...content.querySelectorAll('.section__head')].map((head) => {
      const boxes = [...head.querySelectorAll('button')]
        .filter((b) => !b.closest('summary'))
        .map((b) => b.getBoundingClientRect());
      return boxes.slice(1).map((box, i) => ({
        gap: Math.round(box.left - boxes[i]!.right),
        centreDelta: Math.abs(box.top + box.height / 2 - (boxes[i]!.top + boxes[i]!.height / 2)),
      }));
    });
    return {
      prose: content.querySelectorAll('.page-hint').length,
      sections: [...content.querySelectorAll('section.section')].map(
        (el) => el.querySelector('.section__title')?.textContent,
      ),
      heights,
      toolbars: toolbars.flat(),
    };
  });
}

function expectControls(
  shape: Awaited<ReturnType<typeof measure>>,
  density: (typeof DENSITIES)[number],
) {
  expect(shape.heights.length).toBeGreaterThan(0);
  for (const entry of shape.heights) {
    expect(entry).toMatch(new RegExp(`=${CONTROL_H[density]}$`));
  }
  for (const pair of shape.toolbars) {
    expect(pair.gap).toBeGreaterThanOrEqual(8);
    expect(pair.centreDelta).toBeLessThanOrEqual(1);
  }
}

for (const density of DENSITIES) {
  const theme = density === 'compact' ? 'light' : 'dark';
  test(`#1594 OR40 S6c — the Git page is on the design system (${density}, ${theme})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
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
      expect(await offRampText(page, density)).toEqual([]);
      // The field's `?` (the section's comes first): its note is measured open.
      await notConnected.getByText('?', { exact: true }).last().click();
      await expect(notConnected.getByText(/Do not put a password in the URL/)).toBeVisible();
      expect(await offRampText(page, density)).toEqual([]);
      let shape = await measure(page);
      expect(shape).toMatchObject({ prose: 0, sections: ['Not connected'] });
      expectControls(shape, density);

      // Connected, with both checks run.
      const connected = await request.post('/api/workspace/git', { data: { repoUrl: repo } });
      expect(connected.ok(), await connected.text()).toBe(true);
      await page.reload();
      await fluentRootReady(page);
      const commit = page.getByRole('region', { name: 'Commit', exact: true });
      const incoming = page.getByRole('region', { name: 'Incoming', exact: true });
      await commit.getByRole('button', { name: 'Check for changes' }).click();
      await expect(commit.getByRole('button', { name: 'Check for changes' })).toBeEnabled();
      await incoming.getByRole('button', { name: 'Check for incoming' }).click();
      await expect(incoming.getByLabel('Incoming changes')).toBeVisible();
      await expect(incoming.getByRole('button', { name: 'Import' })).toBeVisible();

      expect(await offRampText(page, density)).toEqual([]);
      await incoming.getByText('?', { exact: true }).click();
      await expect(incoming.getByText(/stamping the provenance/)).toBeVisible();
      expect(await offRampText(page, density)).toEqual([]);
      shape = await measure(page);
      expect(shape).toMatchObject({
        prose: 0,
        sections: ['Connected', 'Access token', 'Commit', 'Incoming'],
      });
      expectControls(shape, density);
      // Connected's Refresh and Disconnect, and one button each in Commit and
      // Incoming: the one pair is the only pair, so it must be measured.
      expect(shape.toolbars).toHaveLength(1);

      await expectQuiet(page, problems);
    } finally {
      await disconnectWorkspaceGit(request);
      rmSync(repo, { recursive: true, force: true });
    }
  });
}
