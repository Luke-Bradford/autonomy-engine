import { describe, expect, it } from 'vitest';
import { expectAccessibleNameContainsText } from './accessibleName';

/**
 * Build the single element a fixture describes.
 *
 * The null check is not defensive noise: `firstElementChild` is `null` for HTML
 * the parser rejects or drops, and a cast would hand that `null` to the helper
 * under test, where it surfaces as a `TypeError` on `.textContent`. In a
 * `not.toThrow()` case that reads as the helper being broken; in the `toThrow`
 * cases it is a throw for the wrong reason, which the message pattern happens to
 * catch today only because it is specific. Refusing here names the fixture as
 * the culprit instead.
 */
function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  const first = host.firstElementChild;
  if (first === null) {
    throw new Error(`el: fixture parsed to no element: ${JSON.stringify(html)}`);
  }
  return first as HTMLElement;
}

describe('el (the fixture builder)', () => {
  it('REFUSES html that parses to no element, rather than passing null on', () => {
    expect(() => el('   ')).toThrow(/parsed to no element/);
  });
});

describe('expectAccessibleNameContainsText', () => {
  it('passes when the name contains the visible text', () => {
    expect(() =>
      expectAccessibleNameContainsText(el('<a aria-label="Watch run run_1">Watch</a>')),
    ).not.toThrow();
  });

  it('passes when the visible text is a run id inside a <code>', () => {
    expect(() =>
      expectAccessibleNameContainsText(
        el('<a aria-label="Source run run_0"><code>run_0</code></a>'),
      ),
    ).not.toThrow();
  });

  it('normalises the JSX whitespace an anchor’s textContent really carries', () => {
    expect(() =>
      expectAccessibleNameContainsText(
        el('<a aria-label="Watch live → run run_9">\n        Watch live →\n      </a>'),
      ),
    ).not.toThrow();
  });

  /** The defect that shipped: a separator glyph the DOM does not use. */
  it('REDS when a separator glyph differs from the rendered one', () => {
    expect(() =>
      expectAccessibleNameContainsText(
        el('<a aria-label="Watch live — run run_9">Watch live →</a>'),
      ),
    ).toThrow(/does not contain visible text/);
  });

  /**
   * The vacuous case. Raised as a NITPICK by this PR's own correctness lens:
   * `includes('')` is always true, so without the guard a labelled icon-only
   * control would report a passing 2.5.3 check having tested nothing.
   */
  it('REFUSES a labelled control with no visible text, rather than passing vacuously', () => {
    expect(() =>
      expectAccessibleNameContainsText(el('<a aria-label="Watch run run_1"><svg></svg></a>')),
    ).toThrow(/would pass vacuously/);
  });

  it('passes a control with no aria-label, whose name IS its visible text', () => {
    expect(() => expectAccessibleNameContainsText(el('<a>Watch</a>'))).not.toThrow();
  });
});
