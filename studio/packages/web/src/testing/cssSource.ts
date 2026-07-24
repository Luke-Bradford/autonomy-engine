import { readFileSync } from 'node:fs';

/**
 * Test-only helpers for asserting against CSS SOURCE TEXT.
 *
 * Two stylesheets carry load-bearing theming invariants — `theme/xyThemeBridge.css`
 * (React Flow chrome must derive from Fluent tokens) and `index.css` (the MVP
 * palette must be complete in both themes). Neither can be checked at runtime:
 * Vitest returns `''` for a `.css` import (even with `?raw`), and jsdom computes
 * no cascade. So both are read off disk and inspected as text.
 *
 * This module exists because the colour-literal guard was hardened once, on the
 * U0 review (named colours added alongside hex and rgb/hsl), and then a second
 * copy of the same guard shipped in U1 WITHOUT that hardening — a `crimson`
 * slipped straight through it. One definition, two callers, no drift.
 */

/** Read a stylesheet and strip block comments, so prose mentioning `#fff` never trips a guard. */
export function readCssSource(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every literal colour form. A hex-only check is not enough: a function colour
 * (`rgb()`, `hsl()`, and the modern `lab()`/`oklch()`/`color-mix()` forms) or a
 * plain named colour hardcodes a value just as effectively, and stays identical
 * in both themes.
 *
 * The named-colour arm brackets on `[\w-]` rather than `\b`, so a hyphenated
 * identifier that merely CONTAINS a colour word (`white-space: nowrap`,
 * `border-color`) is not mistaken for one.
 */
export const COLOR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(|(?<![\w-])(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|brown|cyan|magenta|navy|teal|olive|maroon|lime|aqua|fuchsia|beige|ivory|khaki|coral|crimson|salmon|tan|violet|indigo|turquoise|tomato)(?![\w-])/i;

/** Every colour literal in `text` (global-flag counterpart of {@link COLOR_LITERAL}). */
export function findColorLiterals(text: string): string[] {
  return [...text.matchAll(new RegExp(COLOR_LITERAL.source, 'gi'))].map((m) => m[0]);
}

/**
 * The declaration body of the rule with exactly this selector, brace-balanced so
 * a nested block (`@supports`, `@media`, or any brace-bearing value) cannot
 * truncate it — a truncated body silently NARROWS whatever the caller then
 * asserts over it.
 */
export function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no \`${selector} {\` rule found`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in the \`${selector}\` rule`);
}

/** The `--name: value` custom properties declared directly in a rule body. */
export function customProps(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name = '', value = ''] = match;
    found.set(name, value.trim());
  }
  return found;
}
