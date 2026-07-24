import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { customProps, findColorLiterals, readCssSource, ruleBody } from './testing/cssSource';

/**
 * The MVP shell (`index.css`) predates Fluent and paints from its OWN custom
 * properties, hardcoded dark. It cannot read Fluent's `--colorXxx` tokens:
 * Fluent scopes those to the FluentProvider ROOT ELEMENT, and `:root`/`body`
 * are ANCESTORS of that element — custom properties inherit downwards only, so
 * a `var(--colorNeutralBackground1)` on `body` resolves to nothing. So the
 * palette carries its own `[data-theme='light']` override block, driven by the
 * attribute `syncColorScheme` sets.
 *
 * The failure this guards is silent and easy: add a palette var (or a raw
 * colour) and forget the light override — light mode then keeps a dark patch
 * that only an eyeball catches. Asserted against the SOURCE TEXT because Vitest
 * returns '' for a `.css` import and jsdom computes no cascade.
 */
const css = readCssSource(join(import.meta.dirname, 'index.css'));

const BASE_SELECTOR = ':root';
const LIGHT_SELECTOR = ":root[data-theme='light']";

const base = customProps(ruleBody(css, BASE_SELECTOR));
const light = customProps(ruleBody(css, LIGHT_SELECTOR));

describe('MVP palette light/dark parity', () => {
  it('declares a dark base palette', () => {
    expect(base.size).toBeGreaterThan(0);
  });

  it('overrides EVERY base palette variable in light mode, and adds none of its own', () => {
    expect([...light.keys()].sort()).toEqual([...base.keys()].sort());
  });

  it('gives every light variable a value distinct from the dark one', () => {
    for (const [name, darkValue] of base) {
      expect(light.get(name), `${name} is identical in both themes`).not.toBe(darkValue);
    }
  });

  /**
   * `:root[data-theme='light']` has specificity (0,2,0) — a pseudo-class plus
   * an attribute selector, both class-column, with no element selector — and so
   * beats the base `:root` (0,1,0) wherever it sits in the file. Dropping the
   * `:root` prefix (a bare `[data-theme='light']`, specificity (0,1,0)) would
   * tie with the base rule and then depend on source order — a silent way to
   * lose light mode.
   */
  it('keys light mode on a selector that outranks the base rule', () => {
    expect(css).toContain(`${LIGHT_SELECTOR} {`);
  });

  /**
   * Status colours were once inline literals (`#58d68d`) outside the palette,
   * so they stayed dark-mode green in light mode. Every colour literal must now
   * live in one of the two palette blocks — checked with the SAME matcher the
   * `--xy-*` bridge guard uses, so the two cannot drift (a weaker copy of this
   * check let a `crimson` through in review).
   */
  it('keeps colour literals inside the palette blocks', () => {
    const outside = [BASE_SELECTOR, LIGHT_SELECTOR].reduce(
      (rest, selector) => rest.replace(ruleBody(css, selector), ''),
      css,
    );
    expect(findColorLiterals(outside)).toEqual([]);
    // Sanity: the matcher is not vacuous — the palette blocks are full of them.
    expect(findColorLiterals(ruleBody(css, BASE_SELECTOR)).length).toBe(base.size);
  });

  /**
   * The `● live` stream indicator animates indefinitely. The shell's a11y
   * criteria include reduced motion, and an infinite pulse is exactly the kind
   * of animation `prefers-reduced-motion` exists to stop.
   */
  it('honours prefers-reduced-motion for the infinite live-pulse animation', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
