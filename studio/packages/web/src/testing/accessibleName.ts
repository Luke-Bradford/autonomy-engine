import { expect } from 'vitest';

/**
 * Assert WCAG 2.5.3 (Label in Name) on a rendered control: its accessible name
 * must CONTAIN its visible text.
 *
 * The rule is what lets a speech-input user activate a control by saying what
 * they can see, and "contains" is a LITERAL substring test — it is what axe's
 * `label-content-name-mismatch` and WCAG technique G208 check. A separator glyph
 * that differs from the rendered one is enough to break it: an em dash standing
 * in for `Watch live →`'s arrow did exactly that.
 *
 * This lives beside the render helpers rather than inside `runLinkLabel` because
 * of WHERE the failure is visible. A check inside the builder compares two
 * arguments the same caller supplies, so it can only catch a caller
 * contradicting itself in one expression. The defect that actually shipped was a
 * name disagreeing with the DOM — and only something holding the rendered
 * element can see that. #1240 asked for "a test that reds when it does not";
 * this is that test, moved from arguments to the element.
 *
 * Both sides are whitespace-normalised. JSX indentation leaves real newlines and
 * runs of spaces inside an anchor's `textContent`, so a raw comparison would red
 * on day one for reasons that have nothing to do with the rule. `textContent`
 * (not `innerText`) is read so a wrapping `<code>` — which both lineage rows use
 * — contributes its text rather than being skipped.
 *
 * A control with NO `aria-label` passes, and that is correct rather than a hole:
 * its accessible name IS its visible text, so containment is trivially true.
 * Several run links deliberately rely on that.
 */
export function expectAccessibleNameContainsText(el: HTMLElement): void {
  const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const visible = normalise(el.textContent ?? '');
  const label = el.getAttribute('aria-label');
  if (label === null) return;
  expect(
    normalise(label),
    `accessible name ${JSON.stringify(label)} does not contain visible text ${JSON.stringify(visible)} (WCAG 2.5.3)`,
  ).toContain(visible);
}
