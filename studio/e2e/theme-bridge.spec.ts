import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems } from './support/console-guard';

/**
 * U0 (#705) — the `--xy-*` -> Fluent-token theme bridge, asserted in a real
 * browser. Every claim here was hand-verified once when U0 shipped and was
 * then unguarded: jsdom resolves no custom properties, so the unit suite can
 * only check that the bridge STYLESHEET says what it should, never that the
 * browser RESOLVES it. The specific failure this file exists to catch is
 * silent — an override pointing at a token that does not resolve in its scope
 * falls back to React Flow's white light default rather than throwing, so the
 * canvas chrome renders white-on-dark with a green test suite.
 */

const FLUENT_ROOT = '.app-fluent-root';

/** The Fluent token the bridge maps the canvas surface to. */
const CANVAS_TOKEN = '--colorNeutralBackground1';

/**
 * The provider root exists and Fluent has emitted its tokens ON it. Everything
 * else in this file reads custom properties off that element, so a spec that
 * ran before Fluent's Griffel styles were applied would read empty strings and
 * "pass" its var()-freedom check vacuously.
 */
async function fluentRootReady(page: Page): Promise<void> {
  await expect(page.locator(FLUENT_ROOT)).toBeAttached();
  await expect
    .poll(() => customProperty(page, CANVAS_TOKEN), {
      message: `Fluent never emitted ${CANVAS_TOKEN} on ${FLUENT_ROOT}`,
    })
    .not.toBe('');
}

/** Computed value of a custom property ON the FluentProvider root element. */
function customProperty(page: Page, name: string): Promise<string> {
  return page.evaluate(
    ([sel, prop]) => {
      const el = document.querySelector(sel as string);
      if (!el) return '';
      return getComputedStyle(el)
        .getPropertyValue(prop as string)
        .trim();
    },
    [FLUENT_ROOT, name],
  );
}

/**
 * Every `--xy-*` custom property the bridge DECLARES, read back out of the
 * CSSOM rather than hard-coded here, so this spec keeps covering the bridge as
 * U2+ grow it — a hard-coded list would silently stop testing new overrides.
 */
function declaredXyOverrides(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const names = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // A cross-origin stylesheet cannot be inspected; the bridge is
        // same-origin, so skipping one is correct rather than a miss.
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule) || rule.selectorText !== sel) continue;
        for (const prop of Array.from(rule.style)) {
          if (prop.startsWith('--xy-')) names.add(prop);
        }
      }
    }
    return [...names];
  }, FLUENT_ROOT);
}

test.describe('U0 theme bridge', () => {
  test('Fluent design tokens resolve on the provider root', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    const background = await customProperty(page, CANVAS_TOKEN);
    // A concrete colour, not a name and not a pass-through of the var() itself.
    expect(background).toMatch(/^(#|rgb|hsl)/);
  });

  test('no --xy-* override is left holding an unresolved var()', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    const declared = await declaredXyOverrides(page);
    // Guard the guard: if the CSSOM walk finds nothing (bridge renamed, class
    // changed, stylesheet not loaded) the per-property loop below would be
    // empty and this spec would pass having asserted nothing at all.
    expect(
      declared.length,
      `found no --xy-* declarations on ${FLUENT_ROOT} — the bridge stylesheet did not load, or its selector moved`,
    ).toBeGreaterThan(15);

    const resolved = await page.evaluate(
      ({ sel, names }) => {
        const el = document.querySelector(sel);
        if (!el) return [];
        const styles = getComputedStyle(el);
        return names.map((name) => [name, styles.getPropertyValue(name).trim()] as const);
      },
      { sel: FLUENT_ROOT, names: declared },
    );

    for (const [name, value] of resolved) {
      // An unresolvable var() reference computes to the guaranteed-invalid
      // value, i.e. the empty string — which is precisely how the white-in-dark
      // bug hides: React Flow then falls back to its `--xy-*-default` light
      // colour and nothing anywhere reports a problem.
      expect(
        value,
        `${name} resolved to nothing — its Fluent token is undefined in this scope`,
      ).not.toBe('');
      expect(value, `${name} still contains an unsubstituted var() reference`).not.toContain(
        'var(',
      );
    }
  });

  test('the bridge actually maps the canvas surface onto the Fluent token', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    // Not just "both are non-empty": the override must resolve to the SAME
    // colour as the token it claims to follow, which is what makes the canvas
    // track the Fluent theme.
    const [surface, token] = await Promise.all([
      customProperty(page, '--xy-background-color'),
      customProperty(page, CANVAS_TOKEN),
    ]);
    expect(surface).toBe(token);
  });

  test('loads with no console errors or uncaught exceptions', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/');
    await fluentRootReady(page);
    expect(problems).toEqual([]);
  });
});
