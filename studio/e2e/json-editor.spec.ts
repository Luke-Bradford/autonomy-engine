import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady, resolvedPaletteColor, setTheme } from './support/theme';
import { openNewConnection } from './support/newConnection';

/**
 * #1396 — `JsonEditor`, the one control for typing JSON, in the shipped bundle.
 *
 * What only a browser proves: that Format goes through the browser's own undo
 * stack (`execCommand('insertText')` does nothing in jsdom, so the unit suite
 * only reaches the fallback), that the stylesheet gives the box its code-editor
 * face in both themes, and that a problem appearing beside Format does not move
 * the form below it (#1393).
 */

async function openConnectionJson(page: Page) {
  await page.goto('/#/manage/connections');
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  await fluentRootReady(page);
  await openNewConnection(page, 'agent_cli');
  const form = page.getByRole('form', { name: 'Connection form' });
  await form.getByRole('button', { name: 'Edit as JSON' }).click();
  return { form, box: form.getByLabel('Config (JSON)') };
}

test.describe('#1396 JSON editor', () => {
  test('Format lays JSON out without changing a value, and Undo brings the typed text back', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const { form, box } = await openConnectionJson(page);

    const typed = '{"command":"claude","args":["-p"],"limit":12345678901234567890,"e":1E+2}';
    await box.fill(typed);
    await form.getByRole('button', { name: 'Format JSON' }).click();
    await expect(box).toHaveValue(
      '{\n  "command": "claude",\n  "args": [\n    "-p"\n  ],\n  "limit": 12345678901234567890,\n  "e": 1E+2\n}',
    );
    await expect(box).toBeFocused();

    await page.keyboard.press('ControlOrMeta+z');
    await expect(box).toHaveValue(typed);

    await expectQuiet(page, problems);
  });

  test('Format on text that is not JSON selects the mistake and says where, without moving the form', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const { form, box } = await openConnectionJson(page);
    const text = '{\n  "command" "claude"\n}';
    await box.fill(text);

    const editor = form.locator('.json-editor');
    const before = await editor.boundingBox();
    await form.getByRole('button', { name: 'Format JSON' }).click();

    const message = form.locator('.json-editor-problem');
    await expect(message).toHaveText("Not JSON at line 2, column 13: expected ':'");
    // Added to whatever the form already describes the box with.
    const describedBy = (await box.getAttribute('aria-describedby'))?.split(' ') ?? [];
    expect(describedBy).toContain(await message.getAttribute('id'));
    await expect(box).toHaveValue(text);
    await expect(box).toBeFocused();
    const selection = await box.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]);
    expect(selection).toEqual([14, 15]);
    expect((await editor.boundingBox())?.height).toBe(before?.height);

    await box.press('End');
    await page.keyboard.type(' ');
    await expect(message).toHaveText('');

    await expectQuiet(page, problems);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the box is a code editor in the ${theme} theme`, async ({ page }) => {
      const problems = collectPageProblems(page);
      const { box } = await openConnectionJson(page);
      await setTheme(page, theme);

      // The connection form's own textarea rule also paints a background, and
      // Chrome's UA sheet already maps `wrap="off"` to `white-space: pre`, so
      // the face is asserted on what only `.json-editor-input` sets: the
      // two-space tab stop and the smaller code size (0.85rem).
      const style = await box.evaluate((el) => {
        const s = getComputedStyle(el);
        const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return {
          font: s.fontFamily,
          tabSize: s.tabSize,
          sizeInRem: Math.round((parseFloat(s.fontSize) / root) * 100) / 100,
          wrap: el.getAttribute('wrap'),
          spellcheck: el.getAttribute('spellcheck'),
          background: s.backgroundColor,
          color: s.color,
        };
      });
      expect(style.font).toMatch(/monospace/);
      expect(style.tabSize).toBe('2');
      expect(style.sizeInRem).toBe(0.85);
      expect(style.wrap).toBe('off');
      expect(style.spellcheck).toBe('false');
      expect(style.background).toBe(await resolvedPaletteColor(page, '--bg'));
      expect(style.color).toBe(await resolvedPaletteColor(page, '--text'));

      await expectQuiet(page, problems);
    });
  }
});
