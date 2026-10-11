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
