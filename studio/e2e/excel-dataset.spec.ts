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
    // `path` and `header` carry no "(optional)" suffix and the other four do,
    // which is not cosmetic — `ConfigFieldControl` derives that suffix from the
    // SCHEMA, so this asserts the two REQUIRED keys of §2.6's excel row really
    // did ship required. `header` is the M7 correction this row inherited, and
    // a defaulted one could not be set to `false` distinguishably from unset.
    for (const field of ['path', 'header']) {
      await expect(form(page).getByLabel(field, { exact: true })).toBeVisible();
    }
    // The five optional ones, each by its FULL accessible name. `sheetIndex`
    // and `headerRow` carry the ` — number` suffix `ConfigFieldControl` appends
    // to a numeric control, which is itself worth pinning: those two derived as
    // NUMBER controls rather than degrading to a JSON box, which is what §13's
    // trap would have produced from a `z.union` spelling of one sheet key.
    for (const field of [
      'sheet (optional)',
      'sheetIndex (optional) — number',
      'headerRow (optional) — number',
      'nullValue (optional)',
      'dateFormat (optional)',
    ]) {
      await expect(form(page).getByLabel(field, { exact: true })).toBeVisible();
    }
    // …and no reader complaint, because M11 gave the last kind a reader.
    await expect(form(page).getByText(/no reader exists/)).toBeHidden();

    await form(page).getByLabel('Name').fill('#1215 people.xlsx');
    await form(page).getByLabel('path', { exact: true }).fill(bookPath);
    await form(page).getByLabel('sheet (optional)', { exact: true }).fill('People');
    await form(page).getByLabel('header', { exact: true }).check();
    await form(page).getByLabel('headerRow (optional) — number', { exact: true }).fill('3');
    // REQUIRED by the form, and deliberately so: `[]` is a claim about the
    // store and never a stand-in for "not described yet".
    await form(page)
      .getByLabel('Columns (JSON)')
      .fill(
        '[{"name":"id","type":"integer","nullable":false},{"name":"name","type":"string","nullable":true}]',
      );
    await page.getByRole('button', { name: 'Create dataset' }).click();

    // READ BACK through the API, which is what proves those controls wrote the
    // KEYS and not merely some JSON. `sheetIndex` was left blank and must be
    // ABSENT rather than present-and-empty: the schema refuses both keys at
    // once, so an empty string smuggled through would make every dispatch fail.
    await expect(page.getByText('#1215 people.xlsx')).toBeVisible();
    // The route is PAGED (`DatasetPageSchema`), so the rows are under `items`.
    const listed = (await (await page.request.get('/api/datasets')).json()) as {
      items: { name: string; kind: string; config: Record<string, unknown> }[];
    };
    const authored = listed.items.find((d) => d.name === '#1215 people.xlsx');
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

/**
 * #1218 — the `sheet` field stops being typed blind.
 *
 * What only a real browser plus a real server can prove, and neither unit suite
 * reaches: the names in the chooser came out of an ACTUAL workbook on disk,
 * through `POST /api/datasets/sheets`, confined against the connection's own
 * roots. `DatasetsPage.test.tsx` drives the panel against a mocked client, so
 * it cannot tell a working route from a well-shaped fake; `xlsx-sheets.test.ts`
 * reads real files but never renders anything.
 *
 * The refusal arm is here for the same reason. A file that does not exist is
 * the ORDINARY authoring state (the ticket's real degrade case), and the whole
 * design rests on it arriving as a 200 the form can render rather than an error
 * the form has to special-case — which is a claim about the wire, not about a
 * component.
 */
test('#1218 — the excel sheet chooser offers what the workbook actually holds', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1218-')));
  try {
    const bookPath = join(root, 'people.xlsx');
    writeFileSync(bookPath, workbook());

    const fsConnection = await seedConnection(page, {
      name: '#1218 workbook store',
      kind: 'fs',
      config: { roots: [root] },
    });

    await page.goto('/#/manage/datasets');
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    await form(page).getByLabel('Store').selectOption(fsConnection);
    await form(page).getByLabel('Kind').selectOption('excel');

    // ── 1. NOTHING IS OFFERED UNTIL IT IS ASKED FOR ─────────────────────────
    // The listing is on a button, not on every keystroke: each call opens a real
    // container behind a real descriptor, and `useGuardedLoad` drops results
    // rather than cancelling requests, so a fetch-as-you-type would spend the
    // work and merely hide it.
    await expect(form(page).getByLabel('Sheet in this workbook')).toBeHidden();
    // The free-text box exists from the start and never goes away.
    await expect(form(page).getByLabel('sheet (optional)', { exact: true })).toBeVisible();

    // ── 2. A REFUSAL IS AN ANSWER, NOT AN ERROR ─────────────────────────────
    await form(page).getByLabel('path', { exact: true }).fill(join(root, 'not-written-yet.xlsx'));
    await form(page).getByRole('button', { name: 'List sheets' }).click();
    // 200 + `{ ok: false }`, rendered as `role="status"`. If this route ever
    // 500s on ENOENT — the shape it had before `openConfinedFd` was wrapped —
    // this arm is what says so.
    await expect(form(page).getByRole('status')).toContainText(/could not be opened/);
    await expect(form(page).getByLabel('Sheet in this workbook')).toBeHidden();

    // ── 3. THE REAL WORKBOOK ────────────────────────────────────────────────
    await form(page).getByLabel('path', { exact: true }).fill(bookPath);
    // A `sheetIndex` typed FIRST, because that is the trap: the schema refuses a
    // config naming both `sheet` and `sheetIndex`, so a chooser that wrote only
    // `sheet` would make itself the cause of the refusal on Save.
    await form(page).getByLabel('sheetIndex (optional) — number', { exact: true }).fill('2');
    await form(page).getByRole('button', { name: 'List sheets' }).click();

    const chooser = form(page).getByLabel('Sheet in this workbook');
    await expect(chooser).toBeVisible();
    // Both names, in WORKBOOK ORDER — index N of the list is `sheetIndex` N+1,
    // so a reordering would silently re-point the other way of naming a sheet.
    await expect(chooser.locator('option')).toHaveText(['— choose —', 'People', 'Costs']);

    // ── 4. CHOOSING WRITES ONE FIELD AND CLEARS THE OTHER ───────────────────
    await chooser.selectOption('Costs');
    await expect(form(page).getByLabel('sheet (optional)', { exact: true })).toHaveValue('Costs');
    await expect(
      form(page).getByLabel('sheetIndex (optional) — number', { exact: true }),
    ).toHaveValue('');

    // ── 5. A LISTING STOPS BEING OFFERED WHEN ITS DRAFT MOVES ───────────────
    // The names belong to the workbook that WAS named. Offering them against a
    // different path would invite a choice that refuses at dispatch.
    await form(page).getByLabel('path', { exact: true }).fill(join(root, 'somewhere-else.xlsx'));
    await expect(form(page).getByLabel('Sheet in this workbook')).toBeHidden();
    // …and the box the operator can always fall back to is still there, still
    // holding what they chose.
    await expect(form(page).getByLabel('sheet (optional)', { exact: true })).toHaveValue('Costs');

    await expectQuiet(page, problems);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
