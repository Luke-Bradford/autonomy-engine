import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  FOREGROUND_TOKEN,
  computedStyleOf,
  contrastRatio,
  customProperty,
  isOpaque,
  luminanceOf,
  setTheme,
} from './support/theme';

/**
 * The payoff half of the U0 bridge, asserted where it is actually observable:
 * React Flow MOUNTED, with its own chrome painted.
 *
 * `theme-bridge.spec.ts` proves the `--xy-*` overrides resolve to Fluent
 * tokens; this proves React Flow then CONSUMES them. Those are different
 * failures — a DELETED override resolves perfectly well (there is nothing left
 * to resolve) and only a mounted assertion catches it — so the two specs are
 * not redundant. This is the one that catches shipped-but-white-in-dark end to
 * end.
 *
 * Reaching a mounted canvas needs a pipeline to exist, so this spec drives the
 * real authoring flow (create -> open) rather than seeding through the API:
 * it is the same number of steps and it exercises the path a user takes.
 */

/**
 * The surfaces React Flow PAINTS, each of which renders white without the
 * bridge because RF's own `--xy-*-default` fallbacks are light.
 *
 * `.react-flow__pane` is deliberately absent: it computes to
 * `rgba(0, 0, 0, 0)` in BOTH themes (the surface colour is painted by
 * `.react-flow` itself), so a luminance assertion on it reads 0 whatever the
 * theme did — green, testing nothing. `.react-flow` is included but every
 * reading is opacity-checked first, because RF's
 * `--xy-background-color-default` is itself `transparent`: a deleted canvas
 * override would otherwise compute to `rgba(0, 0, 0, 0)` and sail through a
 * bare "is it dark" check.
 */
const PAINTED_SURFACES = [
  ['canvas surface', '.react-flow'],
  ['controls button', '.react-flow__controls-button'],
  ['minimap', '.react-flow__minimap'],
] as const;

function backgroundOf(page: Page, selector: string): Promise<string> {
  return computedStyleOf(page, selector, 'background-color');
}

/** Assert a surface is painted at all, then that it is dark / light. */
async function expectSurface(
  page: Page,
  name: string,
  selector: string,
  tone: 'dark' | 'light',
): Promise<string> {
  const color = await backgroundOf(page, selector);
  expect(isOpaque(color), `${name} is transparent (${color}) — luminance would prove nothing`).toBe(
    true,
  );
  const luminance = luminanceOf(color);
  if (tone === 'dark') {
    expect(luminance, `${name} rendered LIGHT (${color}) in the dark theme`).toBeLessThan(0.5);
  } else {
    expect(luminance, `${name} rendered DARK (${color}) in the light theme`).toBeGreaterThan(0.5);
  }
  return color;
}

test.describe('React Flow chrome follows the Fluent theme', () => {
  test('canvas chrome is DARK in the dark theme', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e dark canvas');

    for (const [name, selector] of PAINTED_SURFACES) {
      await expectSurface(page, name, selector, 'dark');
    }

    await expectQuiet(page, problems);
  });

  /**
   * The ticket's "controls glyphs light" bullet, asserted HONESTLY.
   *
   * Measured, not assumed: deleting `--xy-controls-button-color` from the
   * bridge changes NOTHING observable. React Flow's default for that slot is
   * `inherit` (its `style.css` line 44), and the glyph's ancestor is the Fluent
   * root, whose `color` is the very token the override maps to — so the
   * override and its absence compute to the same pixel. No outcome-based
   * assertion can detect that one line's removal, and writing one that appears
   * to would be the vacuity this suite exists to avoid.
   *
   * So this asserts the RENDERED OUTCOME the bullet actually cares about: the
   * glyph is the Fluent foreground, and it is READABLE against the button it
   * sits on. The contrast half has real teeth — it is what fails when the
   * button-background override breaks and leaves a light glyph on RF's white
   * default, which is the white-in-dark bug seen from the foreground side.
   */
  test('control glyphs are the Fluent foreground and readable on their button', async ({
    page,
  }) => {
    await openCanvas(page, 'e2e glyph canvas');

    // The glyph is an SVG painted with `fill: currentColor`, so the button's
    // computed `color` is what decides it.
    const [glyph, token] = await Promise.all([
      computedStyleOf(page, '.react-flow__controls-button', 'color'),
      customProperty(page, FOREGROUND_TOKEN),
    ]);
    expect(token).not.toBe('');
    expect(glyph).not.toBe('');

    // The token is authored as hex; the browser reports a resolved `color` as
    // rgb(). Normalise the token through the same serializer to compare.
    const normalisedToken = await page.evaluate((value) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }, token);
    expect(glyph).toBe(normalisedToken);

    const buttonBackground = await backgroundOf(page, '.react-flow__controls-button');
    expect(isOpaque(buttonBackground)).toBe(true);
    expect(
      contrastRatio(glyph, buttonBackground),
      `control glyph ${glyph} is unreadable on button background ${buttonBackground}`,
    ).toBeGreaterThan(4.5);
  });

  test('canvas chrome follows the toggle into the light theme', async ({ page }) => {
    await openCanvas(page, 'e2e light canvas');
    const before = new Map<string, string>();
    for (const [name, selector] of PAINTED_SURFACES) {
      before.set(selector, await expectSurface(page, name, selector, 'dark'));
    }

    await setTheme(page, 'light');

    for (const [name, selector] of PAINTED_SURFACES) {
      // Not merely "different": each surface must now be LIGHT. A bridge that
      // re-resolved to some other dark token would change the value while
      // leaving the canvas unreadable against a light page.
      await expect
        .poll(async () => (await backgroundOf(page, selector)) !== before.get(selector), {
          message: `${name} never changed colour`,
        })
        .toBe(true);
      await expectSurface(page, name, selector, 'light');
    }
  });
});
