import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, nodeById, openSeededCanvas } from './support/seedDoc';
import { problemsToggle, properties } from './support/panels';
import { seedConnection, seedDataset } from './support/seedResources';

/**
 * #1600 OR41 C1q — a Copy or Lookup whose SOURCE is an inline Table or Query
 * (`Node.inlineDatasets`), read straight from the bound database connection.
 *
 * C1q-a seeded it through the API and showed it read-only; C1q-b makes the Source
 * tab's *Use* Saved dataset · Table · Query block edit it. The second test is
 * the ticket's acceptance, the watermark journey, with the Copy's query AUTHORED
 * in the dock and then run for real against a SQLite file.
 */

const sourceTab = (page: Page) =>
  properties(page).getByRole('tab', { name: 'Source', exact: true });

test.describe('#1600 C1q — an inline database source', () => {
  test('a seeded inline query opens as Use Query, its statement and bind value editable, with no problem raised', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const conn = await seedConnection(page, {
      name: 'e2e 1600 c1q store',
      kind: 'sqlite',
      config: { path: 'e2e-1600-c1q.db', writable: true },
    });
    const sink = await seedDataset(page, {
      name: 'e2e 1600 c1q stage',
      kind: 'table',
      connectionId: conn,
      config: { table: 'stage' },
      columns: [{ name: 'id', type: 'integer', nullable: true }],
    });
    const sql = 'SELECT id FROM orders WHERE modified_at > :wm';
    const pipelineId = await openSeededCanvas(page, 'e2e 1600 c1q inline', {
      params: [{ name: 'wm', type: 'string', required: true }],
      nodes: [
        {
          id: 'copy1',
          type: 'copy',
          config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }], mode: 'append' },
          connectionIds: { source: conn, sink: conn },
          datasetIds: { sink },
          inlineDatasets: {
            source: { kind: 'query', config: { sql, parameters: { wm: '${params.wm}' } } },
          },
          position: { x: 0, y: 0 },
        },
      ],
    });

    const card = nodeById(page, 'copy1');
    await expect(card).toContainText('query');
    await expect(card).toContainText('e2e 1600 c1q stage');

    await card.click();
    await sourceTab(page).click();
    const pane = properties(page);
    await expect(pane.getByRole('combobox', { name: 'Use' })).toHaveValue('query');
    await expect(pane.getByRole('textbox', { name: 'SQL statement' })).toHaveValue(sql);
    await expect(pane.getByRole('textbox', { name: 'Bind value 1 name' })).toHaveValue('wm');
    await expect(pane.getByRole('textbox', { name: 'Bind value 1 value' })).toHaveValue(
      '${params.wm}',
    );
    // An inline source stands in for the saved picker.
    await expect(pane.getByRole('combobox', { name: 'Source dataset' })).toHaveCount(0);
    // The statement is literal: no ⓕ beside it, and its ⤢ editor has no reference list.
    await expect(
      pane.getByRole('button', { name: 'Insert reference into SQL statement' }),
    ).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Insert reference into :wm' })).toHaveCount(1);
    await pane.getByRole('button', { name: 'Open SQL statement in the editor' }).click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByRole('textbox')).toHaveValue(sql);
    await expect(editor.getByRole('button', { name: /^Insert reference/ })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toHaveCount(0);

    // C1q-c — Query timeout: a query stored without one has none (nothing is
    // applied on upgrade), and the box is number-sized at 1440x900.
    const timeout = pane.getByRole('textbox', { name: 'Query timeout (seconds)', exact: true });
    await expect(timeout).toHaveValue('');
    await expect(timeout).toHaveAttribute('placeholder', 'none');
    await page.setViewportSize({ width: 1440, height: 900 });
    const timeoutBox = (await timeout.boundingBox())!;
    expect(timeoutBox.width).toBeLessThanOrEqual(140);
    expect(timeoutBox.height).toBeLessThanOrEqual(28);
    // A value the save would refuse is refused at the field, on blur, and kept on screen.
    await timeout.fill('0');
    await timeout.blur();
    await expect(
      pane.getByText('Enter a whole number of seconds above 0, or leave it blank'),
    ).toBeVisible();
    await timeout.fill('90');
    await timeout.blur();
    await expect(
      pane.getByText('Enter a whole number of seconds above 0, or leave it blank'),
    ).toHaveCount(0);

    // The canvas validates with the same `validateDoc` the server ran: nothing to report.
    await expect(problemsToggle(page)).not.toHaveText(/[1-9]/);

    // Committed to the node, not only drawn: the saved version carries it, a number.
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    const versions = (await (
      await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
    ).json()) as { version: number; nodes: Record<string, unknown>[] }[];
    const latest = versions.sort((a, b) => b.version - a.version)[0]!;
    const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
    expect(copy['inlineDatasets']).toEqual({
      source: {
        kind: 'query',
        config: { sql, parameters: { wm: '${params.wm}' }, queryTimeoutSeconds: 90 },
      },
    });
    await expectQuiet(page, problems);
  });

  test('the watermark journey: a Lookup reads the watermark, the Copy query authored in the dock binds it, and only newer rows land', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    // `realpathSync`: macOS `/var` is a symlink, and roots compare REAL paths.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c1qb-')));
    try {
      const dbPath = join(root, 'warehouse.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE etl_control (name TEXT, last_wm INTEGER);
        INSERT INTO etl_control VALUES ('orders', 100);
        CREATE TABLE orders (id INTEGER, modified_at INTEGER);
        INSERT INTO orders VALUES (1, 50), (2, 150), (3, 200);
        CREATE TABLE stage (id INTEGER);
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c1qb warehouse',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c1qb stage',
        kind: 'table',
        connectionId: conn,
        config: { table: 'stage' },
        columns: [{ name: 'id', type: 'integer', nullable: true }],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c1qb watermark', {
        nodes: [
          {
            id: 'lookup1',
            type: 'lookup',
            config: {},
            connectionId: conn,
            inlineDatasets: {
              source: {
                kind: 'query',
                config: {
                  sql: 'SELECT last_wm FROM etl_control WHERE name = :n',
                  parameters: { n: 'orders' },
                },
              },
            },
            position: { x: 0, y: 0 },
          },
          {
            id: 'copy1',
            type: 'copy',
            config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }], mode: 'append' },
            connectionIds: { source: conn, sink: conn },
            datasetIds: { sink },
            // The whole table to start with; the author narrows it below.
            inlineDatasets: { source: { kind: 'table', config: { table: 'orders' } } },
            position: { x: 320, y: 0 },
          },
        ],
        edges: [{ from: 'lookup1', to: 'copy1', on: 'success' }],
      });

      await nodeById(page, 'copy1').click();
      await sourceTab(page).click();
      const pane = properties(page);
      const use = pane.getByRole('combobox', { name: 'Use' });
      await expect(use).toHaveValue('table');
      const tableBox = pane.getByRole('textbox', { name: 'Table' });
      await expect(tableBox).toHaveValue('orders');

      // C1q-c — Table [▾ from the connection]: the store's own tables, read on
      // demand, and a choice writes the Table field.
      await pane.getByRole('button', { name: 'List tables' }).click();
      const listed = pane.getByRole('combobox', { name: 'Table in this connection' });
      await expect(listed.locator('option')).toHaveText([
        '— choose —',
        'etl_control',
        'orders',
        'stage',
      ]);
      await expect(listed.locator('option:checked')).toHaveText('orders');
      await listed.selectOption({ label: 'etl_control' });
      await expect(tableBox).toHaveValue('etl_control');
      await listed.selectOption({ label: 'orders' });
      await expect(tableBox).toHaveValue('orders');

      // C1q-c — Preview data reads the table through the run's own Lookup read.
      const previewRows = pane.getByRole('table', { name: 'Preview rows' });
      const firstColumn = () => previewRows.locator('tbody tr td:first-child').allTextContents();
      await pane.getByRole('button', { name: 'Preview data' }).click();
      await expect(pane.getByText('3 rows', { exact: true })).toBeVisible();
      await expect(previewRows.locator('thead th')).toHaveText(['id', 'modified_at']);
      expect(await firstColumn()).toEqual(['1', '2', '3']);

      await use.selectOption('query');
      // A result belongs to the source it was read for: changing it clears the table.
      await expect(previewRows).toHaveCount(0);
      // C1q-c — a new Query starts at ADF's two-hour query timeout.
      await expect(
        pane.getByRole('textbox', { name: 'Query timeout (seconds)', exact: true }),
      ).toHaveValue('7200');
      await pane
        .getByRole('textbox', { name: 'SQL statement' })
        .fill('SELECT id FROM orders WHERE modified_at > :wm');
      await pane.getByRole('button', { name: 'Add bind value' }).click();
      const name = pane.getByRole('textbox', { name: 'Bind value 1 name' });
      await expect(name).toHaveValue('p1');
      // A leading colon is refused at the row, not stored as a key that never binds.
      await name.fill(':wm');
      await expect(pane.getByText('Leave out the leading :.')).toBeVisible();
      await name.fill('wm');
      await expect(pane.getByText('Leave out the leading :.')).toHaveCount(0);
      await pane
        .getByRole('textbox', { name: 'Bind value 1 value' })
        .fill('${nodes.lookup1.output.rows[0].last_wm}');
      await expect(problemsToggle(page)).not.toHaveText(/[1-9]/);

      // :wm is an expression only a run resolves, so Preview asks for its value
      // and binds it as the run would (a number, against an INTEGER column).
      await pane.getByRole('textbox', { name: 'Preview value for :wm' }).fill('100');
      await pane.getByRole('button', { name: 'Preview data' }).click();
      await expect(pane.getByText('2 rows', { exact: true })).toBeVisible();
      expect(await firstColumn()).toEqual(['2', '3']);
      // Held to its scroll box, so the rows never push the dock's other fields away.
      const box = await pane.locator('.source-preview-rows').boundingBox();
      expect(box!.height).toBeLessThanOrEqual(320);

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['inlineDatasets']).toEqual({
        source: {
          kind: 'query',
          config: {
            sql: 'SELECT id FROM orders WHERE modified_at > :wm',
            queryTimeoutSeconds: 7200,
            parameters: { wm: '${nodes.lookup1.output.rows[0].last_wm}' },
          },
        },
      });
      expect(copy['datasetIds']).toEqual({ sink });

      const staged = () => {
        const back = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return back.prepare('SELECT id FROM stage ORDER BY id').all();
        } finally {
          back.close();
        }
      };
      const runOk = async (label: string) => {
        const runId = await fireAndSettle(page, latest.id, label);
        const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
        expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      };

      // Only the rows modified after the watermark (100) land.
      await runOk('e2e 1600 c1qb first');
      expect(staged()).toEqual([{ id: 2 }, { id: 3 }]);

      // A raised watermark copies none.
      const control = new DatabaseSync(dbPath);
      control.exec("UPDATE etl_control SET last_wm = 300 WHERE name = 'orders'");
      control.close();
      await runOk('e2e 1600 c1qb second');
      expect(staged()).toEqual([{ id: 2 }, { id: 3 }]);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bind values from the statement: Import adds the unbound :names in one step, a stale one says so, and each row has a type', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const conn = await seedConnection(page, {
      name: 'e2e 1600 c1q-c binds store',
      kind: 'sqlite',
      config: { path: 'e2e-1600-c1q-c.db', writable: true },
    });
    const sink = await seedDataset(page, {
      name: 'e2e 1600 c1q-c binds stage',
      kind: 'table',
      connectionId: conn,
      config: { table: 'stage' },
      columns: [{ name: 'id', type: 'integer', nullable: true }],
    });
    // `@b` is sqlite's own spelling of the same bind name; the comment's `:q` is not one.
    const sql = 'SELECT id FROM orders WHERE a = :a AND b = @b AND c > :c -- :q';
    const pipelineId = await openSeededCanvas(page, 'e2e 1600 c1q-c binds', {
      params: [{ name: 'wm', type: 'string', required: true }],
      nodes: [
        {
          id: 'copy1',
          type: 'copy',
          config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }], mode: 'append' },
          connectionIds: { source: conn, sink: conn },
          datasetIds: { sink },
          inlineDatasets: {
            source: {
              kind: 'query',
              config: { sql, parameters: { a: 'x', z: '${params.wm}' }, queryTimeoutSeconds: 90 },
            },
          },
          position: { x: 0, y: 0 },
        },
      ],
    });

    await nodeById(page, 'copy1').click();
    await sourceTab(page).click();
    const pane = properties(page);
    const row = (n: number, part: 'name' | 'type' | 'value') =>
      part === 'type'
        ? pane.getByRole('combobox', { name: `Bind value ${n} type` })
        : pane.getByRole('textbox', { name: `Bind value ${n} ${part}` });
    const importButton = pane.getByRole('button', { name: 'Import from statement' });

    await expect(pane.getByText('Not bound: :b, :c', { exact: true })).toBeVisible();
    await expect(pane.getByText('Not in the statement, so it is not bound.')).toHaveCount(1);
    // The stored `${}` row's type follows its expression.
    await expect(row(2, 'type')).toHaveValue('expression');
    await expect(row(2, 'type')).toBeDisabled();

    await importButton.click();
    await expect(row(3, 'name')).toHaveValue('b');
    await expect(row(4, 'name')).toHaveValue('c');
    await expect(row(4, 'type')).toHaveValue('text');
    await expect(importButton).toBeDisabled();
    await expect(pane.getByText(/^Not bound:/)).toHaveCount(0);
    // One undo step takes both imported rows back out.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(row(3, 'name')).toHaveCount(0);
    await importButton.click();
    await expect(row(4, 'name')).toHaveValue('c');

    // A Number holds text that is not a number yet, and stores one when it is.
    await row(3, 'type').selectOption('number');
    await row(3, 'value').fill('150.');
    await expect(pane.getByText('Enter a number, or a ${} value.')).toBeVisible();
    await row(3, 'value').fill('150');
    await expect(pane.getByText('Enter a number, or a ${} value.')).toHaveCount(0);
    // Null stores null, and there is no value to type.
    await row(1, 'type').selectOption('null');
    await expect(row(1, 'value')).toBeDisabled();
    // Sized to its options, not stretched (UI standard rule 5).
    expect((await row(1, 'type').boundingBox())!.width).toBeLessThanOrEqual(120);
    await expect(problemsToggle(page)).not.toHaveText(/[1-9]/);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    const versions = (await (
      await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
    ).json()) as { version: number; nodes: Record<string, unknown>[] }[];
    const latest = versions.sort((a, b) => b.version - a.version)[0]!;
    const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
    expect(copy['inlineDatasets']).toEqual({
      source: {
        kind: 'query',
        config: {
          sql,
          parameters: { a: null, z: '${params.wm}', b: 150, c: '' },
          queryTimeoutSeconds: 90,
        },
      },
    });
    await expectQuiet(page, problems);
  });
});
