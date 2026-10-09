import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1594 OR40 S2a — the one control layer, measured in the browser.
 *
 * Every text input, select and textarea the layer owns is `--control-h` tall
 * with a 1px border and the control radius, in both densities; an unclassed
 * button and the primary variant are at least `--control-h`; keyboard focus
 * draws ONE ring (2px, accent, 1px outside, or inside where the element fills a
 * clipping container); and a checkbox sits beside its words with an 8px gap.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type Density = 'compact' | 'comfortable';
const CONTROL_H: Record<Density, number> = { compact: 28, comfortable: 32 };

async function openSettings(page: Page, density: Density) {
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption(density);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

/** The box of each control the layer owns, plus the resolved accent. */
function readControls(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const select = document.querySelector<HTMLSelectElement>('main select');
    if (!main || !select) throw new Error('Settings page did not render');
    const host = document.createElement('div');
    host.innerHTML = [
      '<button type="button">Secondary</button>',
      '<button type="button" class="primary">Primary</button>',
      '<input type="text" aria-label="probe text">',
      '<textarea aria-label="probe area"></textarea>',
      '<span style="color: var(--accent)">accent</span>',
    ].join('');
    main.append(host);
    try {
      const [secondary, primary, text, area, accent] = [...host.children] as HTMLElement[];
      const box = (el: Element) => {
        const cs = getComputedStyle(el);
        return {
          height: Math.round(el.getBoundingClientRect().height),
          radius: cs.borderTopLeftRadius,
          border: cs.borderTopWidth,
          size: cs.fontSize,
        };
      };
      return {
        accent: getComputedStyle(accent!).color,
        select: box(select),
        secondary: box(secondary!),
        primary: { ...box(primary!), background: getComputedStyle(primary!).backgroundColor },
        text: box(text!),
        area: box(area!),
      };
    } finally {
      host.remove();
    }
  });
}

/** Press Tab until `target` holds focus, so `:focus-visible` is the keyboard's. */
async function tabTo(page: Page, target: Locator, max = 40) {
  const handle = await target.elementHandle();
  if (!handle) throw new Error('tab target is not in the page');
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    if (await handle.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab never reached the target in ${max} presses`);
}

/**
 * Keyboard modality, then focus `target` directly. A later element can sit
 * behind hundreds of tab stops (every pipeline the suite has made is a row in
 * the resource pane), and Chromium matches `:focus-visible` on a scripted focus
 * that follows keyboard focus. Each caller asserts `focusVisible`, so a focus
 * that did not count as the keyboard's fails rather than passing on no ring.
 */
async function keyboardFocus(page: Page, target: Locator) {
  await page.keyboard.press('Tab');
  await target.focus();
}

function ringOf(target: Locator) {
  return target.evaluate((el) => {
    const cs = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      focusVisible: el.matches(':focus-visible'),
      style: cs.outlineStyle,
      width: cs.outlineWidth,
      color: cs.outlineColor,
      offset: cs.outlineOffset,
      accent,
    };
  });
}

for (const density of ['compact', 'comfortable'] as const) {
  test.describe(`#1594 OR40 S2a — control layer, ${density}`, () => {
    test('inputs, selects, textareas and the owned buttons take the control tokens', async ({
      page,
    }) => {
      const problems = collectPageProblems(page);
      await openSettings(page, density);
      const m = await readControls(page);
      const h = CONTROL_H[density];

      for (const [name, control] of [
        ['select', m.select],
        ['text input', m.text],
      ] as const) {
        expect(control.height, `a ${name} is --control-h tall`).toBe(h);
        expect(control.radius, `a ${name} has the control radius`).toBe('4px');
        expect(control.border, `a ${name} has a 1px border`).toBe('1px');
      }
      expect(m.area.radius, 'a textarea has the control radius').toBe('4px');
      expect(m.area.border).toBe('1px');
      for (const [name, button] of [
        ['secondary', m.secondary],
        ['primary', m.primary],
      ] as const) {
        expect(button.height, `a ${name} button is --control-h tall`).toBe(h);
        expect(button.radius, `a ${name} button has the control radius`).toBe('4px');
      }
      expect(m.primary.background, 'primary is filled with the accent').toBe(m.accent);

      // The Runs toolbar's search box and page-size select were unstyled
      // natives (square, 20-22px) before the layer.
      await page.goto('/#/monitor/runs');
      const search = page.getByRole('searchbox', { name: 'Search runs' });
      const perPage = page.getByRole('combobox', { name: 'Runs per page' });
      for (const control of [search, perPage]) {
        await expect(control).toBeVisible();
        const box = await control.evaluate((el) => ({
          height: Math.round(el.getBoundingClientRect().height),
          radius: getComputedStyle(el).borderTopLeftRadius,
        }));
        expect(box).toEqual({ height: h, radius: '4px' });
      }
      await expectQuiet(page, problems);
    });
  });
}

test.describe('#1594 OR40 S2a — one focus ring', () => {
  test('keyboard focus draws 2px accent outside a control, inside a rail link', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSettings(page, 'compact');

    const density = page.getByRole('combobox', { name: 'Density', exact: true });
    await keyboardFocus(page, density);
    const ring = await ringOf(density);
    expect(ring.focusVisible).toBe(true);
    expect(ring).toMatchObject({ style: 'solid', width: '2px', offset: '1px' });
    expect(ring.color).toBe(ring.accent);

    // A rail link fills the rail, which clips: the same ring, drawn inside.
    const rail = page.locator('.hub-rail__link').first();
    await tabTo(page, rail);
    const inset = await ringOf(rail);
    expect(inset).toMatchObject({ style: 'solid', width: '2px', offset: '-2px' });
    expect(inset.color).toBe(inset.accent);

    // A Fluent toggle keeps Fluent's own indicator rather than doubling it.
    await page.goto('/#/monitor/runs');
    const list = page.getByRole('group', { name: 'Runs view' }).getByRole('button').first();
    await expect(list).toBeVisible();
    await keyboardFocus(page, list);
    const fluent = await ringOf(list);
    expect(fluent.focusVisible).toBe(true);
    expect(fluent.color === fluent.accent && fluent.style !== 'none').toBe(false);
    await expectQuiet(page, problems);
  });

  test('a canvas node shows the ring under keyboard focus', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'or40 s2 focus', {
      nodes: [{ id: 'w', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${1}' } }],
    });
    const node = nodeById(page, 'w');
    await keyboardFocus(page, node);
    const ring = await ringOf(node);
    expect(ring.focusVisible).toBe(true);
    expect(ring).toMatchObject({ style: 'solid', width: '2px', offset: '1px' });
    expect(ring.color).toBe(ring.accent);
    await expectQuiet(page, problems);
  });
});

test('a checkbox sits beside its words: box, 8px, label — never stretched', async ({ page }) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or40 s2 checkbox', {
    nodes: [{ id: 'w', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${1}' } }],
  });
  await nodeById(page, 'w').click();
  const dock = properties(page);
  await dock.getByRole('tab', { name: 'General' }).click();
  const box = dock.getByRole('checkbox', { name: 'Secure input' });
  await expect(box).toBeVisible();

  const m = await box.evaluate((el) => {
    const label = el.closest('label')!;
    const words = [...label.childNodes].find(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
    )!;
    const range = document.createRange();
    range.selectNodeContents(words);
    const text = range.getBoundingClientRect();
    const input = el.getBoundingClientRect();
    return {
      direction: getComputedStyle(label).flexDirection,
      inputWidth: Math.round(input.width),
      gap: Math.round(text.left - input.right),
      centreDelta: Math.abs(input.top + input.height / 2 - (text.top + text.height / 2)),
    };
  });
  expect(m.direction).toBe('row');
  expect(m.inputWidth, 'the box is not stretched').toBeLessThanOrEqual(20);
  expect(m.gap, 'box, then 8px, then the words').toBe(8);
  expect(m.centreDelta, 'box and words share a centre line').toBeLessThanOrEqual(2);

  // A dock field's control is --control-h tall (the layer, not a dock-only rule).
  const field = dock
    .getByRole('tabpanel', { name: 'General' })
    .locator('input[inputmode="numeric"]');
  const height = await field
    .first()
    .evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(height).toBe(28);
  await expectQuiet(page, problems);
});
