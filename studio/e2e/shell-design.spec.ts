import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  BODY_SIZE,
  computedStyles as styles,
  DENSITIES,
  expectAppearance,
  NAV_ICON_SIZE,
  preferAppearance,
} from './support/appearance';
import { fluentRootReady } from './support/theme';
import { offRampText } from './support/typeRamp';

/**
 * #1594 OR40 S6p — the app shell on the design system, at 1440x900 in compact
 * light and comfortable dark: the hub rail (wordmark, links, active bar), the
 * version badge in its foot, the update banner and the command bar's
 * breadcrumb.
 *
 * Measured: all shell text on the type ramp; spacing on the 4px scale at the
 * values below; the rail glyphs at the navigation size; a release version
 * wrapping inside the rail at its `.` rather than clipping; and the update
 * banner in its own row, so the page under it still starts where the banner
 * ends and fills the rest of the viewport.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

const BODY = (d: Density) => `${BODY_SIZE[d]}px`;

/**
 * A version wider than the rail in any font, with both a `.` and a `-` to break
 * after. The browser alone breaks it mid-number and before the hyphen (measured:
 * `2026.` / `07.30` / `-rc1`); the badge's own breaks put every line end on a
 * `.` or `-`. How many lines that is depends on the font, so it is not asserted.
 */
const VERSION = '2026.07.30-rc1';
const BUILD = (version: string) => ({
  version,
  commit: 'e93ebf8',
  builtAt: '2026-07-30T09:12:44.000Z',
  arch: 'arm64',
});

/** The shipped endpoints, answered so the badge and banner show known values. */
async function mockUpdate(page: Page): Promise<void> {
  await page.route('**/api/version', (route) => route.fulfill({ json: BUILD(VERSION) }));
  await page.route('**/api/update/available', (route) =>
    route.fulfill({
      json: {
        current: BUILD(VERSION),
        latest: BUILD('2026.08.14'),
        updateAvailable: true,
        notes: null,
      },
    }),
  );
}

/** Rounded boxes of the command bar, the banner (if any) and `main`. */
function workspaceBoxes(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null;
    };
    const main = document.querySelector('main.content')!;
    return {
      bar: box('.command-bar'),
      banner: box('.update-banner'),
      main: box('main.content'),
      short: main.scrollHeight <= main.clientHeight,
    };
  });
}

for (const { density, theme } of RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6p — the shell on the ramp and the scale, the banner in its own row (${density} ${theme})`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    await mockUpdate(page);

    // --- A short page, under the banner ------------------------------------
    // Short by design, so the page does not fill the viewport on its own: a
    // banner on the `1fr` track grows into exactly that leftover height.
    await page.goto('/#/s6p-nowhere');
    await fluentRootReady(page);
    await expectAppearance(page, theme, d);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.locator('.update-banner')).toBeVisible();
    await expect(page.locator('.version-badge')).toHaveText(VERSION);

    const boxes = await workspaceBoxes(page);
    expect(boxes.short, 'the page is shorter than the viewport').toBe(true);
    expect(boxes.bar).toEqual({ top: 0, bottom: 40 });
    // 4 + a 20px body line + 4, and its 1px rule.
    expect(boxes.banner).toEqual({ top: 40, bottom: 69 });
    expect(boxes.main).toEqual({ top: 69, bottom: 900 });

    expect(await offRampText(page, d, '.hub-rail'), 'rail: ramp').toEqual([]);
    expect(await offRampText(page, d, '.command-bar'), 'command bar: ramp').toEqual([]);
    expect(await offRampText(page, d, '.update-banner'), 'banner: ramp').toEqual([]);

    const shell = await styles(
      page,
      ['.hub-rail', '.hub-rail__brand', '.version-badge', '.update-banner', '.command-bar'],
      [
        'padding-top',
        'padding-bottom',
        'padding-left',
        'column-gap',
        'font-size',
        'font-weight',
        'letter-spacing',
      ],
    );
    expect(shell['.hub-rail']).toMatchObject({ 'padding-top': '8px', 'padding-bottom': '4px' });
    expect(shell['.hub-rail__brand']).toMatchObject({
      'padding-bottom': '8px',
      'font-size': '12px',
      'font-weight': '600',
      'letter-spacing': 'normal',
    });
    expect(shell['.version-badge']).toMatchObject({
      'padding-bottom': '4px',
      'padding-left': '4px',
      'font-size': '12px',
    });
    expect(shell['.update-banner']).toMatchObject({
      'padding-top': '4px',
      'padding-left': '16px',
      'font-size': BODY(d),
    });
    expect(shell['.command-bar']).toMatchObject({ 'padding-left': '16px', 'column-gap': '8px' });

    // The rail: glyphs at the navigation size.
    const glyph = await page.locator('.hub-rail__link svg').first().boundingBox();
    expect(glyph, 'rail glyph').not.toBeNull();
    expect([Math.round(glyph!.width), Math.round(glyph!.height)], 'rail glyph').toEqual([
      NAV_ICON_SIZE,
      NAV_ICON_SIZE,
    ]);

    // The version: every line of it inside the rail and centred on it, broken
    // after its `.`.
    // Read as rendered: each character's line, so the text of each line is the
    // browser's own break, not how the markup happens to split it.
    const badge = await page.evaluate(() => {
      const rail = document.querySelector('.hub-rail')!.getBoundingClientRect();
      const el = document.querySelector('.version-badge')!;
      const lines = new Map<number, { text: string; left: number; right: number }>();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = 0; i < (node.textContent ?? '').length; i += 1) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          const top = Math.round(r.top);
          const line = lines.get(top) ?? { text: '', left: Infinity, right: -Infinity };
          line.text += node.textContent![i];
          line.left = Math.min(line.left, r.left);
          line.right = Math.max(line.right, r.right);
          lines.set(top, line);
        }
      }
      const ordered = [...lines.entries()].sort(([a], [b]) => a - b).map(([, l]) => l);
      return {
        lines: ordered.map((l) => l.text),
        inside: ordered.every((l) => l.left >= rail.left && l.right <= rail.right),
        // Centred on the rail's content box (its 1px right rule excluded).
        centred: ordered.every(
          (l) => Math.abs((l.left + l.right) / 2 - (rail.left + rail.right - 1) / 2) <= 1,
        ),
      };
    });
    expect(badge.lines.join(''), 'version: its lines').toBe(VERSION);
    expect(badge.lines.length, 'version: wraps').toBeGreaterThan(1);
    expect(
      badge.lines.slice(0, -1).filter((line) => !/[.-]$/.test(line)),
      `version: a line ends mid-part in ${JSON.stringify(badge.lines)}`,
    ).toEqual([]);
    expect(badge.inside, 'version: inside the rail').toBe(true);
    expect(badge.centred, 'version: centred').toBe(true);

    // --- The breadcrumb, two crumbs deep --------------------------------------
    await page.goto('/#/manage/connections');
    await fluentRootReady(page);
    const crumbs = page.locator('.command-bar__breadcrumb li');
    await expect(crumbs).toHaveCount(2);
    expect(await offRampText(page, d, '.command-bar'), 'breadcrumb: ramp').toEqual([]);
    const trail = await page.evaluate(() => {
      const ol = getComputedStyle(document.querySelector('.command-bar__breadcrumb ol')!);
      const sep = getComputedStyle(
        document.querySelector('.command-bar__breadcrumb li + li')!,
        '::before',
      );
      const current = getComputedStyle(
        document.querySelector(".command-bar__breadcrumb [aria-current='page']")!,
      );
      return {
        gap: ol.columnGap,
        size: ol.fontSize,
        sep: sep.marginRight,
        current: current.fontWeight,
      };
    });
    expect(trail).toEqual({ gap: '4px', size: BODY(d), sep: '4px', current: '600' });

    // The active rail link's bar, now that Manage is the hub.
    const bar = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.hub-rail__link--active')!, '::before');
      return [s.top, s.bottom, s.borderTopRightRadius, s.borderTopLeftRadius];
    });
    expect(bar, 'active bar: top, bottom, radius').toEqual(['8px', '8px', '4px', '0px']);

    await expectQuiet(page, problems);
  });
}

test('#1594 OR40 S6p — with no update out, the page starts straight under the command bar', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Read after the check has answered, so a banner it would show is already up.
  const checked = page.waitForResponse('**/api/update/available');
  await page.goto('/#/s6p-nowhere');
  await fluentRootReady(page);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await checked;
  // The dev build is the latest there is, so no banner (e2e/version-badge.spec.ts).
  await expect(page.locator('.update-banner')).toHaveCount(0);
  const boxes = await workspaceBoxes(page);
  expect(boxes.banner).toBeNull();
  expect(boxes.main).toEqual({ top: 40, bottom: 900 });
  await expectQuiet(page, problems);
});
