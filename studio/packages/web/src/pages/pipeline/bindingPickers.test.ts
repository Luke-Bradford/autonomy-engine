import { describe, expect, it } from 'vitest';
import { eligibleForBinding } from './bindingPickers';

const items = [
  { id: 'a', kind: 'sqlite' },
  { id: 'b', kind: 'fs' },
  { id: 'c', kind: 'sqlite' },
];
const isSqlite = (i: { kind: string }) => i.kind === 'sqlite';

describe('eligibleForBinding (#1139)', () => {
  it('offers everything the predicate accepts', () => {
    expect(eligibleForBinding(items, isSqlite, undefined).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('ALSO offers the currently bound item when the predicate rejects it', () => {
    // The load-bearing half: without this the select falls back to "— none —"
    // while the doc still holds the binding, and the next save writes that lie.
    expect(eligibleForBinding(items, isSqlite, 'b').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not duplicate a bound item the predicate already accepts', () => {
    expect(eligibleForBinding(items, isSqlite, 'a').map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('preserves source order rather than floating the bound item', () => {
    expect(eligibleForBinding(items, () => false, 'b').map((i) => i.id)).toEqual(['b']);
  });

  it('is empty when nothing matches and nothing is bound', () => {
    expect(eligibleForBinding(items, () => false, undefined)).toEqual([]);
  });

  it('tolerates a bound id that names no item — a deleted resource', () => {
    expect(eligibleForBinding(items, isSqlite, 'gone').map((i) => i.id)).toEqual(['a', 'c']);
  });
});
