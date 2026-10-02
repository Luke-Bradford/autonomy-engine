import { describe, expect, it } from 'vitest';
// The house rule's own helper, by path: it is a test helper, not a shared export.
import {
  expectOneSentence,
  withoutStop,
} from '../../../../shared/src/__tests__/helpers/description.js';
import { FORM_SECTION_HINTS } from './sectionHints';

// #1413 OR22 — the house rule catalog descriptions follow: one sentence of at
// most 120 characters, not the section's own title, and no two the same.
function flatten(node: string | Record<string, unknown>, path: string): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, child]) =>
    flatten(child as string | Record<string, unknown>, path === '' ? key : `${path}.${key}`),
  );
}

const hints = flatten(FORM_SECTION_HINTS, '');

/** `node.activitySettings` → "activity settings", the section's title. */
function titleOf(path: string): string {
  const key = path.split('.').at(-1) ?? path;
  return key.replace(/([A-Z])/g, ' $1').toLowerCase();
}

describe('form section hints (#1413)', () => {
  it.each(hints)('%s is one sentence that is not its title', (path, hint) => {
    expectOneSentence(hint);
    expect(withoutStop(hint)).not.toBe(titleOf(path));
  });

  it('no two sections share a hint', () => {
    expect(new Set(hints.map(([, hint]) => hint)).size).toBe(hints.length);
  });
});
