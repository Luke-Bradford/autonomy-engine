import { describe, expect, it } from 'vitest';
import {
  DatasetAddressSchema,
  describeDatasetAddress,
  sameDatasetAddress,
  type DatasetAddress,
} from './address.js';

/**
 * #1149 M6 slice B — the physical-address predicate behind spec §3.1's
 * self-copy refusal.
 *
 * It is a DATA-LOSS guard, so both polarities are pinned: it must catch the
 * pair §4's atomic-swap sink would destroy, and it must not refuse a pair that
 * merely looks similar. Every case below is one of those two.
 */
function address(over: Partial<DatasetAddress> = {}): DatasetAddress {
  return {
    kind: 'sqlite',
    store: '/data/app.db',
    storeIdentity: '1:2',
    object: 'main.users',
    ...over,
  };
}

describe('sameDatasetAddress', () => {
  it('matches two addresses that name one physical object', () => {
    expect(sameDatasetAddress(address(), address())).toBe(true);
  });

  it('matches on IDENTITY across two spellings of one path — the case-alias defect', () => {
    // Measured on APFS: `resolveWithinRoots` canonicalises the parent and joins
    // the final component AS SPELLED, so `app.db` and `App.db` are two confined
    // strings for ONE inode. Compared on the path alone this pair walks through
    // the gate and the sink deletes the rows the source is streaming.
    expect(
      sameDatasetAddress(address({ store: '/data/app.db' }), address({ store: '/data/App.db' })),
    ).toBe(true);
  });

  it('refuses to match two DIFFERENT identities even when the paths agree', () => {
    // The other direction of the same rule: an identity that differs PROVES two
    // stores, so the path is not consulted as a fallback — that would re-admit
    // the alias defect from the opposite side.
    expect(
      sameDatasetAddress(address({ storeIdentity: '1:2' }), address({ storeIdentity: '1:3' })),
    ).toBe(false);
  });

  it('falls back to the path when either end could not be identified', () => {
    expect(sameDatasetAddress(address({ storeIdentity: null }), address())).toBe(true);
    expect(
      sameDatasetAddress(address({ storeIdentity: null }), address({ store: '/data/other.db' })),
    ).toBe(false);
  });

  it('does not match two different objects in one store', () => {
    // The LEGITIMATE shape §3.1 ① mandates: one file reached through a
    // read-only and a writable connection needs two dataset rows, and copying
    // between two of its tables must keep working.
    expect(
      sameDatasetAddress(address({ object: 'main.src' }), address({ object: 'main.dst' })),
    ).toBe(false);
  });

  it('does not match across store kinds', () => {
    expect(sameDatasetAddress(address(), address({ kind: 'fs' }))).toBe(false);
  });

  it('never matches a null object, not even against another null', () => {
    // A `query` names no single object. "Unknown" must not be spelled "equal":
    // a permanent refusal of work that would have succeeded is the one
    // direction this gate may never fail in.
    expect(sameDatasetAddress(address({ object: null }), address())).toBe(false);
    expect(sameDatasetAddress(address({ object: null }), address({ object: null }))).toBe(false);
  });
});

describe('DatasetAddressSchema', () => {
  it('accepts a null identity and a null object, and rejects empty strings', () => {
    expect(
      DatasetAddressSchema.parse({
        kind: 'sqlite',
        store: '/data/app.db',
        storeIdentity: null,
        object: null,
      }),
    ).toEqual({ kind: 'sqlite', store: '/data/app.db', storeIdentity: null, object: null });
    expect(DatasetAddressSchema.safeParse({ ...address(), store: '' }).success).toBe(false);
    expect(DatasetAddressSchema.safeParse({ ...address(), kind: 'nope' }).success).toBe(false);
  });
});

describe('describeDatasetAddress', () => {
  it('names the object when there is one, and the store alone when there is not', () => {
    expect(describeDatasetAddress(address())).toBe("'/data/app.db' → 'main.users'");
    expect(describeDatasetAddress(address({ object: null }))).toBe("'/data/app.db'");

    /**
     * #1162 — an address whose object IS its store reads ONCE.
     *
     * Not a special case invented for the display: `resolveDelimitedDatasetAddress`
     * deliberately sets `object` to the same confined path as `store`, and its
     * docblock rejects both alternatives (directory-as-store reopens the
     * case-alias hole; a constant `object` asserts a fact nobody established).
     * The consequence lands here, where `'…/people.csv' → '…/people.csv'` reads
     * as a rendering fault rather than as one file. Comparison is untouched —
     * `sameDatasetAddress` still reads both halves.
     */
    expect(
      describeDatasetAddress(address({ store: '/d/people.csv', object: '/d/people.csv' })),
    ).toBe("'/d/people.csv'");
  });
});
