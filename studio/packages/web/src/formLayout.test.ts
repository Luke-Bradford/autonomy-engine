import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCssSource } from './testing/cssSource';

/**
 * #1623 — the label-left form layout (`@container field-form`, #1477 / #1622)
 * applies to a field row of a known set of parents: a section's body, a drawer's
 * body, a builder fieldset, and so on. That set used to be written out four
 * times (the row, its label, its control column, the label-with-`?` head), so a
 * new form context had to be added to every copy, and a missed copy left that
 * context half label-left with nothing to say so.
 *
 * Now the set is written once and the three placements are nested under it.
 * Two narrower lists remain on purpose (checkbox alignment, sibling-hint
 * alignment), and each parent of the main list must be either in them or named
 * here as excluded, so a new context is a decision rather than an omission.
 */
const css = readCssSource(join(__dirname, 'index.css'));

/** The class names in a `:is(.a, .b)` member list. */
function classes(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Every `:is(…)` list directly followed by `follow`, as its members. */
function listsBefore(follow: string): string[][] {
  const pattern = new RegExp(`:is\\(([^()]*)\\)\\s*>\\s*${follow}`, 'g');
  return [...css.matchAll(pattern)].map(([, list = '']) => classes(list));
}

/** The brace-balanced body of the rule whose head contains the match at `at`. */
function bodyAfter(at: number): string {
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces after the label-left parent list');
}

const ROW = '\\.labelled-control(?![\\w-])';

/** Parents whose direct checkbox (or Settings row) does NOT line up with the control column. */
const NOT_CHECKBOX_ALIGNED = new Map([
  ['.config-cell', 'a field packed into a grid cell keeps the whole cell'],
  ['.panel-tab', 'decided in #1622: a tab holds sections, not bare checkboxes'],
  ['.recurrence-editor', "a builder fieldset's radios sit under its legend"],
  ['.window-editor', "a builder fieldset's radios sit under its legend"],
  ['.run-windows', "a builder fieldset's radios sit under its legend"],
  ['.run-window-row', "a builder fieldset's radios sit under its legend"],
]);

/** Parents whose sibling hint or error does NOT line up with the control column. */
const NOT_HINT_ALIGNED = new Map([
  ['.config-cell', "a packed cell's hint reads across the cell (the 580px rule)"],
  ['.panel-tab', 'decided in #1622: a tab holds sections, not bare hints'],
]);

describe('the label-left form layout (#1623)', () => {
  it('names its parents once', () => {
    expect(listsBefore(ROW)).toHaveLength(1);
  });

  it('nests the label, control-column and `?`-head placements under that one list', () => {
    const at = css.search(new RegExp(`:is\\([^()]*\\)\\s*>\\s*${ROW}`));
    const body = bodyAfter(at);
    expect(body).toMatch(/&\s*>\s*label\s*\{[^}]*grid-column:\s*1;/);
    expect(body).toMatch(
      /&\s*>\s*:not\(label, \.labelled-control__head\)\s*\{[^}]*grid-column:\s*2;/,
    );
    expect(body).toMatch(/&\s*>\s*\.labelled-control__head\s*\{[^}]*grid-column:\s*1;/);
  });

  it('places every parent in the checkbox and hint lists, or excludes it by name', () => {
    const [parents = []] = listsBefore(ROW);
    const [checkbox = []] = listsBefore(':is\\(\\.contract-check');
    const [hint = []] = listsBefore(`:is\\(\\s*${ROW},`);
    expect(parents.length).toBeGreaterThan(0);
    expect(checkbox.length).toBeGreaterThan(0);
    expect(hint.length).toBeGreaterThan(0);

    expect([...checkbox, ...NOT_CHECKBOX_ALIGNED.keys()].sort()).toEqual([...parents].sort());
    expect([...hint, ...NOT_HINT_ALIGNED.keys()].sort()).toEqual([...parents].sort());
  });
});
