import { expect, type Locator, type Page } from '@playwright/test';

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

/**
 * The `rgb(...)` a palette custom property actually PAINTS as.
 *
 * `customProperty` returns the DECLARED text (`#58d68d`), while
 * `getComputedStyle(el).backgroundColor` returns the resolved
 * `rgb(88, 214, 141)` — comparing the two directly always fails, and hardcoding
 * the rgb form in a spec forks the palette. So the value is resolved the only
 * way a browser will resolve it: by making something use it.
 *
 * The probe is appended to `document.body` (never inside the React tree, whose
 * children React reconciles) and removed in the same evaluate, so the page is
 * unchanged by the measurement.
 */
export function resolvedPaletteColor(page: Page, name: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${v})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, name);
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
 * The colour of the surface a mark is ACTUALLY painted on, found by walking up
 * from `selector` to the first ancestor that paints an OPAQUE background.
 *
 * A contrast ratio taken against a colour that is not behind the mark measures
 * nothing, and — this is the part that makes it dangerous rather than merely
 * useless — it keeps reading green straight through a real regression. The
 * temptation is to name the surface (`--panel`, `body`), and #967 is the record
 * of how wrong that goes: `--panel` was the guess, and it was wrong twice over,
 * because nothing between the chart and `<body>` sets a background and the
 * thing that does is the FluentProvider root, whose colour comes from a Fluent
 * token and not from this app's palette at all. So the surface is FOUND, never
 * named.
 *
 * The walk collects the whole ancestor chain in the page and applies `isOpaque`
 * HERE, rather than reimplementing an opacity test inside the `evaluate`. That
 * is deliberate: the inline predicate this was lifted from asked only "not
 * literal `transparent`, and alpha not exactly 0", which STOPS at a
 * partial-alpha ancestor and reports a colour nothing is painted in. That is
 * live, not hypothetical — `--container-fill` is `rgba(154, 163, 178, 0.1)` and
 * is painted by `.flow-container`, so a walk starting inside a container would
 * have taken a 10%-alpha fill as its answer. A partial-alpha ancestor means the
 * true surface is a BLEND this cannot compute, so it is skipped and the walk
 * keeps climbing to something that really is the backdrop.
 *
 * The walk starts AT the matched element, not at its parent, and that is the
 * right end of the range for a contrast measurement: if the mark paints its own
 * background, that background IS what is behind it. Nothing relies on it today
 * (`.node-status` sets only `color` and its ring), but the alternative — always
 * skipping to the parent — would silently measure through an opaque chip.
 *
 * Throws rather than returning `''` when the selector matches nothing or
 * nothing in the chain paints — `luminanceOf('')` would otherwise throw with no
 * mention of what was being measured, which is the same "very convincing wrong
 * answer" failure `FLUENT_ROOT`'s docblock above describes.
 */
export async function surfaceBehind(
  page: Page,
  selector: string,
): Promise<{ color: string; from: string }> {
  const chain = await page.evaluate((sel) => {
    const start = document.querySelector(sel);
    if (!start) throw new Error(`no element matched ${sel}`);
    const describe = (el: Element) => {
      const id = el.id ? `#${el.id}` : '';
      // `className` is an `SVGAnimatedString` on SVG elements and renders as
      // `[object SVGAnimatedString]`; `classList` is uniform across both.
      const classes = Array.from(el.classList)
        .map((c) => `.${c}`)
        .join('');
      return `${el.tagName.toLowerCase()}${id}${classes}`;
    };
    const chainOut: { color: string; from: string }[] = [];
    for (let node: Element | null = start; node; node = node.parentElement) {
      chainOut.push({ color: getComputedStyle(node).backgroundColor, from: describe(node) });
    }
    return chainOut;
  }, selector);

  const painted = chain.find((link) => isOpaque(link.color));
  if (!painted) {
    throw new Error(
      `nothing behind ${selector} paints an opaque background: ` +
        chain.map((link) => `${link.from} -> ${link.color}`).join(', '),
    );
  }
  return painted;
}

/**
 * Put the app in `theme` THE WAY A USER DOES — through the toggle.
 *
 * Writing `document.documentElement.dataset.theme` instead drives only HALF the
 * app. The store value behind the switch feeds two surfaces: `<html data-theme>`
 * (which the pre-Fluent MVP palette follows) and the `FluentProvider`'s theme
 * prop (which is a React prop, so no DOM write can move it). Setting the dataset
 * alone leaves the Fluent root still painting its DARK background under a page
 * that calls itself light — which is fine for a spec that only reads a palette
 * custom property, and quietly wrong for any spec that measures a rendered
 * colour AGAINST the surface behind it. This drives both, and waits for it.
 *
 * Which state we are ALREADY in is read off the switch, not off `data-theme`.
 * The attribute is a derived half-truth — that is the whole premise of #1027 —
 * so a caller that had hand-written it would make a `data-theme`-keyed helper
 * click the wrong way and end up in the theme it was asked to leave. The switch
 * is the control the store actually backs. `data-theme` is still what we WAIT
 * on, because it is written in the provider's layout effect and so is a barrier
 * for the Fluent commit as well as the palette one.
 *
 * SCOPED TO THE RAIL, which is the one place the switch is on every route.
 * `#/settings` renders a SECOND `ThemeToggle` against the same store (#1094), so
 * an unscoped query is ambiguous there and Playwright's strict mode fails the
 * whole helper — for a caller that only wanted a theme, on a route it may have
 * navigated to incidentally. Scoping fixes that at the definition rather than
 * leaving each caller to discover it. Any surface may grow a third toggle; the
 * rail's is the one that cannot go away, because it is the shell.
 *
 * The locator itself is `themeSwitch` below, so a spec that needs the CONTROL
 * (to assert its checked state, or that it survives a route change) and a spec
 * that just needs a THEME share one definition of where the switch is.
 */
export async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const toggle = themeSwitch(page);
  if ((await toggle.isChecked()) !== (theme === 'dark')) await toggle.click();
  await expect.poll(() => documentTheme(page)).toBe(theme);
}

/**
 * THE theme switch — the rail's, scoped to it (#1096, #1033).
 *
 * `#/settings` renders a SECOND `ThemeToggle` against the same store (#1094), so
 * a bare `getByRole('switch', { name: 'Dark mode' })` is ambiguous on that route
 * and Playwright's strict mode fails the whole spec — reported as "the toggle
 * vanished", which is a very convincing wrong answer for what is a locator bug.
 *
 * SIX specs had open-coded that unscoped query, plus `settings.spec.ts`'s own
 * byte-identical `railToggle` — already rail-scoped, and so the copy that shows
 * the scoping itself was worth sharing rather than re-deriving. None was broken
 * (none combined a theme assertion
 * with a visit to Settings), and that is exactly the drift this module's header
 * warns about: the copies were latent, not wrong, so nothing would have made
 * them converge. Any surface may grow a third toggle; the rail's is the one that
 * cannot go away, because it IS the shell — so it is the one named here.
 */
export function themeSwitch(page: Page): Locator {
  return page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('switch', { name: 'Dark mode' });
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
