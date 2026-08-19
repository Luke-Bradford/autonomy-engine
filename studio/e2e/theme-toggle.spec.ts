import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  CANVAS_TOKEN,
  customProperty,
  documentTheme,
  fluentRootReady,
  themeSwitch,
} from './support/theme';

/**
 * U1 — the runtime light/dark toggle. The claim under test is the SSOT one:
 * ONE store value drives BOTH themed surfaces at once — the Fluent design
 * tokens (which is what React Flow's chrome follows, through the U0 bridge)
 * AND `<html data-theme>` (which is what the pre-Fluent MVP palette follows).
 * A change that re-themed only one of them would leave a half-light page and
 * would pass every jsdom unit test, because jsdom computes no styles.
 */

/** Snapshot of everything one store value is supposed to drive. */
async function themedSurfaces(page: Page) {
  const [theme, token, xyCanvas] = await Promise.all([
    documentTheme(page),
    customProperty(page, CANVAS_TOKEN),
    customProperty(page, '--xy-background-color'),
  ]);
  return { theme, token, xyCanvas };
}

test.describe('U1 theme toggle', () => {
  test('ships dark by default, with every themed surface agreeing', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);
    await expect(themeSwitch(page)).toBeChecked();

    const dark = await themedSurfaces(page);
    expect(dark.theme).toBe('dark');
    expect(dark.token).not.toBe('');
    // The bridge follows the token, not a per-theme block of its own.
    expect(dark.xyCanvas).toBe(dark.token);
  });

  test('one toggle re-themes Fluent AND the document root together', async ({ page }) => {
    await page.goto('/');
    // The baseline must be REAL before it can be compared against. Without
    // this the read races React's first commit, `customProperty` answers `''`
    // for the absent root, and the "the colour changed" assertion below passes
    // by comparing something to nothing.
    await fluentRootReady(page);
    const dark = await themedSurfaces(page);
    expect(dark.theme).toBe('dark');
    expect(dark.token).not.toBe('');

    await themeSwitch(page).click();
    await expect(themeSwitch(page)).not.toBeChecked();
    await expect.poll(() => documentTheme(page)).toBe('light');

    const light = await themedSurfaces(page);
    // Fluent re-emitted its tokens: the canvas surface is a DIFFERENT colour...
    expect(light.token).not.toBe('');
    expect(light.token).not.toBe(dark.token);
    // ...and the React Flow bridge followed it in the same beat.
    expect(light.xyCanvas).toBe(light.token);
  });

  test('the preference survives a reload', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);
    await themeSwitch(page).click();
    await expect.poll(() => documentTheme(page)).toBe('light');
    const beforeReload = await themedSurfaces(page);

    await page.reload();
    await fluentRootReady(page);
    await expect(themeSwitch(page)).not.toBeChecked();

    const restored = await themedSurfaces(page);
    expect(restored.theme).toBe('light');
    // The SAME light colours came back, not merely "some" non-empty value.
    expect(restored.token).toBe(beforeReload.token);
    expect(restored.xyCanvas).toBe(restored.token);
  });

  test('toggling produces no console errors or uncaught exceptions', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/');
    await fluentRootReady(page);
    await themeSwitch(page).click();
    await expect.poll(() => documentTheme(page)).toBe('light');
    await themeSwitch(page).click();
    await expect.poll(() => documentTheme(page)).toBe('dark');
    await expectQuiet(page, problems);
  });
});
