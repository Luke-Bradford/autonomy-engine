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
