import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';
import { seedConnection, seedDataset } from './support/seedResources';

/**
 * #1600 OR41 C3a — Copy's Write behaviour (catalogue §4.1): Upsert with Key
 * columns, authored in the Sink tab and run for real against a SQLite file.
 * Run twice, the copy updates the matched rows and adds none.
 */
test.describe('#1600 C3a — Copy Write behaviour', () => {
  test('Upsert with Key columns, authored in the Sink tab, updates matched rows and a rerun adds none', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    // `realpathSync`: macOS `/var` is a symlink, and roots compare REAL paths.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c3a-')));
    try {
      const dbPath = join(root, 'crm.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, name TEXT);
        INSERT INTO incoming VALUES (2, 'Bea'), (3, 'Cal');
        CREATE TABLE customers (id INTEGER, name TEXT);
        INSERT INTO customers VALUES (1, 'Ann'), (2, 'Bee');
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c3a crm',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c3a customers',
        kind: 'table',
        connectionId: conn,
        config: { table: 'customers' },
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'name', type: 'string', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c3a upsert', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy',
            config: {
              mapping: [
                { source: 'id', sink: 'id', type: 'integer' },
                { source: 'name', sink: 'name', type: 'string' },
              ],
              mode: 'append',
            },
            connectionIds: { source: conn, sink: conn },
            datasetIds: { sink },
            inlineDatasets: { source: { kind: 'table', config: { table: 'incoming' } } },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });

      await nodeById(page, 'copy1').click();
      const pane = properties(page);
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      const behaviour = pane.getByRole('combobox', { name: 'Write behaviour' });
      // The empty choice writes nothing, which reads as the default, Append.
      await expect(behaviour.locator('option')).toHaveText([
        'Append (default)',
        'Append',
        'Overwrite',
        'Truncate then insert',
        'Upsert',
      ]);
      const keys = pane.getByRole('textbox', { name: 'Key columns' });
      // Key columns are read only by Upsert, so the other behaviours hide them.
      await expect(keys).toHaveCount(0);
      await behaviour.selectOption('upsert');
      await expect(keys).toBeVisible();
      // The whole Sink tab fits the dock at 1440x900, Key columns included.
      const box = await keys.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      await keys.fill('id');
      await pane.getByRole('button', { name: 'Apply config' }).click();
      await expect(nodeById(page, 'copy1')).toContainText('· upsert on id');

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({ mode: 'upsert', keyColumns: ['id'] });

      const customers = () => {
        const back = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return back.prepare('SELECT id, name FROM customers ORDER BY id').all();
        } finally {
          back.close();
        }
      };
      const runOk = async (label: string) => {
        const runId = await fireAndSettle(page, latest.id, label);
        const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
        expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      };
      const expected = [
        { id: 1, name: 'Ann' },
        { id: 2, name: 'Bea' },
        { id: 3, name: 'Cal' },
      ];
      await runOk('e2e 1600 c3a first');
      expect(customers()).toEqual(expected);
      await runOk('e2e 1600 c3a second');
      expect(customers()).toEqual(expected);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * #1600 OR41 C3b — Pre-copy script and Batch size (catalogue §4.1), authored
   * in the Sink tab and run for real: the script deletes the rows from :from up
   * inside the copy's transaction, then the copy appends the incoming rows.
   */
  test('a Pre-copy script with a bind value runs before the rows, and Batch size is saved', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c3b-')));
    try {
      const dbPath = join(root, 'crm.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, name TEXT);
        INSERT INTO incoming VALUES (2, 'Bea'), (3, 'Cal'), (4, 'Dee');
        CREATE TABLE customers (id INTEGER, name TEXT);
        INSERT INTO customers VALUES (1, 'Ann'), (2, 'Bee'), (3, 'Coe');
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c3b crm',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c3b customers',
        kind: 'table',
        connectionId: conn,
        config: { table: 'customers' },
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'name', type: 'string', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c3b pre-copy', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy',
            config: {
              mapping: [
                { source: 'id', sink: 'id', type: 'integer' },
                { source: 'name', sink: 'name', type: 'string' },
              ],
            },
            connectionIds: { source: conn, sink: conn },
            datasetIds: { sink },
            inlineDatasets: { source: { kind: 'table', config: { table: 'incoming' } } },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });

      await nodeById(page, 'copy1').click();
      const pane = properties(page);
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      const script = pane.getByRole('textbox', { name: 'Pre-copy script', exact: true });
      const addBind = pane.getByRole('button', {
        name: 'Add pre-copy bind values row',
        exact: true,
      });
      // Bind values only mean something beside a script, so they show once it has one.
      await expect(addBind).toHaveCount(0);
      await script.fill('DELETE FROM customers WHERE id >= :from');
      await expect(addBind).toBeVisible();
      // The statement is literal (§8): no reference flyout on it, one on a bind value.
      await expect(
        pane.getByRole('button', { name: /^Insert reference into pre-copy script$/i }),
      ).toHaveCount(0);
      await addBind.click();
      await pane
        .getByRole('textbox', { name: 'Pre-copy bind values row 1 key', exact: true })
        .fill('from');
      await pane
        .getByRole('textbox', { name: 'Pre-copy bind values row 1 value', exact: true })
        .fill('2');
      await expect(
        pane.getByRole('button', {
          name: 'Insert reference into pre-copy bind values row 1 value',
          exact: true,
        }),
      ).toBeVisible();
      // The fresh Sink tab fitting whole at 1440x900 is activity-tabs.spec's gate.
      await pane.getByRole('textbox', { name: /^Batch size/ }).fill('2');
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({
        preCopyScript: 'DELETE FROM customers WHERE id >= :from',
        preCopyScriptParameters: { from: '2' },
        writeBatchSize: 2,
      });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c3b run');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      const back = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(back.prepare('SELECT id, name FROM customers ORDER BY id').all()).toEqual([
          { id: 1, name: 'Ann' },
          { id: 2, name: 'Bea' },
          { id: 3, name: 'Cal' },
          { id: 4, name: 'Dee' },
        ]);
      } finally {
        back.close();
      }

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * #1600 OR41 C3c — Table option *Auto-create from mapping* (catalogue §4.1),
   * picked in the Sink tab and run for real: the sink table does not exist, so
   * the copy creates it from the mapping's sink names and types, then writes.
   */
  test('Auto-create from mapping creates the missing sink table and copies into it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c3c-')));
    try {
      const dbPath = join(root, 'crm.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, name TEXT);
        INSERT INTO incoming VALUES (1, 'Ann'), (2, 'Bea');
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c3c crm',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c3c people',
        kind: 'table',
        connectionId: conn,
        config: { table: 'people' },
        columns: [],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c3c auto-create', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy',
            config: {
              mapping: [
                { source: 'id', sink: 'person_id', type: 'integer' },
                { source: 'name', sink: 'full_name', type: 'string' },
              ],
            },
            connectionIds: { source: conn, sink: conn },
            datasetIds: { sink },
            inlineDatasets: { source: { kind: 'table', config: { table: 'incoming' } } },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });

      await nodeById(page, 'copy1').click();
      const pane = properties(page);
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      const option = pane.getByRole('combobox', { name: 'Table option' });
      await expect(option.locator('option')).toHaveText([
        'Use existing (default)',
        'Use existing',
        'Auto-create from mapping',
      ]);
      // ADF's order: the Table option comes before Write behaviour.
      const optionBox = await option.boundingBox();
      const behaviourBox = await pane
        .getByRole('combobox', { name: 'Write behaviour' })
        .boundingBox();
      expect(optionBox!.y).toBeLessThan(behaviourBox!.y);
      await option.selectOption('autoCreate');
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({ tableOption: 'autoCreate' });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c3c run');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      const back = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          back.prepare("SELECT name, type FROM pragma_table_info('people') ORDER BY cid").all(),
        ).toEqual([
          { name: 'person_id', type: 'INTEGER' },
          { name: 'full_name', type: 'TEXT' },
        ]);
        expect(
          back.prepare('SELECT person_id, full_name FROM people ORDER BY person_id').all(),
        ).toEqual([
          { person_id: 1, full_name: 'Ann' },
          { person_id: 2, full_name: 'Bea' },
        ]);
      } finally {
        back.close();
      }

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
