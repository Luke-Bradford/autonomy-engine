import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readExcelDatasetBatches } from '../excel-io.js';
import { buildXlsx } from './xlsx-fixtures.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';

let root = '';
beforeEach(async () => { root = await tempRoot('repro-root'); });
afterEach(async () => { await cleanupTempRoots(); });

describe('repro', () => {
  it('header:false with leading blank row', async () => {
    const path = join(root, 'b.xlsx');
    writeFileSync(path, buildXlsx({
      sheets: [{
        name: 'Sales',
        rows: [
          [{ kind: 'blank' }],
          [{ kind: 'number', value: 1 }, { kind: 'inline', text: 'alpha' }],
        ],
      }],
    }));
    const out: Record<string, unknown>[] = [];
    try {
      for await (const batch of readExcelDatasetBatches({
        connectionConfig: { roots: [root] },
        datasetKind: 'excel',
        datasetConfig: { path, header: false, sheet: 'Sales' },
      })) out.push(...batch);
      console.log('SUCCEEDED, rows:', JSON.stringify(out));
    } catch (err) {
      console.log('THREW:', err instanceof Error ? err.message : String(err));
    }
  });
});
