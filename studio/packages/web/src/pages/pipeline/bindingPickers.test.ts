import { describe, expect, it } from 'vitest';
import {
  connectionPickerGroups,
  connectionSlotReason,
  eligibleForBinding,
  filterConnectionPickerGroups,
} from './bindingPickers';

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

describe('connectionSlotReason (#1477)', () => {
  const sink = connectionSlotReason(['sqlite', 'postgres'], 'Copy', 'sink');
  it('accepts the slot’s own kinds', () => {
    expect(sink('sqlite')).toBeUndefined();
    expect(sink('postgres')).toBeUndefined();
  });
  it('names the activity and the side for every other kind', () => {
    expect(sink('fs')).toBe("Can't be a Copy sink yet");
    expect(connectionSlotReason(['fs'], 'Copy', 'source')('http')).toBe(
      "Can't be a Copy source yet",
    );
    expect(connectionSlotReason(['http'], 'HTTP request', 'single')('fs')).toBe(
      "HTTP request can't use this kind yet",
    );
  });
});

describe('connectionPickerGroups (#1477)', () => {
  const conns = [
    { id: 'w', name: 'warehouse', kind: 'sqlite' as const, config: {} },
    { id: 'f', name: 'files', kind: 'fs' as const, config: {} },
    { id: 'p', name: 'prod', kind: 'postgres' as const, config: {} },
    { id: 'h', name: 'api', kind: 'http' as const, config: {} },
    { id: 'w2', name: 'archive', kind: 'sqlite' as const, config: {} },
  ];
  const reason = connectionSlotReason(['sqlite', 'postgres'], 'Copy', 'sink');

  it('groups by kind in the gallery’s kind order, every connection listed once', () => {
    const groups = connectionPickerGroups(conns, reason, undefined);
    expect(groups.map((g) => g.kind)).toEqual(['sqlite', 'postgres', 'fs', 'http']);
    expect(groups.flatMap((g) => g.options.map((o) => o.id)).sort()).toEqual(
      ['f', 'h', 'p', 'w', 'w2'].sort(),
    );
    expect(groups.find((g) => g.kind === 'sqlite')?.options.map((o) => o.id)).toEqual(['w', 'w2']);
  });

  it('marks a kind the slot refuses as disabled, with the reason', () => {
    const groups = connectionPickerGroups(conns, reason, undefined);
    const files = groups.find((g) => g.kind === 'fs')?.options[0];
    expect(files).toEqual({
      id: 'f',
      label: 'files (File system)',
      name: 'files',
      disabledReason: "Can't be a Copy sink yet",
    });
    expect(groups.find((g) => g.kind === 'sqlite')?.options[0]?.disabledReason).toBeUndefined();
  });

  it('keeps the BOUND connection pickable even when its kind is refused', () => {
    // `eligibleForBinding`'s rule: a disabled selected option would still show,
    // but re-picking it (or a keyboard pass over it) must not be refused.
    const files = connectionPickerGroups(conns, reason, 'f')
      .find((g) => g.kind === 'fs')
      ?.options.find((o) => o.id === 'f');
    expect(files?.disabledReason).toBeUndefined();
  });

  it('drops kinds with no connections', () => {
    expect(connectionPickerGroups([], reason, undefined)).toEqual([]);
  });

  it('carries where each connection points, when its config says', () => {
    const [group] = connectionPickerGroups(
      [{ id: 'p', name: 'prod', kind: 'postgres', config: { host: 'db', database: 'sales' } }],
      reason,
      undefined,
    );
    expect(group?.options[0]?.location).toBe('db/sales');
  });
});

describe('filterConnectionPickerGroups (#1477 slice 5c)', () => {
  const groups = connectionPickerGroups(
    [
      { id: 'w', name: 'warehouse', kind: 'sqlite', config: { path: '/srv/w.sqlite' } },
      { id: 'p', name: 'prod', kind: 'postgres', config: { host: 'db', database: 'sales' } },
      { id: 'f', name: 'files', kind: 'fs', config: { roots: ['/in'] } },
    ],
    connectionSlotReason(['sqlite', 'postgres'], 'Copy', 'sink'),
    undefined,
  );
  const ids = (query: string) =>
    filterConnectionPickerGroups(groups, query).flatMap((g) => g.options.map((o) => o.id));

  it('matches on name, kind and location, ignoring case', () => {
    expect(ids('WARE')).toEqual(['w']);
    expect(ids('postgre')).toEqual(['p']);
    expect(ids('sales')).toEqual(['p']);
    // The stored kind id, as the gallery's search matches it: `fs` is in no
    // name, label or path here.
    expect(ids('fs')).toEqual(['f']);
  });

  it('keeps a refused match, still disabled: the search must not hide what exists', () => {
    const [group] = filterConnectionPickerGroups(groups, '/in');
    expect(group?.options.map((o) => [o.id, o.disabledReason])).toEqual([
      ['f', "Can't be a Copy sink yet"],
    ]);
  });

  it('drops groups left empty, and a blank query filters nothing', () => {
    expect(filterConnectionPickerGroups(groups, 'nothing-matches')).toEqual([]);
    expect(ids('  ')).toEqual(['w', 'p', 'f']);
  });
});
