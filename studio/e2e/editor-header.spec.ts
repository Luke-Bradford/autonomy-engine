import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { viewportSettled } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { editorMenuTrigger as trigger } from './support/canvas';

/**
 * #1397 OR6 — the pipeline editor's header has an action hierarchy.
 *
 * ONE primary (Save version); Undo and Redo as icon buttons that still say
 * what they are and why they are disabled; everything rarer — Arrange, version
 * history, Export, Archive — in a ⋯ menu that works from the keyboard; and no
 * "Back to pipelines" chip repeating the breadcrumb's Pipelines crumb.
 */

const PILE = { x: 0, y: 0 };

async function openPile(page: Page, name: string) {
  await openSeededCanvas(page, name, {
    nodes: [
      { id: 'first', position: PILE },
      { id: 'second', position: PILE },
    ],
    edges: [{ from: 'first', to: 'second', on: 'success' }],
  });
  await viewportSettled(page);
}

test.describe('#1397 the editor header', () => {
  test('one primary, icon Undo/Redo, and the breadcrumb is the way back', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openPile(page, `e2e 1397 header ${Date.now()}`);

    await expect(page.getByRole('link', { name: /Back to pipelines/ })).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Pipelines' }),
    ).toHaveAttribute('href', '#/author/pipelines');

    // The header's OWN row — the Run and Debug forms render inside
    // `.page-header` too, and have primaries of their own.
    const primaries = page.locator('.canvas-page .page-header > .toolbar > button.primary');
    await expect(primaries).toHaveCount(1);
    await expect(primaries).toHaveAccessibleName('Save version');

    const read = await page.evaluate(() => {
      const row = document.querySelector('.canvas-page .page-header > .toolbar');
      const box = (sel: string) => {
        const el = row?.querySelector<HTMLElement>(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          height: r.height,
          text: el.textContent.trim(),
          title: el.title,
          svg: el.querySelector('svg') !== null,
          className: el.className,
        };
      };
      return {
        undo: box('button[aria-label="Undo"]'),
        redo: box('button[aria-label="Redo"]'),
        save: box('button.primary'),
      };
    });
    for (const [label, b] of [
      ['Undo', read.undo],
      ['Redo', read.redo],
    ] as const) {
      expect(b, `${label} is in the header row`).not.toBeNull();
      expect(b!.className, `${label} is an icon button`).toMatch(/\bicon-button\b/);
      expect(b!.svg, `${label} draws an icon`).toBe(true);
      expect(b!.text, `${label} has no visible text`).toBe('');
      // Nothing undoable yet, so the tooltip is the REASON, not the shortcut.
      expect(b!.title, `${label} says why it is disabled`).toBe(
        `Nothing to ${label.toLowerCase()}.`,
      );
      // Level with the text buttons beside it, not a squat glyph.
      expect(Math.abs(b!.height - read.save!.height), `${label} height`).toBeLessThanOrEqual(4);
    }
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

    await expectQuiet(page, problems);
  });

  test('the ⋯ menu works from the keyboard', async ({ page }) => {
    const problems = collectPageProblems(page);
    const name = `e2e 1397 menu ${Date.now()}`;
    await openPile(page, name);

    // Open with Enter; the items run in order, rarest and weightiest last.
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: /^Arrange/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: /^Show version history/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: /^Export/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: /^Archive/ })).toBeFocused();

    // Escape closes it and hands focus back to the trigger.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();

    // Enter on an item acts: Arrange lays the pile out.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: /^Arrange/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/^Arranged \d+ activit/)).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Arranging made the draft dirty, and Export says what it will leave out.
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: /^Export/ })).toContainText(
      'unsaved changes are not included',
    );
    // Version history opens by keyboard too.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: /^Show version history/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#version-history-panel')).toHaveCount(1);

    // Export downloads the pipeline's file.
    await trigger(page).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    expect((await download).suggestedFilename()).toMatch(/^pipeline-e2e-1397-menu-.+\.json$/);

    await expectQuiet(page, problems);
  });
});
