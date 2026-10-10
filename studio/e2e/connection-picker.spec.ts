import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { pickConnection, properties } from './support/panels';
import { contrastRatio, fluentRootReady, setTheme, surfaceBehind } from './support/theme';

/**
 * #1477 OR29 slice 5b — an activity's connection pickers: every connection
 * listed by kind (refused kinds disabled, with why), Test beside the select,
 * and ＋ New opening the kind gallery and form in a column beside the editor —
 * never navigating, never touching the canvas draft — then binding the new
 * connection to the slot that asked. Slice 5c: Edit beside them opens the bound
 * connection in the same column, and a save shows on every node bound to it.
 */

const column = (page: Page) => page.getByRole('region', { name: 'New connection', exact: true });
const editColumn = (page: Page) =>
  page.getByRole('region', { name: 'Edit connection', exact: true });
const editing = (page: Page) =>
  page.getByRole('group', { name: 'Pipeline state' }).locator('[data-part="editing"]');

async function seedFsConnection(page: Page, name: string): Promise<void> {
  const res = await page.request.post('/api/connections', {
    data: { name, kind: 'fs', config: { roots: ['/tmp'] } },
  });
  expect(res.status(), await res.text()).toBe(201);
}

async function seedSqliteConnection(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/connections', {
    data: { name, kind: 'sqlite', config: { path: 'e2e-1477-edit.db', writable: true } },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function copyNodeOnSink(page: Page, title: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, title, { nodes: [] });
  await fluentRootReady(page);
  await addActivity(page, 'Copy data');
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
    await sink.click();
    const filesOption = page.getByRole('listbox').getByRole('option').filter({ hasText: files });
    await expect(filesOption).toHaveAttribute('aria-disabled', 'true');
    await expect(filesOption).toContainText("Can't be a Copy data sink yet");
    await sink.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);

    // The row: select, Test and ＋ New side by side, compact.
    // The Sink tab's own row (the Source tab's picker is in the DOM, hidden).
    const row = await sink.locator('xpath=../..').evaluate((el) => {
      const rects = [...el.children].map((c) => c.getBoundingClientRect());
      return {
        children: [...el.children].map((c) => c.tagName.toLowerCase()),
        // The combobox's own chrome is cleared: ONE box, the dock's input.
        pickerHeight: Math.round(el.querySelector('input')!.getBoundingClientRect().height),
        pickerChromeBorder: getComputedStyle(el.children[0]!).borderTopWidth,
        inputBorder: getComputedStyle(el.querySelector('input')!).borderTopWidth,
        // Room for the chevron, against the compact density's own padding.
        inputPadRight: getComputedStyle(el.querySelector('input')!).paddingRight,
        oneLine: new Set(rects.map((r) => Math.round(r.top + r.height / 2))).size === 1,
        gaps: rects.slice(1).map((r, i) => Math.round(r.left - rects[i]!.right)),
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
      children: ['div', 'button', 'button', 'button'],
      pickerHeight: 28,
      pickerChromeBorder: '0px',
      inputBorder: '1px',
      inputPadRight: '28px',
      gaps: [8, 8, 8],
      oneLine: true,
      buttonHeights: [28],
    });

    await properties(page).getByRole('button', { name: 'New sink connection' }).click();
    await expect(column(page)).toBeVisible();
    await expect(page).toHaveURL(/pipelines/);
    // The gallery disables what a Copy sink cannot be, with the same reason.
    const fsTile = column(page).getByRole('button', { name: 'File system', exact: true });
    await expect(fsTile).toHaveAttribute('aria-disabled', 'true');
    await expect(fsTile).toHaveAccessibleDescription(/Can't be a Copy data sink yet/);

    await column(page).getByRole('button', { name: 'SQLite', exact: true }).click();
    const form = column(page).getByRole('form', { name: 'Connection form' });
    const name = `e2e 1477 warehouse ${String(Date.now())}`;
    await form.getByLabel('Name').fill(name);
    await form.getByLabel(/^Database file/).fill('e2e-1477-warehouse.db');
    // Test connection on the UNSAVED form, through the draft probe.
    await form.getByRole('button', { name: 'Test connection' }).click();
    // A verdict, either way: the draft probe answered.
    await expect(form.getByRole('status')).toHaveClass(/probe-(ok|failed)/);

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
    await expect(sink).toHaveValue(`${name} (SQLite)`);
    await expect(
      properties(page).getByRole('button', { name: 'New sink connection' }),
    ).toBeFocused();
    // The canvas draft is untouched: the same one activity, still a draft.
    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(editing(page)).toHaveText(/^Draft/);

    // Test beside the picker probes the saved connection.
    await properties(page).getByRole('button', { name: 'Test selected sink connection' }).click();
    await expect(properties(page).locator('.probe-ok, .probe-failed')).toBeVisible();
    await expectQuiet(page, problems);
  });

  test('Edit from one node’s picker updates the connection on EVERY node bound to it, draft untouched', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = String(Date.now());
    const name = `e2e 1477 edit ${stamp}`;
    const renamed = `e2e 1477 edited ${stamp}`;
    const id = await seedSqliteConnection(page, name);
    await copyNodeOnSink(page, 'e2e 1477 picker edit');
    await addActivity(page, 'Copy data');
    await expect(canvasNodes(page)).toHaveCount(2);
    const sink = properties(page).getByRole('combobox', { name: 'Sink connection' });
    const editSink = properties(page).getByRole('button', {
      name: 'Edit selected sink connection',
    });
    // Both activities bound to the one connection; the bindings are draft-only.
    for (const index of [1, 0]) {
      await canvasNodes(page).nth(index).click();
      await properties(page).getByRole('tab', { name: 'Sink', exact: true }).click();
      await expect(editSink).toBeDisabled();
      await pickConnection(page, 'Sink connection', { name });
    }
    await expect(editing(page)).toHaveText(/^Draft/);
    const url = page.url();
    // Renamed ELSEWHERE after the editor read its list: Edit must read it again
    // rather than prefill (and then save) the editor's older copy.
    const elsewhere = `${name} elsewhere`;
    const patched = await page.request.patch(`/api/connections/${id}`, {
      data: { name: elsewhere },
    });
    expect(patched.status(), await patched.text()).toBe(200);

    await editSink.click();
    await expect(editColumn(page)).toBeVisible();
    const form = editColumn(page).getByRole('form', { name: 'Connection form' });
    await expect(form.getByLabel('Name')).toHaveValue(elsewhere);
    await form.getByLabel('Name').fill(renamed);
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(editColumn(page)).toHaveCount(0);

    // Stored: the server row carries the new name.
    const stored = await page.request.get(`/api/connections/${id}`);
    expect(((await stored.json()) as { name: string }).name).toBe(renamed);
    // This node's picker shows it, focus is back on Edit, nothing navigated.
    await expect(sink).toHaveValue(`${renamed} (SQLite)`);
    await expect(editSink).toBeFocused();
    expect(page.url()).toBe(url);
    // The OTHER node bound to it shows it too.
    await canvasNodes(page).nth(1).click();
    await expect(sink).toHaveValue(`${renamed} (SQLite)`);
    // The canvas draft is untouched: both activities and their bindings, unsaved.
    await expect(canvasNodes(page)).toHaveCount(2);
    await expect(editing(page)).toHaveText(/^Draft/);
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

  test('paste-to-detect in the column: a refused kind says why; a SQLite path opens its form', async ({
    page,
  }) => {
    await copyNodeOnSink(page, 'e2e 1477 picker paste');
    await properties(page).getByRole('button', { name: 'New sink connection' }).click();
    const paste = column(page).getByRole('textbox', { name: 'Paste a path or URL' });

    await paste.fill('/srv/landing/orders.csv');
    await paste.press('Enter');
    await expect(paste).toHaveAccessibleDescription("File system: Can't be a Copy data sink yet");

    await paste.fill('/srv/stores/warehouse.sqlite');
    await paste.press('Enter');
    const form = column(page).getByRole('form', { name: 'Connection form' });
    await expect(form.getByLabel('Kind')).toHaveValue('sqlite');
    await expect(form.getByLabel(/^Database file/)).toHaveValue('/srv/stores/warehouse.sqlite');
    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(editing(page)).toHaveText(/^Draft/);
  });

  test('the list searches as you type, shows where each connection points, and ends in New', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = String(Date.now());
    const name = `e2e 1477 search ${stamp}`;
    const id = await seedSqliteConnection(page, name);
    await copyNodeOnSink(page, 'e2e 1477 picker search');
    const sink = properties(page).getByRole('combobox', { name: 'Sink connection' });
    const list = page.getByRole('listbox');

    // Typing into the closed picker opens it, filtered: only this run's row.
    await sink.focus();
    // The cleared Fluent underline is replaced by the app's focus ring.
    expect(await sink.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.type(stamp);
    await expect(list).toBeVisible();
    await expect(list.locator('[data-connection-id]')).toHaveCount(1);
    const row = list.locator(`[data-connection-id="${id}"]`);
    await expect(row).toContainText(name);
    // Its second line is where it points; its icon is its kind's.
    await expect(row.locator('.connection-option__line')).toHaveText('e2e-1477-edit.db');
    await expect(row.locator('.kind-icon[data-kind="sqlite"]')).toBeVisible();
    // Backspace edits the search; it never reaches the canvas's Delete.
    await page.keyboard.press('Backspace');
    await expect(canvasNodes(page)).toHaveCount(1);

    // Measured at 1440×900: the open list sits BELOW the picker and inside the
    // window, the row whole and on top. (Flipped above, it landed under the
    // dock's header, which painted over it and took its clicks.)
    const placed = await row.evaluate((el) => {
      const box = el.closest('[role="listbox"]')!.getBoundingClientRect();
      const picker = document.activeElement!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        below: box.top >= picker.bottom,
        listInside: box.bottom <= window.innerHeight && box.right <= window.innerWidth,
        rowInside: r.left >= box.left && r.right <= box.right,
        rowOnTop: hit !== null && el.contains(hit),
      };
    });
    expect(placed).toEqual({ below: true, listInside: true, rowInside: true, rowOnTop: true });

    await row.click();
    await expect(list).toHaveCount(0);
    await expect(sink).toHaveValue(`${name} (SQLite)`);

    // ＋ New is also the list's last entry, as in ADF's linked-service dropdown.
    await sink.click();
    await list.getByRole('option', { name: 'New connection…' }).click();
    await expect(column(page)).toBeVisible();
    // The pick did not unbind: New is an action, not a choice.
    await expect(sink).toHaveValue(`${name} (SQLite)`);
    await page.keyboard.press('Escape');
    await expect(column(page)).toHaveCount(0);
    // Focus is back on the picker that asked, with its list closed.
    await expect(sink).toBeFocused();
    await expect(list).toHaveCount(0);
    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(editing(page)).toHaveText(/^Draft/);
    await expectQuiet(page, problems);
  });

  test('dark mode: the picker buttons are legible', async ({ page }) => {
    const problems = collectPageProblems(page);
    await copyNodeOnSink(page, 'e2e 1477 picker dark');
    await setTheme(page, 'dark');
    const button = properties(page).getByRole('button', { name: 'New sink connection' });
    const color = await button.evaluate((el) => getComputedStyle(el).color);
    const behind = await surfaceBehind(page, '.connection-picker button');
    expect(contrastRatio(color, behind.color)).toBeGreaterThanOrEqual(4.5);
    // The portalled list takes the dark theme too: an option's text is legible.
    await properties(page).getByRole('combobox', { name: 'Sink connection' }).click();
    const entry = page.getByRole('listbox').getByRole('option', { name: 'New connection…' });
    const optionColor = await entry.evaluate((el) => getComputedStyle(el).color);
    const optionBehind = await surfaceBehind(page, '.connection-picker__listbox [role="option"]');
    expect(contrastRatio(optionColor, optionBehind.color)).toBeGreaterThanOrEqual(4.5);
    await expectQuiet(page, problems);
  });
});

/**
 * #1594 OR40 S5b — the open list is mounted inside `main` (not `<body>`), which
 * skips Fluent's own on-top layer. Visible is not enough: the point at an
 * option's centre must be the list itself, docked and with the dock expanded
 * (the expanded dock is the highest in-page layer).
 */
test('the open list is on top, docked and with the dock expanded', async ({ page }) => {
  const problems = collectPageProblems(page);
  await seedFsConnection(page, `e2e S5b on top ${String(Date.now())}`);
  await copyNodeOnSink(page, 'e2e S5b on top');

  const listOnTop = () =>
    page.evaluate(() => {
      const list = document.querySelector('[role="listbox"]');
      const option = list?.querySelector('[role="option"]');
      if (!list || !option) return 'no open list';
      const box = option.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        inMain: list.closest('main') !== null,
        onTop: hit !== null && list.contains(hit),
      };
    });

  const sink = properties(page).getByRole('combobox', { name: 'Sink connection' });
  await sink.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  expect(await listOnTop()).toEqual({ inMain: true, onTop: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);

  await page.getByRole('button', { name: 'Expand properties' }).click();
  await sink.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  expect(await listOnTop()).toEqual({ inMain: true, onTop: true });
  await page.keyboard.press('Escape');

  await expectQuiet(page, problems);
});
