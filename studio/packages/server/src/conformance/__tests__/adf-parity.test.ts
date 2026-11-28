import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADF_PARITY, renderAdfParity } from '../adf-parity.js';
import { allCellIds } from '../cell-ids.js';

/**
 * #1574 OR39 — `studio/docs/adf-parity.md` is generated from `adf-parity.ts`,
 * and every row it calls supported links to something that runs.
 * `UPDATE_ADF_PARITY=1` rewrites the doc instead of comparing it.
 */

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../docs');
const DOC = resolve(DOCS, 'adf-parity.md');

describe('the ADF parity doc', () => {
  it('matches what the table renders', () => {
    const rendered = renderAdfParity();
    if (process.env['UPDATE_ADF_PARITY'] === '1') writeFileSync(DOC, rendered);
    expect(readFileSync(DOC, 'utf8')).toBe(rendered);
  });

  const rows = ADF_PARITY.flatMap((a) => a.rows.map((r) => ({ ...r, adf: a.adf })));

  it('links every supported row to at least one cell or suite', () => {
    const unproved = rows
      .filter((r) => r.status === 'supported')
      .filter((r) => (r.cells?.length ?? 0) + (r.tests?.length ?? 0) === 0);
    expect(unproved.map((r) => `${r.adf}: ${r.property}`)).toEqual([]);
  });

  it('says why for every row that differs or is not there yet', () => {
    const silent = rows.filter((r) => r.status !== 'supported' && (r.note ?? '') === '');
    expect(silent.map((r) => `${r.adf}: ${r.property}`)).toEqual([]);
  });

  it('names only cells the matrix runs and suites that exist', () => {
    const ids = allCellIds();
    const unknownCells = rows.flatMap((r) => r.cells ?? []).filter((id) => !ids.has(id));
    const missingSuites = rows
      .flatMap((r) => r.tests ?? [])
      .filter((path) => !existsSync(resolve(DOCS, path)));
    expect({ unknownCells, missingSuites }).toEqual({ unknownCells: [], missingSuites: [] });
  });
});
