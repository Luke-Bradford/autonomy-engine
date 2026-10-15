import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1694 OR42 F10 — expand on edit. A top-level text box in the properties pane
 * is one line at rest and grows to its text, up to eight lines, while it has
 * focus. An S box holding a `${}` widens to the value column while it has
 * focus. Nothing is permanently tall or permanently full-bleed.
 *
 * Heights are compared with the box's OWN computed line, padding and border,
 * never a hardcoded pixel figure, so a density or token change cannot make
 * this pass or fail by accident.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const THREE_LINES = 'one\ntwo\nthree';
const TWELVE_LINES = Array.from({ length: 12 }, (_, i) => `step ${String(i + 1)}`).join('\n');

/** The box's height in lines of its own computed line height. */
function lines(box: Locator) {
  return box.evaluate((el: HTMLTextAreaElement) => {
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const frame =
      px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    return (el.getBoundingClientRect().height - frame) / px(cs.lineHeight);
  });
}

/** Open the tab of the selected node's pane that holds `field`. */
async function showField(page: Page, field: Locator) {
  const tabs = properties(page)
    .getByRole('tablist', { name: 'Activity properties' })
    .getByRole('tab');
  const count = await tabs.count();
  for (let i = 0; i < count && !(await field.isVisible()); i++) await tabs.nth(i).click();
  await expect(field).toBeVisible();
}

test('a text box rests at one line, grows to eight while edited, and a click below it lands', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 expand on edit', {
    nodes: [
      {
        id: 'a',
        type: 'agent_task',
        position: { x: 0, y: 0 },
        config: { task: TWELVE_LINES },
      },
    ],
  });
  await nodeById(page, 'a').click();
  const task = properties(page).getByRole('textbox', { name: 'Task', exact: true });
  await showField(page, task);

  // At rest: one line, its first, and no drag handle.
  expect(await lines(task)).toBeCloseTo(1, 1);
  expect(await task.evaluate((el) => [el.scrollTop, getComputedStyle(el).resize])).toEqual([
    0,
    'none',
  ]);

  // Editing: eight lines of the twelve, the rest by scrolling.
  await task.click();
  expect(await lines(task)).toBeCloseTo(8, 1);
  // Its caret at the end, scrolled to the last line.
  await task.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  });
  expect(await task.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // The ${} toggle sits right under the open box: a click on it lands, and
  // the box collapses only once that click is done. Escape from the list
  // closes it, the box's own Escape no longer being in the way.
  const refs = properties(page).getByRole('button', {
    name: 'Insert reference into task',
    exact: true,
  });
  await refs.click();
  await expect(refs).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => lines(task)).toBeCloseTo(1, 1);
  // Back on its first line, not the last one it was scrolled to.
  expect(await task.evaluate((el) => el.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(refs).toHaveAttribute('aria-expanded', 'false');
  await expect(refs).toBeFocused();
  await task.focus();
  expect(await lines(task)).toBeCloseTo(8, 1);

  // Collapsed on a blur with no press, back on its first line.
  await task.blur();
  await expect.poll(() => lines(task)).toBeCloseTo(1, 1);
  await expect(task).toHaveValue(TWELVE_LINES);

  // A press on the control below, at where it is while the box is open: the
  // box holds its height until the press ends, so the click lands on that
  // control rather than on whatever the collapse slid under the pointer. Three
  // lines, with the pane unscrolled: a scrolled pane's clamp would hold the
  // control still and prove nothing. The control is the first one after the
  // box's own toggles; its click is counted and goes no further.
  await task.fill(THREE_LINES);
  expect(await lines(task)).toBeCloseTo(3, 1);
  await task.evaluate((el) => {
    el.closest('.property-panel')!.scrollTop = 0;
    const own = el.closest('.labelled-control')!;
    const controls = [
      ...el.closest('.property-panel')!.querySelectorAll('input, textarea, button'),
    ];
    const below = controls.find(
      (c) => !own.contains(c) && el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
    )!;
    below.setAttribute('data-press-target', '');
    (window as unknown as { clicks: number }).clicks = 0;
    below.addEventListener(
      'click',
      (e) => {
        (window as unknown as { clicks: number }).clicks++;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
  });
  await expect(task).toBeFocused();
  const below = properties(page).locator('[data-press-target]');
  // In view: its whole box inside the pane's visible part.
  expect(
    await below.evaluate((el) => {
      const pane = el.closest('.property-panel')!.getBoundingClientRect();
      return el.getBoundingClientRect().bottom <= pane.bottom;
    }),
  ).toBe(true);
  const open = (await below.boundingBox())!;
  await page.mouse.move(open.x + open.width / 2, open.y + open.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
  await expect(task).not.toBeFocused();
  await expect.poll(() => lines(task)).toBeCloseTo(1, 1);
  // The collapse moved the control by more than its own height: the press
  // would have missed it had the box shrunk at once.
  const closed = (await below.boundingBox())!;
  expect(open.y - closed.y).toBeGreaterThan(open.height);
  await expectQuiet(page, problems);
});

test('an S box holding a ${} widens to the value column while edited, and only then', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 expression widens', {
    nodes: [
      {
        id: 'w',
        type: 'wait',
        position: { x: 0, y: 0 },
        config: { seconds: '${add(add(add(10, 10), 5), 5)}' },
      },
    ],
  });
  const seconds = properties(page).getByRole('textbox', {
    name: 'Wait time (seconds)',
    exact: true,
  });
  /** The box's width, and how far short of its row's right edge (the value column's) it ends. */
  const widths = () =>
    seconds.evaluate((input: HTMLInputElement) => {
      const box = input.getBoundingClientRect();
      const row = input.closest('.labelled-control')!.getBoundingClientRect();
      return {
        box: Math.round(box.width),
        shortOfColumn: Math.round(row.right - box.right),
        suffixInside:
          input.parentElement!.querySelector('.input-unit__suffix')!.getBoundingClientRect()
            .right <= box.right,
      };
    });

  await nodeById(page, 'w').click();
  await showField(page, seconds);
  const rest = await widths();
  expect(rest.box).toBe(120);
  expect(rest.shortOfColumn).toBeGreaterThan(240);

  await seconds.click();
  const editing = await widths();
  expect(editing.shortOfColumn).toBe(0);
  expect(editing.box).toBeGreaterThan(rest.box + rest.shortOfColumn - 2);
  expect(editing.suffixInside).toBe(true);

  await seconds.blur();
  expect((await widths()).box).toBe(120);

  await expectQuiet(page, problems);
});
