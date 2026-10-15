import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { problemsToggle, properties } from './support/panels';
import { seedConnection, seedDataset } from './support/seedResources';

/**
 * #1600 OR41 C1q-a — a Copy whose SOURCE is an inline Query (`Node.inlineDatasets`)
 * beside a saved SINK dataset (`datasetIds: { sink }`), seeded through the API.
 *
 * What this pins, before C1q-b brings the editable Source block: the server's save
 * gate and the client's write-schema parse both accept the sink-only shape; the
 * canvas's own validation raises no problem for it; and the node's source is
 * visible in the form (UI standard rule 3) on its card and on the Source tab.
 */
test.describe('#1600 C1q — an inline database source', () => {
  test('a copy reading an inline query shows it on its card and its Source tab, with no problem raised', async ({
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
    await openSeededCanvas(page, 'e2e 1600 c1q inline', {
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
    await properties(page).getByRole('tab', { name: 'Source', exact: true }).click();
    const line = properties(page).getByTestId('inline-source');
    await expect(line).toContainText('Inline query');
    await expect(line.locator('code')).toHaveText(sql);

    // The canvas validates with the same `validateDoc` the server ran: nothing to report.
    await expect(problemsToggle(page)).not.toHaveText(/[1-9]/);
    await expectQuiet(page, problems);
  });
});
