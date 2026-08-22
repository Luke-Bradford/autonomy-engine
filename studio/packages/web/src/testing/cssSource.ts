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
 * Every top-level selector a rule head declares, at every offset it opens.
 *
 * A CSS rule head is whatever sits between the previous `}`/`{`/`;` and the `{`
 * that opens the body, so this walks the sheet once and records `{` offsets
 * against the trimmed selectors their head declares. Commas are split at PAREN
 * DEPTH ZERO, so a functional selector that contains one (`:is(a, b)`) stays one
 * member rather than two broken halves.
 *
 * At-rule heads (`@media`, `@supports`) are recorded as their own head and never
 * split, so `@media (min-width: 40em)` can never be mistaken for a selector;
 * their nested rules are reached on the same walk, because the head of a nested
 * rule begins at the `{` that opened the block.
 */
function ruleHeads(css: string): { selectors: string[]; open: number }[] {
  const heads: { selectors: string[]; open: number }[] = [];
  let from = 0;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    /* A quoted value is inert. `content: "}"` and `url("a;b")` are real CSS, and
       without this the walk treats their punctuation as structure — which is the
       silent-narrowing failure this module exists to prevent, one level up. */
    if (quote !== null) {
      if (ch === quote && css[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '}' || ch === ';') from = i + 1;
    else if (ch === '{') {
      const head = css.slice(from, i).trim();
      from = i + 1;
      if (head.startsWith('@')) {
        heads.push({ selectors: [head], open: i });
        continue;
      }
      const selectors: string[] = [];
      let depth = 0;
      let inValue: string | null = null;
      let member = '';
      for (let k = 0; k < head.length; k += 1) {
        const c = head[k] as string;
        /* Brackets AND quotes, not just parens: `[data-x="a,b"]` is one member,
           and splitting it produces both a false reject (the real selector is
           unfindable) and a false accept (the nonsense tail `b"]` matches). */
        if (inValue !== null) {
          member += c;
          if (c === inValue && head[k - 1] !== '\\') inValue = null;
          continue;
        }
        if (c === '"' || c === "'") {
          inValue = c;
          member += c;
          continue;
        }
        if (c === '(' || c === '[') depth += 1;
        else if (c === ')' || c === ']') depth -= 1;
        if (c === ',' && depth === 0) {
          selectors.push(member.trim());
          member = '';
        } else member += c;
      }
      selectors.push(member.trim());
      heads.push({ selectors: selectors.filter((s) => s !== ''), open: i });
    }
  }
  return heads;
}

/**
 * The declaration body of the rule with exactly this selector, brace-balanced so
 * a nested block (`@supports`, `@media`, or any brace-bearing value) cannot
 * truncate it — a truncated body silently NARROWS whatever the caller then
 * asserts over it. Quoted values are inert to both the balance walk and the head
 * scan, because `content: "}"` is CSS this file's own claim could not survive.
 *
 * The selector is matched against parsed rule HEADS, not by substring (#1243).
 * `indexOf(`${selector} {`)` had nothing anchoring the query to a rule boundary,
 * so any rule whose selector merely ENDED with it matched first: `ruleBody(css,
 * 'button')` returned `.icon-button`'s body, and the caller compared a chip
 * against a rule nobody meant to name. That failed loudly only because the two
 * happened to disagree — had they matched, the assertion would have passed while
 * measuring the wrong rule, which is the same silent narrowing this function's
 * brace walk already exists to prevent.
 *
 * Head matching also makes the whitespace before the brace irrelevant (the old
 * literal hardcoded exactly one space) and makes a LIST member resolve to the
 * rule it is actually part of, so `th` in `th,\ntd { … }` reads the shared body
 * rather than reporting itself absent.
 *
 * Both failure modes THROW, and they are distinct on purpose:
 *
 * - **Ambiguous** — two heads declare the selector, so there is no single body
 *   to return and picking either silently drops the other's declarations. The
 *   caller has to say which it means (a more specific selector, or `customProps`
 *   over both). Live instance: `.stream-phase-live` is declared twice in
 *   `index.css`, once at top level and once inside a `prefers-reduced-motion`
 *   block, so asking for it by that name refuses rather than answering about
 *   whichever came first.
 * - **Compound-only** — the selector appears only inside a longer head
 *   (`.x button`), which is exactly the mistake the old matcher made silently.
 */
export function ruleBody(css: string, selector: string): string {
  const wanted = selector.trim();
  const heads = ruleHeads(css);
  const matches = heads.filter((h) => h.selectors.includes(wanted));
  if (matches.length > 1) {
    throw new Error(
      `\`${wanted}\` is declared by ${String(matches.length)} rules; ` + `no single body to return`,
    );
  }
  const hit = matches[0];
  if (!hit) {
    const compound = heads
      .flatMap((h) => h.selectors)
      .find((s) => new RegExp(`(^|[\\s>+~(])${escapeForRegExp(wanted)}([\\s>+~,)]|$)`).test(s));
    throw new Error(
      compound === undefined
        ? `no \`${wanted}\` rule found`
        : `no \`${wanted}\` rule found; it appears only inside \`${compound}\``,
    );
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = hit.open; i < css.length; i += 1) {
    const ch = css[i];
    if (quote !== null) {
      if (ch === quote && css[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(hit.open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in the \`${wanted}\` rule`);
}

/** Escape a selector for use inside the compound-head probe above. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
