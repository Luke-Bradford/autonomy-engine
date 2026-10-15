import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1694 OR42 F10 — expand on edit, for the JSON editor. A top-level JSON box in
 * the properties pane (Execute pipeline's parameters, here) is one line at rest
 * and grows to its text, up to eight lines, while it has focus. Edit as JSON's
 * box is as tall as its config, never a fixed ten lines.
 *
 * Scrollbars are SHOWN in this file. Playwright's headless Chromium hides them
 * (`--hide-scrollbars`), and a hidden scrollbar is zero pixels tall, so the
 * case that matters for unwrapped JSON (a horizontal scrollbar under a long
 * line, eating the last visible one) could never fail. A classic 12px bar is
 * forced by stylesheet, so a platform's overlay scrollbars cannot hide it either.
 */
test.use({
  viewport: { width: 1440, height: 900 },
  launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
});

const BAR_CSS = 'textarea::-webkit-scrollbar { width: 12px; height: 12px; }';

/** The box's visible lines (its client height, so a scrollbar is not counted), and its layout facts. */
function measure(box: Locator) {
  return box.evaluate((el: HTMLTextAreaElement) => {
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const borders = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    return {
      lines:
        (el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)) / px(cs.lineHeight),
      textLines: el.value.split('\n').length,
      bar: el.offsetHeight - el.clientHeight - borders,
      clipped: el.scrollHeight > el.clientHeight,
      overflowX: cs.overflowX,
      resize: cs.resize,
    };
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

/** An Execute pipeline node whose target is an expression, so its parameters are JSON. */
async function openCall(page: Page, params: Record<string, unknown>) {
  await openSeededCanvas(page, `e2e 1694 json expand ${String(Date.now())}`, {
    params: [{ name: 'target', type: 'string', required: true }],
    nodes: [
      {
        id: 'c',
        type: 'call_pipeline',
        position: { x: 0, y: 0 },
        call: { pipelineVersionId: '${params.target}', params },
      },
    ],
  });
  await page.addStyleTag({ content: BAR_CSS });
  await nodeById(page, 'c').click();
  const box = properties(page).getByRole('textbox', {
    name: 'Parameters (JSON object)',
    exact: true,
  });
  await showField(page, box);
  return box;
}

test('a JSON box rests at one line and grows to its text, up to eight, while edited', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const box = await openCall(page, { query: 'ships', limit: 25 });

  // At rest: one line, no scrollbar under it, no drag handle.
  let m = await measure(box);
  expect(m.textLines).toBe(4);
  expect(m.lines).toBeCloseTo(1, 1);
  expect(m).toMatchObject({ bar: 0, overflowX: 'hidden', resize: 'none' });

  // Edited: all four lines.
  await box.click();
  m = await measure(box);
  expect(m.lines).toBeCloseTo(4, 1);
  expect(m.clipped).toBe(false);

  // Twelve lines: eight in view, the rest by scrolling.
  const twelve = JSON.stringify(
    Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${String(i)}`, i])),
    null,
    2,
  );
  await box.fill(twelve);
  m = await measure(box);
  expect(m.textLines).toBe(12);
  expect(m.lines).toBeCloseTo(8, 1);

  await box.blur();
  await expect.poll(async () => (await measure(box)).lines).toBeCloseTo(1, 1);

  await expectQuiet(page, problems);
});

test('a long unwrapped line: the scrollbar under it is added, so the last line stays in view', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const box = await openCall(page, { note: 'x'.repeat(300), query: 'ships' });

  // At rest the long line is cut, with no scrollbar under the one line shown.
  let m = await measure(box);
  expect(m).toMatchObject({ bar: 0, overflowX: 'hidden' });
  expect(m.lines).toBeCloseTo(1, 1);

  await box.click();
  m = await measure(box);
  // Not vacuous: a real scrollbar is drawn across the box.
  expect(m.bar).toBeGreaterThan(0);
  // All four lines in view above it, none scrolled out of sight.
  expect(m.lines).toBeCloseTo(4, 1);
  expect(m.clipped).toBe(false);

  await expectQuiet(page, problems);
});

test('Format on a resting box lays it out in view: the mistake is selected where it can be seen', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const box = await openCall(page, { query: 'ships' });
  await box.fill('{\n  "a": 1,\n  "b" 2\n}');
  await box.blur();
  await expect.poll(async () => (await measure(box)).lines).toBeCloseTo(1, 1);

  await properties(page).getByRole('button', { name: 'Format JSON' }).click();
  await expect(properties(page).locator('.json-editor-problem')).toHaveText(
    "Not JSON at line 3, column 7: expected ':'",
  );
  // Focused and open, all four lines showing, so the selected mistake is in view.
  await expect(box).toBeFocused();
  const m = await measure(box);
  expect(m.lines).toBeCloseTo(4, 1);
  expect(m.clipped).toBe(false);

  await expectQuiet(page, problems);
});

test('Edit as JSON is as tall as the config, not a fixed ten lines', async ({ page }) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, `e2e 1694 config json ${String(Date.now())}`, {
    nodes: [
      {
        id: 'h',
        type: 'http_request',
        position: { x: 0, y: 0 },
        config: { url: 'https://a.example.test' },
      },
    ],
  });
  await page.addStyleTag({ content: BAR_CSS });
  await nodeById(page, 'h').click();
  const panel = properties(page);
  await panel.getByRole('tab', { name: 'Request' }).click();
  await panel.getByRole('button', { name: 'Edit as JSON', exact: true }).click();
  const box = panel.getByRole('textbox', { name: 'Config (JSON)', exact: true });

  let m = await measure(box);
  expect(m.textLines).toBeLessThan(10);
  expect(m.lines).toBeCloseTo(m.textLines, 1);
  expect(m.resize).toBe('none');

  // Longer than the cap: ten lines in view, the rest by scrolling.
  await box.fill(
    JSON.stringify(
      Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`k${String(i)}`, i])),
      null,
      2,
    ),
  );
  m = await measure(box);
  expect(m.lines).toBeCloseTo(10, 1);

  await expectQuiet(page, problems);
});
