import { describe, expect, it } from 'vitest';
import { CONNECTION_KIND_GROUPS, ConnectionKindSchema } from '../connection.js';

describe('CONNECTION_KIND_GROUPS (#1477)', () => {
  it('puts every connection kind in exactly one group', () => {
    const grouped = CONNECTION_KIND_GROUPS.flatMap((g) => g.kinds);
    expect([...grouped].sort()).toEqual([...ConnectionKindSchema.options].sort());
  });

  it('has no empty group and unique keys, in the gallery order', () => {
    expect(CONNECTION_KIND_GROUPS.every((g) => g.kinds.length > 0)).toBe(true);
    expect(CONNECTION_KIND_GROUPS.map((g) => g.key)).toEqual(['database', 'file', 'http', 'ai']);
  });
});
