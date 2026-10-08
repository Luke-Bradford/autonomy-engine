import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';
import { contrastRatio, fluentRootReady, setTheme, surfaceBehind } from './support/theme';

/**
 * #1477 OR29 slice 5b — an activity's connection pickers: every connection
 * listed by kind (refused kinds disabled, with why), Test beside the select,
 * and ＋ New opening the kind gallery and form in a column beside the editor —
 * never navigating, never touching the canvas draft — then binding the new
 * connection to the slot that asked.
 */

const column = (page: Page) => page.getByRole('complementary', { name: 'New connection' });
const editing = (page: Page) =>
  page.getByRole('group', { name: 'Pipeline state' }).locator('[data-part="editing"]');

async function seedFsConnection(page: Page, name: string): Promise<void> {
  const res = await page.request.post('/api/connections', {
    data: { name, kind: 'fs', config: { roots: ['/tmp'] } },
  });
  expect(res.status(), await res.text()).toBe(201);
}

async function copyNodeOnSink(page: Page, title: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, title, { nodes: [] });
  await fluentRootReady(page);
  await addActivity(page, 'Copy Data');
  await canvasNodes(page).first().click();
  await properties(page).getByRole('tab', { name: 'Sink', exact: true }).click();
}

test.describe('#1477 activity connection pickers', () => {
  test('＋ New creates, tests and binds a sink connection without leaving the editor', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const files = `e2e 1477 files ${String(Date.now())}`;
    await seedFsConnection(page, files);
    await copyNodeOnSink(page, 'e2e 1477 picker');
    // The added activity is the canvas draft this flow must not disturb.
    await expect(editing(page)).toHaveText(/^Draft/);

    const sink = properties(page).getByRole('combobox', { name: 'Sink connection' });
    // An existing File system connection is LISTED, disabled, with the reason.
    const filesOption = sink.locator('option', { hasText: files });
    await expect(filesOption).toBeDisabled();
    await expect(filesOption).toHaveText(`${files} (File system) — Can't be a Copy Data sink yet`);

    // The row: select, Test and ＋ New side by side, compact.
    // The Sink tab's own row (the Source tab's picker is in the DOM, hidden).
    const row = await sink.locator('xpath=..').evaluate((el) => {
      const rects = [...el.children].map((c) => c.getBoundingClientRect());
      return {
        children: [...el.children].map((c) => c.tagName.toLowerCase()),
        oneLine: new Set(rects.map((r) => Math.round(r.top + r.height / 2))).size === 1,
        buttonHeights: [
          ...new Set(
            [...el.querySelectorAll('button')].map((b) =>
              Math.round(b.getBoundingClientRect().height),
            ),
          ),
        ],
      };
    });
    expect(row).toEqual({
      children: ['select', 'button', 'button'],
      oneLine: true,
      buttonHeights: [28],
    });

    await properties(page).getByRole('button', { name: 'New sink connection' }).click();
    await expect(column(page)).toBeVisible();
    await expect(page).toHaveURL(/pipelines/);
    // The gallery disables what a Copy sink cannot be, with the same reason.
    const fsTile = column(page).getByRole('button', { name: 'File system', exact: true });
    await expect(fsTile).toHaveAttribute('aria-disabled', 'true');
    await expect(fsTile).toHaveAccessibleDescription(/Can't be a Copy Data sink yet/);

    await column(page).getByRole('button', { name: 'SQLite', exact: true }).click();
    const form = column(page).getByRole('form', { name: 'Connection form' });
    const name = `e2e 1477 warehouse ${String(Date.now())}`;
    await form.getByLabel('Name').fill(name);
    await form.getByLabel(/^Database file/).fill('e2e-1477-warehouse.db');
    // Test connection on the UNSAVED form, through the draft probe.
    await form.getByRole('button', { name: 'Test connection' }).click();
    await expect(form.getByRole('status')).toHaveText(/\S/);

    // The column sits inside the viewport beside the canvas, nothing scrolled.
    const placed = await column(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        inside: r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        scrolled: window.scrollY,
      };
    });
    expect(placed).toEqual({ inside: true, scrolled: 0 });

    await form.getByRole('button', { name: 'Create connection' }).click();
    await expect(column(page)).toHaveCount(0);

    // Bound to the slot that asked, and focus back on the New that opened it.
    await expect(sink.locator('option:checked')).toHaveText(`${name} (SQLite)`);
    await expect(sink).not.toHaveValue('');
    await expect(
      properties(page).getByRole('button', { name: 'New sink connection' }),
    ).toBeFocused();
    // The canvas draft is untouched: the same one activity, still a draft.
    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(editing(page)).toHaveText(/^Draft/);

    // Test beside the picker probes the saved connection.
    await properties(page).getByRole('button', { name: 'Test selected sink connection' }).click();
    await expect(properties(page).getByRole('status').filter({ hasText: /\S/ })).toBeVisible();
    await expectQuiet(page, problems);
  });

  test('Escape on the gallery closes the column back to ＋ New', async ({ page }) => {
    await copyNodeOnSink(page, 'e2e 1477 picker escape');
    const newSink = properties(page).getByRole('button', { name: 'New sink connection' });
    await newSink.click();
    await column(page).getByRole('button', { name: 'SQLite', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(column(page)).toHaveCount(0);
    await expect(newSink).toBeFocused();
  });

  test('dark mode: the picker buttons are legible', async ({ page }) => {
    const problems = collectPageProblems(page);
    await copyNodeOnSink(page, 'e2e 1477 picker dark');
    await setTheme(page, 'dark');
    const button = properties(page).getByRole('button', { name: 'New sink connection' });
    const color = await button.evaluate((el) => getComputedStyle(el).color);
    const behind = await surfaceBehind(page, '.connection-picker button');
    expect(contrastRatio(color, behind.color)).toBeGreaterThanOrEqual(4.5);
    await expectQuiet(page, problems);
  });
});
