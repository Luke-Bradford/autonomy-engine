import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';
import { resolvedPaletteColor } from './support/theme';

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
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption(density);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

const PROBES = [
  '<button type="button" data-probe="secondary">Secondary</button>',
  '<button type="button" data-probe="primary" class="primary">Primary</button>',
  '<input type="text" data-probe="text" aria-label="probe text">',
  '<input type="text" data-probe="invalid" aria-label="probe invalid" aria-invalid="true">',
  '<input type="text" data-probe="disabled" aria-label="probe disabled" disabled>',
  '<textarea data-probe="area" aria-label="probe area"></textarea>',
  '<label data-probe="radio"><input type="radio" name="probe">Radio words</label>',
].join('');

/**
 * Probes for the controls the layer owns, outside React's tree (it reconciles
 * its own children) and pinned on screen so the pointer can hover them.
 */
async function withProbes<T>(page: Page, read: () => Promise<T>): Promise<T> {
  await page.evaluate((html) => {
    const host = document.createElement('div');
    host.id = 'control-probes';
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:var(--panel)';
    host.innerHTML = html;
    document.body.append(host);
  }, PROBES);
  try {
    return await read();
  } finally {
    await page.evaluate(() => document.getElementById('control-probes')?.remove());
  }
}

/** The box of an element: rendered height plus the computed skin. */
function boxOf(target: Locator) {
  return target.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      height: Math.round(el.getBoundingClientRect().height),
      radius: cs.borderTopLeftRadius,
      border: cs.borderTopWidth,
      borderColor: cs.borderTopColor,
      background: cs.backgroundColor,
      opacity: cs.opacity,
      size: cs.fontSize,
    };
  });
}

/** Box, gap and words of a checkbox or radio label. */
function inlineLabelOf(input: Locator) {
  return input.evaluate((el) => {
    const label = el.closest('label')!;
    const words = [...label.childNodes].find(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
    )!;
    const range = document.createRange();
    range.selectNodeContents(words);
    const text = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      direction: getComputedStyle(label).flexDirection,
      inputWidth: Math.round(box.width),
      gap: Math.round(text.left - box.right),
      centreDelta: Math.abs(box.top + box.height / 2 - (text.top + text.height / 2)),
    };
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

async function ringOf(page: Page, target: Locator) {
  const accent = await resolvedPaletteColor(page, '--accent');
  const ring = await target.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      focusVisible: el.matches(':focus-visible'),
      style: cs.outlineStyle,
      width: cs.outlineWidth,
      color: cs.outlineColor,
      offset: cs.outlineOffset,
    };
  });
  return { ...ring, accent };
}

for (const density of ['compact', 'comfortable'] as const) {
  test.describe(`#1594 OR40 S2a — control layer, ${density}`, () => {
    test('inputs, selects, textareas and the owned buttons take the control tokens', async ({
      page,
    }) => {
      const problems = collectPageProblems(page);
      await openSettings(page, density);
      const h = CONTROL_H[density];
      const accent = await resolvedPaletteColor(page, '--accent');
      const error = await resolvedPaletteColor(page, '--error');
      const select = await boxOf(page.getByRole('combobox', { name: 'Density', exact: true }));

      await withProbes(page, async () => {
        const probe = (name: string) => page.locator(`[data-probe="${name}"]`);
        const text = await boxOf(probe('text'));
        for (const [name, control] of [
          ['select', select],
          ['text input', text],
        ] as const) {
          expect(control.height, `a ${name} is --control-h tall`).toBe(h);
          expect(control.radius, `a ${name} has the control radius`).toBe('4px');
          expect(control.border, `a ${name} has a 1px border`).toBe('1px');
        }
        const area = await boxOf(probe('area'));
        expect([area.radius, area.border], 'a textarea has the control skin').toEqual([
          '4px',
          '1px',
        ]);
        for (const name of ['secondary', 'primary']) {
          const button = await boxOf(probe(name));
          expect(button.height, `a ${name} button is --control-h tall`).toBe(h);
          expect(button.radius, `a ${name} button has the control radius`).toBe('4px');
        }
        expect((await boxOf(probe('primary'))).background, 'primary is filled with accent').toBe(
          accent,
        );

        // States: hover is accent, invalid is error and stays error under the
        // pointer, disabled is dimmed.
        expect(text.borderColor, 'at rest the border is not accent').not.toBe(accent);
        await probe('text').hover();
        expect((await boxOf(probe('text'))).borderColor, 'hover').toBe(accent);
        expect((await boxOf(probe('invalid'))).borderColor, 'invalid').toBe(error);
        await probe('invalid').hover();
        expect((await boxOf(probe('invalid'))).borderColor, 'invalid under hover').toBe(error);
        expect((await boxOf(probe('disabled'))).opacity, 'disabled').toBe('0.6');

        // A radio reads across like a checkbox: box, 8px, words.
        const radio = await inlineLabelOf(probe('radio').locator('input'));
        expect(radio.direction).toBe('row');
        expect(radio.gap).toBe(8);
        expect(radio.centreDelta).toBeLessThanOrEqual(2);
      });

      // The Runs toolbar's search box and page-size select were unstyled
      // natives (square, 20-22px) before the layer.
      await page.goto('/#/monitor/runs');
      const search = page.getByRole('searchbox', { name: 'Search runs' });
      const perPage = page.getByRole('combobox', { name: 'Runs per page' });
      for (const control of [search, perPage]) {
        await expect(control).toBeVisible();
        const box = await boxOf(control);
        expect({ height: box.height, radius: box.radius }).toEqual({ height: h, radius: '4px' });
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
    const ring = await ringOf(page, density);
    expect(ring.focusVisible).toBe(true);
    expect(ring).toMatchObject({ style: 'solid', width: '2px', offset: '1px' });
    expect(ring.color).toBe(ring.accent);

    // A rail link fills the rail, which clips: the same ring, drawn inside.
    const rail = page.locator('.hub-rail__link').first();
    await tabTo(page, rail);
    const inset = await ringOf(page, rail);
    expect(inset).toMatchObject({ style: 'solid', width: '2px', offset: '-2px' });
    expect(inset.color).toBe(inset.accent);

    // A Fluent toggle keeps Fluent's own indicator rather than doubling it.
    await page.goto('/#/monitor/runs');
    const list = page.getByRole('group', { name: 'Runs view' }).getByRole('button').first();
    await expect(list).toBeVisible();
    await keyboardFocus(page, list);
    const fluent = await ringOf(page, list);
    expect(fluent.focusVisible).toBe(true);
    expect(fluent.color === fluent.accent && fluent.style !== 'none').toBe(false);
    await expectQuiet(page, problems);
  });

  test('canvas node and splitters: the same ring, placed for each', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'or40 s2 focus', {
      nodes: [{ id: 'w', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${1}' } }],
    });

    // Outside the node's own selection/issue ring: 2 x 1px + 2px.
    const node = nodeById(page, 'w');
    await keyboardFocus(page, node);
    const ring = await ringOf(page, node);
    expect(ring.focusVisible).toBe(true);
    expect(ring).toMatchObject({ style: 'solid', width: '2px', offset: '4px' });
    expect(ring.color).toBe(ring.accent);

    // The pane splitter is not clipped (outside); the dock's is (inside).
    for (const [selector, offset] of [
      ['.pane-splitter', '1px'],
      ['.dock-splitter', '-2px'],
    ] as const) {
      const splitter = page.locator(selector).first();
      await expect(splitter, selector).toHaveCount(1);
      await keyboardFocus(page, splitter);
      const r = await ringOf(page, splitter);
      expect(r.focusVisible, selector).toBe(true);
      expect(r, selector).toMatchObject({ style: 'solid', width: '2px', offset });
      expect(r.color, selector).toBe(r.accent);
    }
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

  const m = await inlineLabelOf(box);
  expect(m.direction).toBe('row');
  expect(m.inputWidth, 'the box is not stretched').toBeLessThanOrEqual(20);
  expect(m.gap, 'box, then 8px, then the words').toBe(8);
  expect(m.centreDelta, 'box and words share a centre line').toBeLessThanOrEqual(2);

  // A dock field's control is --control-h tall (the layer, not a dock-only rule;
  // compact is the default density).
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  const field = dock
    .getByRole('tabpanel', { name: 'General' })
    .locator('input[inputmode="numeric"]')
    .first();
  expect((await boxOf(field)).height).toBe(28);
  await expectQuiet(page, problems);
});

/**
 * #1594 OR40 S2b — the subtle variant, the one tab style and the dock strip.
 *
 * Every icon button is the subtle variant's glyph form: a `--control-h` square,
 * no border, no fill at rest, an `--icon-size` glyph. The families it folded
 * (editor header, dock, pane toggle, toolbox fold, resource row menu) each
 * carried their own size before. A tab is body type in a `--control-h` box,
 * semibold when selected, and selecting one moves no tab. The dock's strip is
 * its name and the Problems disclosure on the left, its icon acts on the right,
 * on one centre line with 8px between controls.
 */
const ICON_SIZE: Record<Density, number> = { compact: 16, comfortable: 20 };
const BODY_SIZE: Record<Density, string> = { compact: '13px', comfortable: '14px' };

for (const density of ['compact', 'comfortable'] as const) {
  test.describe(`#1594 OR40 S2b — subtle, tabs and the dock strip, ${density}`, () => {
    test('icon buttons, tabs and the dock strip take the tokens', async ({ page }) => {
      const problems = collectPageProblems(page);
      await openSettings(page, density);
      const h = CONTROL_H[density];
      await openSeededCanvas(page, `or40 s2b ${density}`, {
        nodes: [{ id: 'w', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${1}' } }],
      });
      await nodeById(page, 'w').click();
      const tablist = properties(page).getByRole('tablist').first();
      await expect(tablist).toBeVisible();
      const panel2 = await resolvedPaletteColor(page, '--panel-2');
      const accent = await resolvedPaletteColor(page, '--accent');

      // Icon buttons: one square, one glyph, from every family S2b folded.
      const icons = {
        undo: page.getByRole('button', { name: 'Undo', exact: true }),
        pane: page.getByRole('button', { name: /navigation pane/i }),
        toolboxFold: page.getByRole('button', { name: 'Collapse activities' }),
        rowMenu: page.locator('.factory-resources__icon-button').first(),
        paste: page.locator('.property-dock__header').getByRole('button', { name: 'Paste' }),
        expand: page.getByRole('button', { name: 'Expand properties' }),
        position: page.getByRole('button', { name: 'Dock to right' }),
        fold: page.getByRole('button', { name: 'Hide properties' }),
      };
      for (const [name, button] of Object.entries(icons)) {
        await expect(button, name).toHaveCount(1);
        const read = await button.evaluate((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const glyph = el.querySelector('svg')?.getBoundingClientRect();
          return {
            width: Math.round(r.width),
            height: Math.round(r.height),
            border: cs.borderTopStyle,
            background: cs.backgroundColor,
            glyph: glyph ? Math.round(glyph.width) : null,
          };
        });
        expect(read, name).toEqual({
          width: h,
          height: h,
          border: 'none',
          background: 'rgba(0, 0, 0, 0)',
          glyph: ICON_SIZE[density],
        });
      }

      // The subtle text button: no fill or border at rest, a fill on hover, an
      // accent underline once open — never the same as merely hovered.
      const problemsToggle = page.getByRole('button', { name: /^Problems/ });
      const subtle = () =>
        problemsToggle.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            height: Math.round(el.getBoundingClientRect().height),
            background: cs.backgroundColor,
            border: cs.borderTopColor,
            shadow: cs.boxShadow,
            size: cs.fontSize,
          };
        });
      // Problems may open with the dock (a stored preference): start it closed.
      if ((await problemsToggle.getAttribute('aria-expanded')) === 'true') {
        await problemsToggle.click();
      }
      await expect(problemsToggle).toHaveAttribute('aria-expanded', 'false');
      await page.mouse.move(0, 0);
      const rest = await subtle();
      expect(rest).toMatchObject({
        height: h,
        background: 'rgba(0, 0, 0, 0)',
        border: 'rgba(0, 0, 0, 0)',
        shadow: 'none',
        size: BODY_SIZE[density],
      });
      await problemsToggle.hover();
      expect(await subtle()).toMatchObject({ background: panel2, border: 'rgba(0, 0, 0, 0)' });
      await problemsToggle.click();
      await expect(problemsToggle).toHaveAttribute('aria-expanded', 'true');
      expect((await subtle()).shadow).toContain(accent);

      // The strip: name and Problems left, acts right, one centre line, 8px apart.
      const strip = await page.locator('.property-dock__header').evaluate((header) => {
        const items = [...header.children]
          .filter(
            (el) => getComputedStyle(el).display !== 'none' && el.getAttribute('role') !== 'status',
          )
          .flatMap((el) => (el.classList.contains('property-dock__acts') ? [...el.children] : [el]))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              label: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
              left: r.left,
              right: r.right,
              centre: r.top + r.height / 2,
            };
          });
        return items;
      });
      expect(strip.map((i) => i.label)).toEqual([
        'Properties',
        'Problems 0',
        'Paste',
        'Expand properties',
        'Dock to right',
        'Hide properties',
      ]);
      // The acts sit at the strip's far end, not after Problems.
      const end = await page
        .locator('.property-dock__header')
        .evaluate(
          (el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight),
        );
      expect(end - strip.at(-1)!.right, 'the fold ends the strip').toBeLessThanOrEqual(1);
      expect(strip[2]!.left - strip[1]!.right, 'acts pushed right').toBeGreaterThan(100);
      for (let i = 1; i < strip.length; i += 1) {
        const [a, b] = [strip[i - 1]!, strip[i]!];
        expect(b.left - a.right, `${a.label} → ${b.label} gap`).toBeGreaterThanOrEqual(8);
        expect(
          Math.abs(b.centre - a.centre),
          `${a.label} / ${b.label} centres`,
        ).toBeLessThanOrEqual(1);
      }

      // Tabs: body type in a control-height box; selected is semibold, and the
      // width it needs is reserved, so selecting another tab moves no tab.
      const tabs = () =>
        tablist.getByRole('tab').evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            const content = el.querySelector('.fui-Tab__content')!;
            const reserved = el.querySelector('.fui-Tab__content--reserved-space');
            const font = (e: Element) => {
              const cs = getComputedStyle(e);
              return `${cs.fontSize}/${cs.fontWeight}`;
            };
            return {
              selected: el.getAttribute('aria-selected') === 'true',
              left: r.left,
              width: r.width,
              height: Math.round(r.height),
              content: font(content),
              reserved: reserved ? font(reserved) : null,
            };
          }),
        );
      const before = await tabs();
      expect(before.length, 'the node has more than one tab').toBeGreaterThan(1);
      const body = BODY_SIZE[density];
      for (const t of before) {
        expect(t.height, 'tab height').toBe(h);
        expect(t.content, 'tab label').toBe(`${body}/${t.selected ? 600 : 400}`);
        // Fluent reserves on an UNSELECTED tab only (a hidden semibold copy).
        expect(t.reserved, 'reserved selected width').toBe(t.selected ? null : `${body}/600`);
      }
      const other = before.findIndex((t) => !t.selected);
      await tablist.getByRole('tab').nth(other).click();
      await expect(tablist.getByRole('tab').nth(other)).toHaveAttribute('aria-selected', 'true');
      const after = await tabs();
      expect(after.map((t) => [t.left, t.width])).toEqual(before.map((t) => [t.left, t.width]));
      expect(after[other]!.content).toBe(`${body}/600`);

      await expectQuiet(page, problems);
    });
  });
}
