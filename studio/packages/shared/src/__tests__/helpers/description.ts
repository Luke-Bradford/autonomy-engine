import { expect } from 'vitest';

/**
 * #1413 — the house rule for a catalog description (activities, expression
 * functions): ONE sentence that ends in a full stop with no sentence break
 * before it — so it is not blank, not a bare id and not a paragraph — and short
 * enough to sit under a name in a palette or a flyout row.
 */
export function expectOneSentence(description: string): void {
  expect(description).toMatch(/^[^.!?]+\.$/);
  expect(description.length).toBeLessThanOrEqual(120);
}

/**
 * A description lower-cased and without its full stop, to compare with the
 * name it must not restate: every description ends in "." and no name does,
 * so comparing them as written could never fail.
 */
export function withoutStop(description: string): string {
  return description.replace(/\.$/, '').toLowerCase();
}
