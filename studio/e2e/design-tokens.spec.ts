import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * #1594 OR40 S1 — the design tokens reach the rendered page, at both densities.
 *
 * `theme/tokens.test.ts` checks the token SOURCE. This checks what the browser
 * computes from it: the tokens resolve on the root, inherited text is the body
 * size, native controls take the app's font rather than the UA's 13.333px, and
 * a heading with no class rule of its own is on the ramp rather than the
 * browser default. Settings is the page for it: its title is a bare `<h2>`
 * (21/700 before S1) and it carries the Density select.
 */

function read(page: Page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const fluent = document.querySelector('.app-fluent-root');
    const title = document.querySelector('main h2');
    const select = document.querySelector<HTMLSelectElement>('main select');
    if (!fluent || !title || !select) throw new Error('Settings page did not render');
    const probe = document.createElement('button');
    select.parentElement?.append(probe);
    try {
      const font = (el: Element) => {
        const cs = getComputedStyle(el);
        return { size: cs.fontSize, weight: cs.fontWeight, family: cs.fontFamily };
      };
      return {
        density: document.documentElement.dataset.density ?? null,
        controlH: root.getPropertyValue('--control-h').trim(),
        rowH: root.getPropertyValue('--row-h').trim(),
        space3: root.getPropertyValue('--space-3').trim(),
        htmlSize: root.fontSize,
        body: font(fluent),
        title: { ...font(title), lineHeight: getComputedStyle(title).lineHeight },
        select: font(select),
        button: font(probe),
      };
    } finally {
      probe.remove();
    }
  });
}

async function openSettings(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
}

test.describe('#1594 OR40 S1 — design tokens', () => {
  test('compact is the default: 13px body and controls, 28px control token, a 20/600 title', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSettings(page);
    const m = await read(page);

    expect(m.density).toBe('compact');
    expect(m.controlH).toBe('28px');
    expect(m.rowH).toBe('32px');
    expect(m.space3).toBe('12px');
    expect(m.htmlSize, 'rem and px agree').toBe('16px');

    expect(m.body.size, 'inherited text is the body token, not Fluent’s 14px').toBe('13px');
    expect(m.body.family).toMatch(/^"Segoe UI"/);
    for (const [name, control] of [
      ['select', m.select],
      ['button', m.button],
    ] as const) {
      expect(control.size, `a native ${name} is the body size, not the UA 13.333px`).toBe('13px');
      expect(control.family, `a native ${name} is in the app font`).toBe(m.body.family);
    }

    expect(m.title).toEqual({
      size: '20px',
      weight: '600',
      family: m.body.family,
      lineHeight: '28px',
    });

    await expectQuiet(page, problems);
  });

  test('comfortable moves the body to 14px and controls to 32px; the title stays 20/600', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSettings(page);
    await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption('comfortable');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
    const m = await read(page);

    expect(m.controlH).toBe('32px');
    expect(m.rowH).toBe('36px');
    expect(m.space3, 'spacing is the same scale in both densities').toBe('12px');
    expect(m.body.size).toBe('14px');
    expect(m.select.size).toBe('14px');
    expect(m.button.size).toBe('14px');
    expect(m.title.size).toBe('20px');
    expect(m.title.weight).toBe('600');

    await expectQuiet(page, problems);
  });
});
