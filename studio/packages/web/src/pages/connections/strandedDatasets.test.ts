import type { Dataset } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import {
  datasetsOnConnection,
  deleteConfirmMessage,
  formatNameList,
  kindChangeAdvisory,
  strandedByKindChange,
  STRAND_NAME_LIMIT,
} from './strandedDatasets';

/**
 * #1174 — the strand rules, without a DOM.
 *
 * These are the rules BOTH surfaces obey (the edit form's note and the delete
 * confirm's string), which is why they are extracted and why they are tested
 * here rather than only through a render.
 */

function dataset(
  over: Partial<Dataset> & Pick<Dataset, 'name' | 'kind' | 'connectionId'>,
): Dataset {
  return {
    id: `ds-${over.name}`,
    ownerId: 'own-1',
    config: {},
    columns: [],
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...over,
  } as Dataset;
}

// `table` lives on sqlite|postgres; `delimited` lives on fs. That pairing is
// what makes each direction below reachable.
const tableOnStore = dataset({ name: 'orders', kind: 'table', connectionId: 'conn-a' });
const secondTable = dataset({ name: 'customers', kind: 'table', connectionId: 'conn-a' });
const delimitedOnStore = dataset({ name: 'exports', kind: 'delimited', connectionId: 'conn-a' });
const elsewhere = dataset({ name: 'other', kind: 'table', connectionId: 'conn-b' });

describe('datasetsOnConnection', () => {
  it('takes every dataset naming the connection, whatever its kind', () => {
    const hit = datasetsOnConnection([tableOnStore, delimitedOnStore, elsewhere], 'conn-a').map(
      (d) => d.name,
    );
    // `delimited` DISAGREES with a sqlite store and is still included: a delete
    // dangles the id regardless of whether the kinds ever agreed.
    expect(hit).toEqual(['orders', 'exports']);
  });

  it('is empty for a connection nothing names', () => {
    expect(datasetsOnConnection([tableOnStore], 'conn-z')).toEqual([]);
  });
});

describe('strandedByKindChange', () => {
  it('names the datasets that agree now and would not after', () => {
    const stranded = strandedByKindChange(
      [tableOnStore, secondTable, elsewhere],
      'conn-a',
      'sqlite',
      'http',
    );
    expect(stranded.map((d) => d.name)).toEqual(['orders', 'customers']);
  });

  it('says nothing about a dataset that was ALREADY mismatched', () => {
    // `delimited` never agreed with a sqlite store, so this edit does not strand
    // it — the datasets list already carries #1158's marker for it, and
    // repeating that here would report the pre-existing state as a consequence
    // of an edit that did not cause it.
    expect(
      strandedByKindChange([delimitedOnStore], 'conn-a', 'sqlite', 'http').map((d) => d.name),
    ).toEqual([]);
  });

  it('says nothing on the REPAIR direction', () => {
    // sqlite -> fs moves `delimited` INTO agreement. A warning here would fire
    // on the operator fixing the very thing the advisory exists to report.
    expect(strandedByKindChange([delimitedOnStore], 'conn-a', 'sqlite', 'fs')).toEqual([]);
  });

  it('says nothing when the kind has not moved', () => {
    expect(strandedByKindChange([tableOnStore], 'conn-a', 'sqlite', 'sqlite')).toEqual([]);
  });

  it('holds its tongue about datasets on a DIFFERENT connection', () => {
    expect(strandedByKindChange([elsewhere], 'conn-a', 'sqlite', 'http')).toEqual([]);
  });

  it('still strands a dataset when the new kind is another store kind it cannot live on', () => {
    // Both `sqlite` and `postgres` carry `table`, so a sqlite->postgres change
    // strands nothing; `delimited` on an fs store moving to sqlite does.
    expect(strandedByKindChange([tableOnStore], 'conn-a', 'sqlite', 'postgres')).toEqual([]);
    const fsDataset = dataset({ name: 'feed', kind: 'delimited', connectionId: 'conn-a' });
    expect(strandedByKindChange([fsDataset], 'conn-a', 'fs', 'sqlite').map((d) => d.name)).toEqual([
      'feed',
    ]);
  });
});

describe('formatNameList', () => {
  it('spells out a short list', () => {
    expect(formatNameList(['a', 'b'])).toBe('a, b');
  });

  it('counts the tail past the limit rather than running on', () => {
    const many = Array.from({ length: STRAND_NAME_LIMIT + 3 }, (_, i) => `d${i}`);
    const out = formatNameList(many);
    expect(out).toContain('and 3 more');
    expect(out).not.toContain(`d${STRAND_NAME_LIMIT}`);
  });
});

describe('kindChangeAdvisory', () => {
  it('names the count and the datasets', () => {
    const said = kindChangeAdvisory({ state: 'known', names: ['orders', 'customers'] }, 'http');
    expect(said).toContain('strands 2 datasets');
    expect(said).toContain('orders, customers');
    expect(said).toContain('http');
  });

  it('reads singular for one', () => {
    expect(kindChangeAdvisory({ state: 'known', names: ['orders'] }, 'http')).toContain(
      'strands 1 dataset that reads it',
    );
  });

  it('is silent on an EARNED empty', () => {
    expect(kindChangeAdvisory({ state: 'known', names: [] }, 'http')).toBeNull();
  });

  // The two below are the point of the third state. A check that could not be
  // made must never render as the silent "nothing to strand" above.
  it('says the check is still running rather than claiming nothing', () => {
    const said = kindChangeAdvisory({ state: 'loading' }, 'http');
    expect(said).not.toBeNull();
    expect(said).toContain('Still checking');
  });

  it('says the check FAILED, and carries the reason', () => {
    const said = kindChangeAdvisory({ state: 'unavailable', detail: 'network down' }, 'http');
    expect(said).toContain('Could not check');
    expect(said).toContain('network down');
    expect(said).toContain('may strand');
  });
});

describe('deleteConfirmMessage', () => {
  it('is the bare question when nothing reads the connection', () => {
    expect(deleteConfirmMessage('store', { state: 'known', names: [] })).toBe(
      'Delete connection "store"?',
    );
  });

  it('names the stranded datasets and their number', () => {
    const said = deleteConfirmMessage('store', { state: 'known', names: ['orders', 'customers'] });
    expect(said).toContain('Delete connection "store"?');
    expect(said).toContain('2 datasets read it');
    expect(said).toContain('orders, customers');
  });

  it('reads singular for one', () => {
    expect(deleteConfirmMessage('store', { state: 'known', names: ['orders'] })).toContain(
      '1 dataset reads it',
    );
  });

  it('admits an unreadable list rather than asking the bare question', () => {
    // The failure that matters: an operator confirming a delete because the
    // dialog said nothing, when the dialog in fact knew nothing.
    const said = deleteConfirmMessage('store', { state: 'unavailable', detail: 'boom' });
    expect(said).not.toBe('Delete connection "store"?');
    expect(said).toContain('Could not check');
    expect(said).toContain('boom');
  });

  it('admits a list still in flight', () => {
    const said = deleteConfirmMessage('store', { state: 'loading' });
    expect(said).toContain('Still checking');
  });
});
