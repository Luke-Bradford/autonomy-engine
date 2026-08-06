import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import {
  deselect,
  edgeGroup,
  firesOn,
  outcomeRadio,
  pathStyle,
  seedSelectedEdge,
  selectEdge,
  tabToFocus,
} from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  CANVAS_TOKEN,
  contrastRatio,
  customProperty,
  documentTheme,
  isOpaque,
} from './support/theme';

/**
 * U6a — typed edges, in a real browser.
 *
 * Everything here is invisible to the unit suite by construction. jsdom
 * computes no cascade, so it cannot tell whether `--edge-color` set on the edge
 * `<g>` actually reaches `.react-flow__edge-path` — and that is the whole
 * mechanism: the class could be applied perfectly, the variable could be set
 * perfectly, and the stroke could still paint React Flow's grey default because
 * the property landed on the wrong element or the rule lost a cascade contest.
 *
 * Not hypothetical, and this file is where it was caught: with the variant
 * setting only `--xy-edge-stroke`, a SELECTED edge was repainted one brand blue
 * by RF's own `.selected` rule — which is the entire time the condition can be
 * edited, since the picker lives in the property panel. The class list, the
 * unit tests and a screenshot of a deselected edge all looked right.
 *
 * Contrast is read against the CANVAS surface — Fluent's
 * `--colorNeutralBackground1`, NOT the MVP `--bg` the palette's other hues were
 * chosen against. A stroke is a non-text graphical object, so WCAG 1.4.11 wants
 * 3:1.
 */

/** WCAG 1.4.11 — non-text contrast for a graphical object. */
const GRAPHICAL_CONTRAST = 3;

/** Every option the picker offers off an `if` source: 4 outcomes + 2 arms. */
const IF_OPTIONS = [
  'op:success',
  'op:failure',
  'op:completion',
  'op:skipped',
  'branch:true',
  'branch:false',
] as const;

/** Pick a condition and WAIT for the variant class to land on the edge `<g>`. */
async function pick(page: Page, value: string): Promise<void> {
  await outcomeRadio(page, value).check();
  const variant = value.startsWith('branch:') ? 'branch' : value.slice('op:'.length);
  await expect(edgeGroup(page)).toHaveClass(new RegExp(`\\bedge-variant-${variant}\\b`));
}

/** The canvas surface colour, resolved through the browser's own serializer. */
async function canvasBackground(page: Page): Promise<string> {
  const token = await customProperty(page, CANVAS_TOKEN);
  expect(token, 'Fluent never emitted the canvas-surface token').not.toBe('');
  return page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, token);
}

/** An MVP-palette var, resolved through the browser's own colour serializer. */
function resolvedPaletteVar(page: Page, name: string): Promise<string> {
  return page.evaluate((varName) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${varName})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, name);
}

/** Every variant's DESELECTED stroke, so the hues can be compared as a set. */
async function strokeByCondition(page: Page): Promise<Map<string, string>> {
  const strokes = new Map<string, string>();
  for (const value of IF_OPTIONS) {
    await selectEdge(page);
    await pick(page, value);
    await deselect(page);
    strokes.set(value, await pathStyle(page, 'stroke'));
  }
  return strokes;
}

test.describe('U6a typed edge styling', () => {
  /**
   * The headline: each condition paints a DISTINCT, opaque, readable stroke.
   *
   * Distinctness is asserted across the whole set rather than per-colour,
   * because the failure that matters is two conditions becoming
   * indistinguishable — exactly what a variant class that stops reaching the
   * path produces, since every edge then falls back to RF's one grey default.
   * A per-colour "is it green" check would pass while four others collapsed.
   */
  test('every condition paints a distinct, readable stroke', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e u6a strokes');
    await seedSelectedEdge(page, 'If Condition');

    const canvasBg = await canvasBackground(page);
    expect(isOpaque(canvasBg)).toBe(true);

    const offered = await firesOn(page)
      .locator('input[type="radio"]')
      .evaluateAll((os) => os.map((o) => (o as HTMLInputElement).value));
    expect(offered).toEqual([...IF_OPTIONS]);

    const strokes = await strokeByCondition(page);
    for (const [value, stroke] of strokes) {
      expect(isOpaque(stroke), `${value} painted a transparent stroke (${stroke})`).toBe(true);
      expect(
        contrastRatio(stroke, canvasBg),
        `${value} stroke ${stroke} is unreadable on the canvas (${canvasBg})`,
      ).toBeGreaterThan(GRAPHICAL_CONTRAST);
    }

    // Both arms share ONE branch hue — the label is what tells them apart —
    // so five distinct colours across six conditions.
    expect(strokes.get('branch:true')).toBe(strokes.get('branch:false'));
    expect(new Set(strokes.values()).size).toBe(5);

    // The MAPPING, end to end. Distinctness alone stays green if `--success`
    // and `--error` are swapped — failures would paint green and nothing would
    // fail. `palette.test.ts` pins the mapping in the CSS SOURCE; this pins
    // that the cascade actually delivers it to the path at runtime, which is
    // the half a source test cannot see.
    expect(strokes.get('op:success')).toBe(await resolvedPaletteVar(page, '--success'));
    expect(strokes.get('op:failure')).toBe(await resolvedPaletteVar(page, '--error'));
    expect(strokes.get('branch:true')).toBe(await resolvedPaletteVar(page, '--branch'));

    await expectQuiet(page, problems);
  });

  /**
   * `skipped` carries a SECOND, non-colour channel: it is the one condition
   * that fires because the activity never RAN, and the epic's accessibility
   * criteria call for non-colour status encoding.
   */
  test('a skipped edge is dashed, and no other condition is', async ({ page }) => {
    await openCanvas(page, 'e2e u6a dash');
    await seedSelectedEdge(page);

    await pick(page, 'op:skipped');
    expect(await pathStyle(page, 'strokeDasharray')).not.toBe('none');

    await pick(page, 'op:success');
    expect(await pathStyle(page, 'strokeDasharray')).toBe('none');
  });

  /**
   * The U19 debt: `label: e.on` rendered every branch edge as the literal
   * string "branch". Both the VISIBLE label and the ACCESSIBLE name must carry
   * the routing key — React Flow renders an edge as `role="img"`, under which
   * the SVG `<text>` is not exposed at all, so the visible label alone would
   * leave colour as the only channel assistive technology gets.
   */
  test('a branch edge is labelled by its routing key, visibly and accessibly', async ({ page }) => {
    await openCanvas(page, 'e2e u6a branch label');
    await seedSelectedEdge(page, 'If Condition');
    await pick(page, 'branch:false');

    await expect(edgeGroup(page)).toHaveAttribute('aria-label', /on branch 'false'$/);
    await expect(edgeGroup(page).locator('.react-flow__edge-text')).toHaveText('false');
  });

  /**
   * A selected edge KEEPS its variant hue and gets heavier instead.
   *
   * This is the regression net for the defect this spec found: RF's
   * `.react-flow__edge.selected .react-flow__edge-path` reads
   * `--xy-edge-stroke-selected`, so leaving that slot alone repaints every
   * selected edge one brand blue — masking the condition's colour for exactly
   * as long as the picker is open. Asserting the hue SURVIVES selection is what
   * fails if that slot is ever dropped again; the width assertion is what keeps
   * "selected" visible at all.
   */
  test('selection keeps the variant hue and thickens the stroke instead', async ({ page }) => {
    await openCanvas(page, 'e2e u6a selection');
    await seedSelectedEdge(page);
    await pick(page, 'op:failure');

    const selectedStroke = await pathStyle(page, 'stroke');
    const selectedWidth = await pathStyle(page, 'strokeWidth');

    await deselect(page);
    const restingStroke = await pathStyle(page, 'stroke');
    const restingWidth = await pathStyle(page, 'strokeWidth');

    expect(selectedStroke, 'selection repainted the edge, masking its condition').toBe(
      restingStroke,
    );
    expect(parseFloat(selectedWidth)).toBeGreaterThan(parseFloat(restingWidth));
  });

  /**
   * A keyboard-FOCUSED edge is visibly distinct from a resting one.
   *
   * React Flow's own stylesheet sets `outline: none` on a focused edge and
   * indicates focus SOLELY by repainting the path with
   * `--xy-edge-stroke-selected`. Once that slot carries the variant hue (which
   * is the whole point of the rule above), a tabbed-to edge would be
   * pixel-identical to a resting one — no outline, no colour change, no width
   * change, i.e. no focus affordance at all, against a cross-cutting criterion
   * that names visible focus rings. `edgesFocusable` defaults true, so this is
   * reachable, not theoretical.
   *
   * TAB, never `.focus()`: `:focus-visible` deliberately ignores programmatic
   * focus, so a scripted `.focus()` would report "no focus ring" against a
   * perfectly working rule.
   */
  test('a keyboard-focused edge is visibly distinct from a resting one', async ({ page }) => {
    await openCanvas(page, 'e2e u6a focus');
    await seedSelectedEdge(page);
    await deselect(page);

    const restingWidth = await pathStyle(page, 'strokeWidth');
    const restingStroke = await pathStyle(page, 'stroke');

    await tabToFocus(page, 'react-flow__edge');
    expect(
      await page.evaluate(() => document.activeElement?.matches(':focus-visible')),
      'the focused edge did not match :focus-visible',
    ).toBe(true);

    expect(
      parseFloat(await pathStyle(page, 'strokeWidth')),
      'a focused edge is indistinguishable from a resting one',
    ).toBeGreaterThan(parseFloat(restingWidth));
    // ...and it keeps its condition's colour while focused.
    expect(await pathStyle(page, 'stroke')).toBe(restingStroke);
  });

  /** Both themes: the LIGHT palette must be readable on the LIGHT canvas. */
  test('every stroke stays readable after the theme toggle', async ({ page }) => {
    await openCanvas(page, 'e2e u6a light');
    await seedSelectedEdge(page, 'If Condition');
    await page.getByRole('switch', { name: 'Dark mode' }).click();
    await expect.poll(() => documentTheme(page)).toBe('light');

    const canvasBg = await canvasBackground(page);
    expect(isOpaque(canvasBg)).toBe(true);

    const strokes = await strokeByCondition(page);
    for (const [value, stroke] of strokes) {
      expect(isOpaque(stroke)).toBe(true);
      expect(
        contrastRatio(stroke, canvasBg),
        `${value} stroke ${stroke} is unreadable on the LIGHT canvas (${canvasBg})`,
      ).toBeGreaterThan(GRAPHICAL_CONTRAST);
    }
    expect(new Set(strokes.values()).size).toBe(5);
  });
});
