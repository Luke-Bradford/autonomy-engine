import { expect, type Page } from '@playwright/test';

/**
 * Shared vocabulary for the theme specs. These lived in two spec files as
 * byte-identical copies until this was extracted, which is the setup for a
 * failure this repo has already paid for once: see
 * `packages/web/src/testing/cssSource.ts`, where a colour-literal guard was
 * hardened on the U0 review and a second, un-hardened copy then shipped in U1
 * and let a `crimson` through. One definition, several callers, no drift.
 */

/**
 * Hard-coded rather than imported from `theme/fluentTheme.ts`'s
 * `FLUENT_ROOT_CLASS` ON PURPOSE. An e2e spec observes the SHIPPED contract
 * from outside the app: if someone renames the class, these specs should FAIL
 * rather than silently rename themselves and keep passing. (Importing app
 * source would also drag `@fluentui/react-components` into the Playwright
 * runner across a tsconfig boundary, for a 17-character string.)
 *
 * `:not([data-portal-node])` is load-bearing, and cost a U2 debugging round.
 * The moment ANY Fluent surface that portals — a `Tooltip`, `Popover`, `Menu` —
 * is mounted, Fluent creates a mount node under `<body>` and COPIES the
 * provider's className onto it, so `.app-fluent-root` alone matches two
 * elements and Playwright's strict mode fails every theme spec at once. That
 * copy is desirable (it is why a portalled flyout is themed, and why the
 * `--xy-*` bridge keyed on this class reaches surfaces rendered over the
 * canvas) — so the fix is to name the APP's root here, not to stop Fluent
 * cloning the class.
 *
 * Note the two constants are NOT interchangeable. `BRIDGE_SELECTOR` is the
 * selector `xyThemeBridge.css` is keyed on and is matched against rule
 * `selectorText` in the CSSOM; `FLUENT_ROOT` picks a specific ELEMENT out of the
 * DOM. Using the DOM one to match a stylesheet rule finds nothing, and reports
 * it as "the bridge did not load" — which is a very convincing wrong answer.
 */
export const BRIDGE_SELECTOR = '.app-fluent-root';
export const FLUENT_ROOT = `${BRIDGE_SELECTOR}:not([data-portal-node])`;

/** Fluent's portalled clone of the provider root — where flyouts mount. */
export const FLUENT_PORTAL_ROOT = `${BRIDGE_SELECTOR}[data-portal-node]`;

/** The Fluent token the bridge maps the canvas SURFACE to. */
export const CANVAS_TOKEN = '--colorNeutralBackground1';

/** The Fluent token the bridge maps React Flow's control GLYPHS to. */
export const FOREGROUND_TOKEN = '--colorNeutralForeground1';

/** Computed value of a custom property ON the FluentProvider root element. */
export function customProperty(page: Page, name: string): Promise<string> {
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

/** Computed value of a normal CSS property on the first matching element. */
export function computedStyleOf(page: Page, selector: string, property: string): Promise<string> {
  return page.evaluate(
    ([sel, prop]) => {
      const el = document.querySelector(sel as string);
      if (!el) throw new Error(`no element matched ${sel as string}`);
      return getComputedStyle(el)
        .getPropertyValue(prop as string)
        .trim();
    },
    [selector, property],
  );
}

export function documentTheme(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.theme);
}

/**
 * The provider root exists and Fluent has emitted its tokens ON it.
 *
 * Load-bearing for every assertion that reads a custom property: `page.goto`
 * resolves on `load`, but `.app-fluent-root` only exists once React has
 * committed, so an unguarded read races the mount — and `customProperty`
 * answers `''` for a missing element, which makes "the value CHANGED" and "no
 * override is empty" style assertions pass for the wrong reason.
 */
export async function fluentRootReady(page: Page): Promise<void> {
  await expect(page.locator(FLUENT_ROOT)).toBeAttached();
  await expect
    .poll(() => customProperty(page, CANVAS_TOKEN), {
      message: `Fluent never emitted ${CANVAS_TOKEN} on ${FLUENT_ROOT}`,
    })
    .not.toBe('');
}

/**
 * sRGB relative luminance of a computed colour.
 *
 * Rejects anything that is not `rgb()`/`rgba()` rather than best-effort
 * parsing it. A `color(srgb 0.16 0.16 0.16)` would otherwise yield three
 * 0-to-1 numbers that this divides by 255, giving a luminance near zero — so
 * every "is dark" assertion would pass and every "is light" one fail. The
 * failure would be asymmetric and silent, which is the exact shape of bug this
 * suite exists to catch. Chromium serializes every token the app uses today as
 * `rgb()`/`rgba()`; if that ever stops being true, this throws and says so.
 */
export function luminanceOf(color: string): number {
  if (!/^rgba?\(/.test(color)) {
    throw new Error(`unsupported colour syntax (expected rgb/rgba): ${color}`);
  }
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) throw new Error(`unparseable colour: ${color}`);
  const [r, g, b] = parts.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG relative contrast ratio between two computed colours (1:1 identical,
 * 21:1 black on white). Both must be opaque for the number to mean anything.
 */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Is this computed colour actually PAINTED?
 *
 * A transparent colour has luminance 0, so `luminanceOf(...) < 0.5` — "this
 * surface is dark" — passes for a surface that paints nothing at all, in every
 * theme. React Flow makes that a live hazard rather than a hypothetical: its
 * `--xy-background-color-default` is literally `transparent`, so deleting the
 * canvas-surface override leaves `.react-flow` computing `rgba(0, 0, 0, 0)`
 * and a bare luminance check green. Assert opacity first, then darkness.
 */
export function isOpaque(color: string): boolean {
  const parts = color.match(/[\d.]+/g);
  if (!parts) return false;
  // rgb() has 3 components (opaque by definition); rgba()'s 4th is the alpha.
  return parts.length < 4 || Number(parts[3]) === 1;
}
