import { expect, type Page } from '@playwright/test';
import { documentTheme } from './theme';

/** The two themes and two densities every audited view is checked in (OR40). */
export const THEMES = ['light', 'dark'] as const;
export const DENSITIES = ['compact', 'comfortable'] as const;

/**
 * #1594 OR40 — the published control height per density (Acceptance,
 * "Controls"). Hard-coded rather than read from `tokens.css`: a token that
 * drifts fails the spec instead of moving the check with it.
 */
export const CONTROL_H: Record<(typeof DENSITIES)[number], number> = {
  compact: 28,
  comfortable: 32,
};

/** The published table and list row height per density, held the same way as {@link CONTROL_H}. */
export const ROW_H: Record<(typeof DENSITIES)[number], number> = {
  compact: 32,
  comfortable: 36,
};

/**
 * The viewer's stored preferences, as the shipped app reads them. Hard-coded
 * rather than imported from `uiStore.ts`, for the reason `theme.ts` gives for
 * `FLUENT_ROOT`: a spec observes the shipped contract from outside, so a renamed
 * key should fail here, not rename itself and keep passing.
 */
const THEME_KEY = 'autonomy-studio.theme';
const DENSITY_KEY = 'autonomy-studio.density';

/**
 * Starts every page this test loads in `theme` and `density`, without a trip
 * through Settings: the values are in storage before the app boots. Call it
 * before the first navigation, then `expectAppearance` once a page is up.
 */
export async function preferAppearance(
  page: Page,
  theme: (typeof THEMES)[number],
  density: (typeof DENSITIES)[number],
): Promise<void> {
  await page.addInitScript(
    ([themeKey, densityKey, t, d]) => {
      localStorage.setItem(themeKey, t);
      localStorage.setItem(densityKey, d);
    },
    [THEME_KEY, DENSITY_KEY, theme, density] as const,
  );
}

/** The loaded page really is in `theme` and `density`, so a scan is not of the defaults. */
export async function expectAppearance(
  page: Page,
  theme: (typeof THEMES)[number],
  density: (typeof DENSITIES)[number],
): Promise<void> {
  expect(await documentTheme(page)).toBe(theme);
  expect(await page.evaluate(() => document.documentElement.dataset.density)).toBe(density);
}

/**
 * Each drawn match of `selector` and its rounded height, named by its
 * `aria-label` or the start of its text, so a failure says which control is off
 * `--control-h` or `--row-h`. Read in ONE evaluate.
 */
export function drawnHeights(page: Page, selector: string): Promise<{ name: string; h: number }[]> {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({
          name: el.getAttribute('aria-label') || (el.textContent ?? '').trim().slice(0, 24),
          h: Math.round(el.getBoundingClientRect().height),
        })),
    selector,
  );
}

/**
 * The computed `props` of the first DRAWN match of each selector (`null` when
 * none is drawn), in ONE evaluate: `{ [selector]: { [prop]: value } }`.
 */
export function computedStyles(
  page: Page,
  selectors: readonly string[],
  props: readonly string[],
): Promise<Record<string, Record<string, string> | null>> {
  return page.evaluate(
    ([sels, names]) =>
      Object.fromEntries(
        sels.map((sel) => {
          const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0);
          if (!el) return [sel, null];
          const s = getComputedStyle(el);
          return [sel, Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n)]))];
        }),
      ),
    [selectors, props] as const,
  );
}
