import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import { buildXlsx } from '../packages/server/src/connectors/__tests__/xlsx-fixtures';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #996 M11 slice 2 (#1215) — the `excel` dataset kind, end to end.
 *
 * TWO things only a real browser plus a real server can prove, and neither unit
 * suite reaches either:
 *
 * 1. The controls the Datasets form derives from `excelDatasetConfigSchema` are
 *    REAL INPUTS IN THE SHIPPED BUNDLE, and filling them writes exactly those
 *    keys through `POST /api/datasets` and reads them back. A stale or
 *    mis-bundled `@autonomy-studio/shared` is precisely what that breaks — and
 *    §13's named trap makes it worth asserting rather than assuming: any schema
 *    root `configForm.ts` cannot classify degrades to a JSON textarea, which is
 *    the failure mode the `sheet`/`sheetIndex` split exists partly to avoid.
 * 2. A real `.xlsx` copies into a real SQLite table through the SERVER's own
 *    dispatch, which is the first time `fs.ts`'s reader fork is exercised by
 *    the shipped build rather than by a test calling the adapter directly.
 *
 * The workbook is built BYTE BY BYTE with slice 1's own fixture writer rather
 * than committed as a binary blob, for that module's stated reasons — and
 * sharing it (instead of copying it here) is what stops the e2e's idea of a
 * workbook drifting from the reader suite's. `outcome-ports.spec.ts` already
 * imports across a package boundary; this adds a `__tests__` directory to that,
 * which is sound because the module imports nothing but `node:zlib`.
 *
 * EGRESS-FREE. `node:sqlite` rather than `better-sqlite3` on
 * `copy-resolved-address.spec.ts`'s reasoning: the sink table must exist before
 * the copy (there is no DDL activity, by design) and `better-sqlite3` does not
 * resolve from the workspace root under pnpm.
 *
 * `realpathSync` on the temp root is load-bearing, not tidiness — on macOS
 * `/var` is a symlink to `/private/var`, and `resolveWithinRoots` compares REAL
 * paths, so an unresolved root never contains its own files and every dispatch
 * would refuse.
 */

const form = (page: Page) => page.getByRole('form', { name: 'Dataset form' });

/** A workbook with a title row ABOVE its header — the shape a CSV never has,
 * and the reason `headerRow` exists as a key at all. */
function workbook(): Buffer {
  return buildXlsx({
    sheets: [
      {
        name: 'People',
        rows: [
          [{ kind: 'inline', text: 'Q3 export — do not edit' }],
          [],
          [
            { kind: 'inline', text: 'id' },
            { kind: 'inline', text: 'name' },
          ],
          [
            { kind: 'number', value: 1 },
            { kind: 'inline', text: 'alpha' },
          ],
          [
            { kind: 'number', value: 2 },
            { kind: 'inline', text: 'beta' },
          ],
        ],
      },
      { name: 'Costs', rows: [[{ kind: 'inline', text: 'unused' }]] },
    ],
  });
}

test('#1215 — an excel dataset authors through derived controls, and copies into SQLite', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1215-')));
  try {
    const bookPath = join(root, 'people.xlsx');
    writeFileSync(bookPath, workbook());
    const dbPath = join(root, 'warehouse.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE people (id INTEGER, name TEXT)');
    db.close();

    const fsConnection = await seedConnection(page, {
      name: '#1215 workbook store',
      kind: 'fs',
      config: { roots: [root] },
    });
    const sqliteConnection = await seedConnection(page, {
      name: '#1215 warehouse',
      kind: 'sqlite',
      config: { roots: [root], path: dbPath, writable: true },
    });

    // ── 1. THE FORM ─────────────────────────────────────────────────────────
    await page.goto('/#/manage/datasets');
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    await form(page).getByLabel('Store').selectOption(fsConnection);
    await form(page).getByLabel('Kind').selectOption('excel');

    // DERIVED CONTROLS, not a JSON textarea — the assertion §13's trap makes
    // worth making. Every key of §2.6's excel row is a real input.
    await expect(form(page).getByLabel('Config (JSON)')).toBeHidden();
    for (const field of ['path', 'sheet', 'sheetIndex', 'headerRow', 'nullValue', 'dateFormat']) {
      await expect(form(page).getByLabel(field, { exact: true })).toBeVisible();
    }
    // `header` is a REQUIRED boolean, so it renders as a checkbox rather than an
    // absentable one — the M7 correction this row inherited.
    await expect(form(page).getByLabel('header', { exact: true })).toBeVisible();
    // …and no reader complaint, because M11 gave the last kind a reader.
    await expect(form(page).getByText(/no reader exists/)).toBeHidden();

    await form(page).getByLabel('Name').fill('#1215 people.xlsx');
    await form(page).getByLabel('path', { exact: true }).fill(bookPath);
    await form(page).getByLabel('sheet', { exact: true }).fill('People');
    await form(page).getByLabel('header', { exact: true }).check();
    await form(page).getByLabel('headerRow', { exact: true }).fill('3');
    await page.getByRole('button', { name: 'Create dataset' }).click();

    // READ BACK through the API, which is what proves those controls wrote the
    // KEYS and not merely some JSON. `sheetIndex` was left blank and must be
    // ABSENT rather than present-and-empty: the schema refuses both keys at
    // once, so an empty string smuggled through would make every dispatch fail.
    await expect(page.getByText('#1215 people.xlsx')).toBeVisible();
    const listed = (await (await page.request.get('/api/datasets')).json()) as {
      name: string;
      kind: string;
      config: Record<string, unknown>;
    }[];
    const authored = listed.find((d) => d.name === '#1215 people.xlsx');
    expect(authored?.kind).toBe('excel');
    expect(authored?.config).toEqual({
      path: bookPath,
      sheet: 'People',
      header: true,
      headerRow: 3,
    });

    // ── 2. THE COPY ─────────────────────────────────────────────────────────
    const sourceDataset = await seedDataset(page, {
      name: '#1215 people sheet',
      kind: 'excel',
      connectionId: fsConnection,
      config: { path: bookPath, sheet: 'People', header: true, headerRow: 3 },
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: true },
      ],
    });
    const sinkDataset = await seedDataset(page, {
      name: '#1215 people table',
      kind: 'table',
      connectionId: sqliteConnection,
      config: { table: 'people' },
      columns: [
        { name: 'id', type: 'integer', nullable: true },
        { name: 'name', type: 'string', nullable: true },
      ],
    });

    const { pipelineVersionId } = await seedVersion(page, '#1215 excel copy', {
      nodes: [
        {
          id: 'copy1',
          type: 'copy',
          position: { x: 0, y: 0 },
          connectionIds: { source: fsConnection, sink: sqliteConnection },
          datasetIds: { source: sourceDataset, sink: sinkDataset },
          config: {
            mapping: [
              { source: 'id', sink: 'id', type: 'integer' },
              { source: 'name', sink: 'name', type: 'string' },
            ],
            mode: 'append',
          },
        },
      ],
    });
    const runId = await fireAndSettle(page, pipelineVersionId, '#1215 excel copy');

    const run = await (await page.request.get(`/api/runs/${runId}`)).json();
    expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');

    // THE ROWS, read back out of the real database. Two of them and not five:
    // the title row and the blank row above `headerRow` are skipped, and the
    // header row is consumed rather than copied. A fork that had handed this
    // workbook to the CSV reader could not have produced this at all.
    const back = new DatabaseSync(dbPath, { readOnly: true });
    expect(back.prepare('SELECT id, name FROM people ORDER BY id').all()).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
    back.close();

    await expectQuiet(page, problems);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
