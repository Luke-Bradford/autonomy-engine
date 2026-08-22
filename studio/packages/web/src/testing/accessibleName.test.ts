import { describe, expect, it } from 'vitest';
import { expectAccessibleNameContainsText } from './accessibleName';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

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

  it('passes a control with no aria-label, whose name IS its visible text', () => {
    expect(() => expectAccessibleNameContainsText(el('<a>Watch</a>'))).not.toThrow();
  });
});
