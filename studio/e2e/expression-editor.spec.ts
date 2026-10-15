import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity } from './support/canvasGraph';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties, showPaneField } from './support/panels';

/**
 * #1694 OR42 F10 — ⤢ opens a config field in a full-size editor: a modal with
 * the field's text, the same reference and function flyout, and OK / Cancel.
 * The pieces jsdom cannot show are pinned here: the native modal's top layer
 * and size at 1440×900, its theme, Escape and focus return in a real browser,
 * and the canvas's shortcuts standing down behind it.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const editor = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });

test('⤢ edits a field in a modal: references insert into the draft, OK writes it, Escape discards', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 expression editor', {
    params: [{ name: 'city', type: 'string', required: false, default: 'Leeds' }],
    nodes: [{ id: 'a', type: 'agent_task', position: { x: 0, y: 0 }, config: { task: 'Hi' } }],
  });
  await nodeById(page, 'a').click();
  const task = properties(page).getByRole('textbox', { name: 'Task', exact: true });
  await showPaneField(page, task);
  const open = properties(page).getByRole('button', { name: 'Open Task in the editor' });
  await open.click();

  const dialog = editor(page, 'Task');
  await expect(dialog).toBeVisible();
  const box = dialog.getByRole('textbox', { name: 'Task', exact: true });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('Hi');

  // Measured, not looked at: it fits 1440×900, it is far taller than the
  // dock's eight-line box, and it is themed (its background is the app's
  // panel colour as resolved inside the app root, not the UA's `Canvas`, and
  // its backdrop is Fluent's scrim).
  const geometry = await dialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const text = el.querySelector('textarea')!;
    const probe = document.createElement('div');
    probe.style.background = 'var(--panel)';
    probe.style.color = 'var(--colorBackgroundOverlay)';
    el.parentElement!.appendChild(probe);
    const panel = getComputedStyle(probe).backgroundColor;
    const scrim = getComputedStyle(probe).color;
    probe.remove();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      textLines: text.clientHeight / parseFloat(getComputedStyle(text).lineHeight),
      background: getComputedStyle(el).backgroundColor,
      panel,
      backdrop: getComputedStyle(el, '::backdrop').backgroundColor,
      scrim,
      topLayer: el.matches(':modal'),
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(900);
  expect(geometry.right).toBeLessThanOrEqual(1440);
  expect(geometry.textLines).toBeGreaterThanOrEqual(12);
  expect(geometry.background).toBe(geometry.panel);
  // The scrim is Fluent's own token, resolved: not transparent, not unset.
  expect(geometry.backdrop).toBe(geometry.scrim);
  expect(geometry.backdrop).not.toBe('rgba(0, 0, 0, 0)');
  expect(geometry.topLayer).toBe(true);

  // A reference lands at the editor's caret, and only in the draft.
  await box.press('End');
  await box.pressSequentially(' from ');
  const refs = dialog.getByRole('button', { name: 'Insert reference into Task', exact: true });
  await refs.click();
  await dialog.getByRole('button', { name: /^city/ }).click();
  await expect(box).toHaveValue('Hi from ${params.city}');
  await expect(task).toHaveValue('Hi');

  // An Escape the flyout takes closes its list; the next closes the editor
  // and discards the draft, with focus back on ⤢.
  const fns = dialog.getByRole('button', { name: 'Functions for Task', exact: true });
  await fns.click();
  await expect(fns).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(fns).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await expect(task).toHaveValue('Hi');

  // OK writes the draft into the field.
  await open.click();
  await box.fill('Hello ${params.city}');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(task).toHaveValue('Hello ${params.city}');

  await expectQuiet(page, problems);
});

test("the canvas's shortcuts stand down while the editor is open", async ({ page }) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 expression editor undo', {
    nodes: [{ id: 'a', type: 'agent_task', position: { x: 0, y: 0 }, config: { task: 'Hi' } }],
  });
  // An edit for ⌘Z to undo: one more activity on the canvas.
  await addActivity(page, 'Wait');
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(2);

  await nodeById(page, 'a').click();
  const task = properties(page).getByRole('textbox', { name: 'Task', exact: true });
  await showPaneField(page, task);
  await properties(page).getByRole('button', { name: 'Open Task in the editor' }).click();
  const dialog = editor(page, 'Task');
  // Focus on a button, not the text box: a text box's ⌘Z is never the
  // canvas's anyway. Two guards hold it off, the editor keeping its keys and
  // `aria-modal` (`isModalDialogOpen`); this goes red only with both gone, and
  // `undoRedo.test.ts` pins the second alone.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('Delete');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(nodes).toHaveCount(2);

  await expectQuiet(page, problems);
});

test('a one-line field: Enter is OK, and a container field has ⤢ too', async ({ page }) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 expression editor one line', {
    nodes: [
      { id: 'r', type: 'file_read', position: { x: 0, y: 0 }, config: { path: 'in.csv' } },
      { id: 'n_a', position: { x: 0, y: 200 } },
    ],
    containers: [
      { id: 'foreach_1', kind: 'foreach', children: ['n_a'], items: '${createArray(1)}' },
    ],
  });
  await nodeById(page, 'r').click();
  const path = properties(page).getByRole('textbox', { name: 'File path', exact: true });
  await showPaneField(page, path);
  await properties(page).getByRole('button', { name: 'Open File path in the editor' }).click();
  const dialog = editor(page, 'File path');
  const box = dialog.getByRole('textbox', { name: 'File path', exact: true });
  await box.press('End');
  await box.pressSequentially('.bak');
  await box.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(path).toHaveValue('in.csv.bak');

  await page.getByRole('button', { name: 'Configure ForEach 1' }).click();
  await properties(page).getByRole('tab', { name: 'Items' }).click();
  await properties(page)
    .getByRole('button', { name: /^Open Items.* in the editor$/ })
    .click();
  await expect(page.getByRole('dialog', { name: /^Items/ })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^Items/ }).getByRole('textbox')).toHaveValue(
    '${createArray(1)}',
  );
  await page.keyboard.press('Escape');

  await expectQuiet(page, problems);
});
