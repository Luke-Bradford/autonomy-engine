import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { CANVAS_TOKEN, FLUENT_ROOT, customProperty, fluentRootReady } from './support/theme';

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

const BRIDGE_CSS = join(
  import.meta.dirname,
  '..',
  'packages',
  'web',
  'src',
  'theme',
  'xyThemeBridge.css',
);

/**
 * The `--xy-*` overrides the bridge SOURCE declares.
 *
 * The expected set is derived from the stylesheet rather than written down
 * here, so the spec cannot drift from the bridge and no magic number decides
 * how much coverage is "enough": every override the source declares must show
 * up in the browser, and any that does not is a failure naming itself.
 */
function declaredInSource(): string[] {
  const css = readFileSync(BRIDGE_CSS, 'utf8');
  return [...css.matchAll(/^\s*(--xy-[\w-]+)\s*:/gm)].map((m) => m[1] as string).sort();
}

/**
 * The same list as the browser sees it — walked out of the live CSSOM.
 *
 * Recurses through `CSSGroupingRule` (`@media`/`@layer`/`@supports`), whose
 * children are NOT top-level `cssRules` entries, and matches each selector in
 * a grouped selector list, which a CSS minifier is entitled to produce when it
 * merges identical declaration blocks. Without both, a future override could
 * be invisible to this walk while the suite stayed green.
 */
function declaredInBrowser(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const names = new Set<string>();
    const visit = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSGroupingRule) {
          visit(rule.cssRules);
          continue;
        }
        if (!(rule instanceof CSSStyleRule)) continue;
        const selectors = rule.selectorText.split(',').map((s) => s.trim());
        if (!selectors.includes(sel)) continue;
        for (const prop of Array.from(rule.style)) {
          if (prop.startsWith('--xy-')) names.add(prop);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        // A cross-origin stylesheet cannot be inspected; the bridge is
        // same-origin, so skipping one is correct rather than a miss.
        continue;
      }
    }
    return [...names].sort();
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

  test('every override the bridge declares reaches the browser', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    // Not a floor but an equality: if the bridge stylesheet did not load, or
    // its selector moved off the provider root, the browser list is empty and
    // this names every override that went missing.
    expect(await declaredInBrowser(page)).toEqual(declaredInSource());
  });

  test('no --xy-* override is left holding an unresolved var()', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    const declared = await declaredInBrowser(page);
    // Guard the guard: an empty list would make the loop below assert nothing.
    // (The spec above proves the list is not merely non-empty but complete.)
    expect(declared.length, `found no --xy-* declarations on ${FLUENT_ROOT}`).toBeGreaterThan(0);

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
    expect(token).not.toBe('');
    expect(surface).toBe(token);
  });

  test('loads with no console errors or uncaught exceptions', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/');
    await fluentRootReady(page);
    await expectQuiet(page, problems);
  });
});
