import { describe, expect, it } from 'vitest';
import {
  allowlistChanged,
  allowlistRows,
  connectionAllowlistSubject,
  datasetAllowlistSubject,
  toggleAllowlistKey,
} from './overrideAllowlist';

describe('override allowlist rules (#1305)', () => {
  it('offers the kind’s schema keys minus its security-boundary keys', () => {
    expect(connectionAllowlistSubject('fs').offered).toEqual(['maxBytes', 'maxEntries']);
    const pg = connectionAllowlistSubject('postgres').offered;
    expect(pg).toEqual(['connectTimeoutMs', 'statementTimeoutMs']);
    expect(datasetAllowlistSubject('delimited').offered).toContain('path');
  });

  it('offers nothing for a kind with no overridable settings', () => {
    expect(connectionAllowlistSubject('sqlite').offered).toEqual([]);
    expect(datasetAllowlistSubject('table').offered).toEqual([]);
  });

  it('shows a stored key the kind does not offer, with the reason', () => {
    const rows = allowlistRows(connectionAllowlistSubject('fs'), ['roots', 'model'], ['roots', 'model']);
    expect(rows).toEqual([
      { key: 'maxBytes', checked: false, stray: null },
      { key: 'maxEntries', checked: false, stray: null },
      { key: 'roots', checked: true, stray: 'never' },
      { key: 'model', checked: true, stray: 'unknown' },
    ]);
  });

  it('keeps an unticked stray visible, so it can be ticked again', () => {
    const rows = allowlistRows(connectionAllowlistSubject('fs'), ['model'], []);
    expect(rows.at(-1)).toEqual({ key: 'model', checked: false, stray: 'unknown' });
  });

  it('draws a duplicated stored key once', () => {
    const rows = allowlistRows(connectionAllowlistSubject('fs'), ['maxBytes', 'maxBytes', 'x', 'x'], []);
    expect(rows.map((r) => r.key)).toEqual(['maxBytes', 'maxEntries', 'x']);
  });

  it('toggles without duplicating a key', () => {
    expect(toggleAllowlistKey(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleAllowlistKey(['a'], 'a', true)).toEqual(['a']);
    expect(toggleAllowlistKey(['a', 'b'], 'a', false)).toEqual(['b']);
  });

  it('treats the list as a set when deciding whether it changed', () => {
    expect(allowlistChanged(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(allowlistChanged(['a', 'a'], ['a'])).toBe(false);
    expect(allowlistChanged(['a'], [])).toBe(true);
    expect(allowlistChanged([], ['a'])).toBe(true);
    expect(allowlistChanged(['a'], ['b'])).toBe(true);
  });
});
