import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { customProps, readCssSource, ruleBody } from './cssSource';

/**
 * #1243 — `ruleBody` used to find its rule with `css.indexOf(`${selector} {`)`,
 * a plain substring search with nothing anchoring the query to a rule boundary.
 *
 * This file is the guard the ticket asked for. The load-bearing case is the one
 * that was FOUND rather than imagined: writing #1239's chip guard,
 * `ruleBody(css, 'button')` returned `.icon-button`'s body — the first rule in
 * `index.css` whose selector merely ENDS in `button` — and the assertion
 * compared the new chip against a rule nobody meant to name. It failed loudly
 * only because the two rules happened to disagree on `border-radius`. Had they
 * agreed, it would have passed while measuring the wrong rule entirely, which is
 * the silent narrowing `ruleBody`'s own docblock argues against.
 *
 * Every case below reds against the old implementation, which is what makes them
 * worth writing rather than restating the current one.
 */
const css = readCssSource(join(import.meta.dirname, '..', 'index.css'));

describe('ruleBody selector matching', () => {
  it('reads the ELEMENT rule, not a class rule whose selector ends with it', () => {
    const sheet = `
.icon-button {
  border-radius: 4px;
}

button {
  border-radius: 6px;
}
`;
    expect(ruleBody(sheet, 'button')).toContain('border-radius: 6px');
    expect(ruleBody(sheet, 'button')).not.toContain('4px');
  });

  /* The real sheet, in the exact shape the ticket recorded: `.icon-button`
     (border-radius 4px, `background: none`) is declared ~300 lines BEFORE the
     bare `button` rule (6px, `--panel-2`), so a substring matcher reaches the
     wrong one first. Pinned against `index.css` and not only a fixture, because
     a fixture cannot notice the day someone adds a `…button` rule above it. */
  it('resolves `button` to the element rule in the real stylesheet', () => {
    const body = ruleBody(css, 'button');
    expect(body).toMatch(/border-radius:\s*6px/);
    expect(body).toMatch(/background:\s*var\(--panel-2\)/);
  });

  it('resolves a selector that is one member of a comma-separated list', () => {
    const sheet = `
th,
td {
  padding: 0.4rem;
}
`;
    /* BOTH members, not just the last. The old matcher found `td {` and reported
       `th` absent — so a caller asking about `th` either got a misleading
       "no rule found" or, worse, silently read some later `th {` block and lost
       every declaration the shared rule made. */
    expect(ruleBody(sheet, 'th')).toContain('padding: 0.4rem');
    expect(ruleBody(sheet, 'td')).toBe(ruleBody(sheet, 'th'));
  });

  it('does not split a comma inside a functional selector', () => {
    const sheet = `:is(h1, h2) { margin: 0; }`;
    expect(ruleBody(sheet, ':is(h1, h2)')).toContain('margin: 0');
    expect(() => ruleBody(sheet, 'h2')).toThrow(/appears only inside/);
  });

  it('tolerates any whitespace between the selector and its brace', () => {
    /* The old literal hardcoded exactly one space, so `button\n{` read as
       absent — a formatter change away from breaking every guard in the file. */
    expect(ruleBody('button\n{\n  color: red;\n}', 'button')).toContain('color: red');
    expect(ruleBody('button   { color: red; }', 'button')).toContain('color: red');
  });

  describe('refuses rather than guessing', () => {
    it('names the compound head when the selector only appears inside one', () => {
      expect(() => ruleBody('.toolbar button { padding: 0; }', 'button')).toThrow(
        /appears only inside `\.toolbar button`/,
      );
    });

    it('refuses when two rules declare the same selector', () => {
      const sheet = `.chip { color: red; }\n.chip { color: blue; }`;
      /* Returning either body drops the other's declarations, which is the same
         silent narrowing the brace walk exists to prevent — so the caller has to
         say which it means. */
      expect(() => ruleBody(sheet, '.chip')).toThrow(/declared by 2 rules/);
    });

    it('still reports a genuinely absent selector as absent', () => {
      expect(() => ruleBody('.chip { color: red; }', '.badge')).toThrow(
        /^no `\.badge` rule found$/,
      );
    });
  });

  /* Behaviour the rewrite had to PRESERVE, not add: an at-rule nested inside the
     body must not truncate it. `depth` is what makes that work, and a matcher
     rewrite is exactly the change that could quietly drop it. */
  it('keeps the brace-balanced body walk across a nested block', () => {
    const sheet = `
.chip {
  color: red;
  @supports (color: oklch(0 0 0)) {
    color: oklch(0.5 0 0);
  }
  padding: 1px;
}
`;
    const body = ruleBody(sheet, '.chip');
    expect(body).toContain('padding: 1px');
    expect(body).toContain('@supports');
  });

  it('reaches a rule nested inside an at-rule, without matching the at-rule itself', () => {
    const sheet = `@media (min-width: 40em) {\n  .chip {\n    padding: 2px;\n  }\n}`;
    expect(ruleBody(sheet, '.chip')).toContain('padding: 2px');
    expect(() => ruleBody(sheet, 'min-width')).toThrow(/no `min-width` rule found/);
  });

  it('feeds customProps a body it can read', () => {
    expect(customProps(ruleBody(':root { --a: 1px; }', ':root')).get('--a')).toBe('1px');
  });
});
