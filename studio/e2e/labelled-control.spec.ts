import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';

/**
 * #1227 — every `<select>`/`<textarea>` is paired with its label by `for`/`id`
 * through `LabelledControl`, never wrapped. A wrapping label's text includes the
 * control's own text (a textarea's value, every option of a select), so an exact
 * `getByLabel` resolved while a field was empty and silently stopped matching
 * once it held anything. The trigger form carries both control kinds, so it is
 * where the locator trap is pinned; the lint rule covers every other site. The
 * layout tests pin the three shapes the wrapper takes: a stacked form row, the
 * AI page's inline picker, and a config field's own tighter rhythm.
 */
function triggerForm(page: Page) {
  return page.getByRole('form', { name: 'Trigger form' });
}

async function openNewTrigger(page: Page): Promise<string[]> {
  const problems = collectPageProblems(page);
  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await page.getByRole('button', { name: /New trigger/i }).click();
  await expect(triggerForm(page)).toBeVisible();
  return problems;
}

test.describe('#1227 — a label names its control and nothing else', () => {
  test('a filled textarea and a chosen select are still found by their exact labels', async ({
    page,
  }) => {
    const problems = await openNewTrigger(page);
    const form = triggerForm(page);

    const params = form.getByLabel('Params (JSON)', { exact: true });
    await params.fill('{"region":"eu"}');
    // Re-resolved AFTER the fill: the wrapped form stopped matching here.
    await expect(form.getByLabel('Params (JSON)', { exact: true })).toHaveValue('{"region":"eu"}', {
      timeout: 3_000,
    });

    const mode = form.getByLabel('Mode', { exact: true });
    await mode.selectOption('event');
    await expect(form.getByLabel('Mode', { exact: true })).toHaveValue('event', {
      timeout: 3_000,
    });
    await expectQuiet(page, problems);
  });

  test('the wrapper keeps the layout the wrapping label had', async ({ page }) => {
    const problems = await openNewTrigger(page);
    const form = triggerForm(page);

    // The "Name" row is an `<input>`, which keeps its wrapping label — so it is
    // the reference: a `.labelled-control` row must stack and space the same.
    const layout = await form.evaluate((el) => {
      const pick = (node: Element | null) => {
        if (node === null) return null;
        const s = getComputedStyle(node);
        return {
          display: s.display,
          direction: s.flexDirection,
          gap: s.rowGap,
          fontSize: s.fontSize,
          color: s.color,
        };
      };
      const nameInput = [...el.querySelectorAll('label')].find((l) =>
        l.textContent?.trim().startsWith('Name'),
      );
      const paramsLabel = [...el.querySelectorAll('label')].find(
        (l) => l.textContent === 'Params (JSON)',
      );
      const wrapper = paramsLabel?.parentElement ?? null;
      return {
        reference: pick(nameInput ?? null),
        converted: pick(wrapper),
        wrapperClass: wrapper?.className ?? null,
      };
    });
    expect(layout.reference).not.toBeNull();
    expect(layout.converted).toEqual(layout.reference);
    expect(layout.converted?.direction).toBe('column');
    expect(layout.wrapperClass).toBe('labelled-control');
    await expectQuiet(page, problems);
  });

  test("the AI page's window picker stays one inline row", async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);
    const select = page.getByRole('combobox', { name: 'Activity window' });
    await expect(select).toBeVisible();
    const geo = await select.evaluate((el) => {
      const label = (el as HTMLSelectElement).labels?.[0];
      if (label === undefined) return null;
      const l = label.getBoundingClientRect();
      const c = el.getBoundingClientRect();
      return {
        text: label.textContent,
        labelLeftOfControl: l.right <= c.left,
        // The wrapped form had a literal space between "Window" and the select;
        // the wrapper's flex `gap` is what replaces it, so they must not touch.
        spaced: c.left - l.right >= 2,
        sameRow: l.top < c.bottom && c.top < l.bottom,
      };
    });
    expect(geo).toEqual({
      text: 'Window',
      labelLeftOfControl: true,
      spaced: true,
      sameRow: true,
    });
    await expectQuiet(page, problems);
  });

  test('a config field keeps its own rhythm inside the property panel', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, '1227 config field rhythm', {
      nodes: [{ id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
    });
    await canvasNodes(page).first().click();
    const url = page
      .getByRole('complementary', { name: 'Properties' })
      .getByLabel('url', { exact: true });
    await expect(url).toBeVisible();
    const style = await url.evaluate((el) => {
      const field = el.closest('.config-field');
      if (field === null || field.parentElement === null) return null;
      const s = getComputedStyle(field);
      const parent = getComputedStyle(field.parentElement);
      return {
        cls: field.className,
        gap: s.rowGap,
        fontSize: s.fontSize === parent.fontSize,
        color: s.color === parent.color,
      };
    });
    // 0.25rem, and neither the font size nor the colour of a form row: the
    // values `.config-field` had before it became a `LabelledControl`.
    expect(style).toEqual({
      cls: 'labelled-control config-field',
      gap: '4px',
      fontSize: true,
      color: true,
    });
    await expectQuiet(page, problems);
  });
});
