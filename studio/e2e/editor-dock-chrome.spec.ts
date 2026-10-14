import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity } from './support/canvasGraph';
import { nodeById, openSeededCanvas, rectOf } from './support/seedDoc';
import { problemsToggle, properties } from './support/panels';

/**
 * #1694 OR42 slice 2 — the dock's chrome, measured at 1440x900.
 *
 * - Problems claims no width while it lists nothing (F2: an empty column took
 *   42% of the dock to say "No problems."), and never opens by itself, so an
 *   issue arriving mid-edit narrows nothing (#1393 OR2).
 * - The header's draft acts are compact icon buttons (F6), shown only on a
 *   tab that holds the draft — not on General, which writes straight to the
 *   store (F7).
 */

async function widths(page: Page) {
  const [panel, body] = await Promise.all([
    rectOf(page, '.property-dock__body > .property-panel'),
    rectOf(page, '.property-dock__body'),
  ]);
  return { panel: Math.round(panel.width), body: Math.round(body.width) };
}

const problemsColumn = (page: Page) => page.locator('.problems-panel');

test('#1694 an empty Problems takes no width, and opens only when asked while it lists something', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1694 dock chrome ${Date.now()}`, {
    nodes: [{ id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
  });
  await nodeById(page, 'a').click();
  await expect(properties(page)).toBeVisible();

  // Nothing to list: no column, the form has the whole body, and the toggle
  // says why it does nothing.
  const toggle = problemsToggle(page);
  await expect(problemsColumn(page)).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('title', 'No problems');
  const empty = await widths(page);
  expect(Math.abs(empty.panel - empty.body)).toBeLessThanOrEqual(1);
  // `force`: Playwright will not click an aria-disabled control by itself.
  await toggle.click({ force: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(problemsColumn(page)).toBeHidden();

  // An issue arrives: counted on the toggle, and the form does not narrow.
  await addActivity(page, 'Execute pipeline');
  await expect(toggle.locator('.count-badge').first()).toHaveText('1');
  await expect(toggle).not.toHaveAttribute('aria-disabled', 'true');
  await expect(problemsColumn(page)).toBeHidden();
  expect((await widths(page)).panel).toBe(empty.panel);

  // Asked for, it sits beside the form and takes its width from it.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(problemsColumn(page)).toContainText('needs a call config');
  const [panelBox, listBox] = await Promise.all([
    rectOf(page, '.property-dock__body > .property-panel'),
    rectOf(page, '.problems-panel'),
  ]);
  expect(listBox.left).toBeGreaterThanOrEqual(panelBox.right);
  expect(Math.round(panelBox.width)).toBeLessThan(empty.panel - 150);

  // The last problem gone, it closes and gives the width back...
  await nodeById(page, 'a').click();
  await page.keyboard.press('Meta+z');
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(problemsColumn(page)).toBeHidden();
  await expect.poll(async () => (await widths(page)).panel).toBe(empty.panel);

  // ...and stays closed when the next one arrives: it never reopens by itself.
  await addActivity(page, 'Execute pipeline');
  await expect(toggle.locator('.count-badge').first()).toHaveText('1');
  await expect(problemsColumn(page)).toBeHidden();
  expect((await widths(page)).panel).toBe(empty.panel);

  await expectQuiet(page, problems);
});

test('#1694 the header keeps the name whole: compact draft acts, and none on General', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1694 dock header ${Date.now()}`, {
    nodes: [
      {
        id: 'a',
        type: 'http_request',
        position: { x: 0, y: 0 },
        config: { url: 'https://a.example.test' },
      },
    ],
  });
  await nodeById(page, 'a').click();
  const panel = properties(page);
  await panel.getByRole('tab', { name: 'Request' }).click();

  const json = panel.getByRole('button', { name: 'Edit as JSON', exact: true });
  const revert = panel.getByRole('button', { name: 'Revert', exact: true });
  const apply = panel.getByRole('button', { name: 'Apply config', exact: true });
  await expect(apply).toBeVisible();
  // One measurement: the acts' widths and whether the name is cut.
  const read = await panel.locator('.property-panel__header').evaluate((header) => {
    const h2 = header.querySelector('h2')!;
    const act = (name: string) => {
      const b = [...header.querySelectorAll('button')].find(
        (el) => el.getAttribute('aria-label') === name,
      )!;
      return {
        width: Math.round(b.getBoundingClientRect().width),
        text: b.textContent?.trim() ?? '',
        glyph: b.querySelector('svg') !== null,
      };
    };
    return {
      nameCut: h2.scrollWidth > h2.clientWidth,
      typeCut: (() => {
        const code = header.querySelector('.property-panel__type')!;
        return code.scrollWidth > code.clientWidth;
      })(),
      json: act('Edit as JSON'),
      revert: act('Revert'),
      apply: act('Apply config'),
    };
  });
  expect(read.nameCut).toBe(false);
  expect(read.typeCut).toBe(false);
  // Icon buttons: a glyph and no text, square at the control height.
  for (const icon of [read.json, read.revert]) {
    expect(icon).toMatchObject({ text: '', glyph: true });
    expect(icon.width).toBeLessThanOrEqual(32);
  }
  // Apply keeps a short visible verb; its name says what it applies.
  expect(read.apply.text).toBe('Apply');
  expect(read.apply.width).toBeLessThanOrEqual(72);
  await expect(revert).toBeDisabled();
  await expect(json).toHaveAttribute('title', 'Edit as JSON');

  // General writes straight to the store: nothing there for Apply to commit.
  await panel.getByRole('tab', { name: 'General' }).click();
  await expect(apply).toHaveCount(0);
  await expect(revert).toHaveCount(0);
  await expect(json).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'More node actions' })).toBeVisible();

  await expectQuiet(page, problems);
});
