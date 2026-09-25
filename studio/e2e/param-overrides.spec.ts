import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';

/**
 * #1304 — a node's per-dispatch parameter overrides are authored on the canvas.
 *
 * Before this, `connectionParams` and `datasetParams` worked at dispatch but
 * could only be written through the REST API or a git commit. This spec walks the
 * authoring path end to end against LIVE rows:
 *
 *  - the Add list is fed by the real resources' `parameters` allowlists, so a
 *    key the owner did not declare is not on offer;
 *  - a number setting's text reaches the persisted version as a NUMBER, which is
 *    what dispatch re-validates the merged config against;
 *  - the doc survives the client-side `PipelineVersionWriteSchema.parse` and the
 *    server's save gate, and a reload renders what was PERSISTED.
 */

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

test.describe('#1304 — parameter overrides on the canvas', () => {
  test('connection + dataset overrides are authored, saved and reloaded', async ({ page }) => {
    const problems = collectPageProblems(page);

    const connId = await seedConnection(page, {
      name: 'e2e 1304 files',
      kind: 'fs',
      config: { roots: ['/tmp/e2e-1304'], maxBytes: 1000 },
      parameters: ['maxBytes'],
    });
    const setId = await seedDataset(page, {
      name: 'e2e 1304 people',
      kind: 'delimited',
      connectionId: connId,
      config: { path: 'people.csv' },
      columns: [{ name: 'id', type: 'integer', nullable: false }],
      parameters: ['path'],
    });

    const pipelineId = await openSeededCanvas(page, 'e2e 1304 overrides', { nodes: [] });
    await addActivity(page, 'Lookup Rows');
    await canvasNodes(page).first().click();

    // No editor until an end is bound: an override without its binding is refused by the save gate.
    const connGroup = panel(page).getByRole('group', { name: 'Connection overrides' });
    await expect(connGroup).toHaveCount(0);

    await panel(page)
      .getByRole('combobox', { name: 'Connection', exact: true })
      .selectOption(connId);
    await panel(page).getByRole('combobox', { name: 'Source dataset' }).selectOption(setId);

    // The Add list is the connection's allowlist: `maxBytes` and nothing else.
    // `maxEntries` exists on the kind and is not declared, so it is absent.
    const addConn = connGroup.getByRole('combobox', { name: 'Add connection override' });
    await expect(addConn.locator('option')).toHaveText(['maxBytes']);
    await connGroup.getByRole('button', { name: 'Add override' }).click();
    // It starts from the connection's own value, so adding it changes nothing yet.
    const maxBytes = connGroup.getByRole('textbox', { name: 'maxBytes' });
    await expect(maxBytes).toHaveValue('1000');
    await maxBytes.fill('4096');

    const setGroup = panel(page).getByRole('group', { name: 'Source dataset overrides' });
    await setGroup.getByRole('button', { name: 'Add override' }).click();
    const path = setGroup.getByRole('textbox', { name: 'path' });
    await expect(path).toHaveValue('people.csv');
    await path.fill('out-${run.runId}.csv');

    // Once every declared key is overridden there is nothing left to add.
    await expect(connGroup.getByRole('button', { name: 'Add override' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();
    await expect(connGroup.getByRole('textbox', { name: 'maxBytes' })).toHaveValue('4096');
    await expect(setGroup.getByRole('textbox', { name: 'path' })).toHaveValue(
      'out-${run.runId}.csv',
    );

    // Read from the PERSISTED version, not from what the panel shows.
    const res = await page.request.get(`/api/pipelines/${pipelineId}/versions`);
    const versions = (await res.json()) as {
      version: number;
      nodes: {
        type: string;
        connectionParams?: Record<string, unknown>;
        datasetParams?: Record<string, unknown>;
      }[];
    }[];
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    const stored = latest.nodes.find((n) => n.type === 'lookup');
    // A NUMBER, not the string "4096". Dispatch re-validates the merged config
    // against the kind's schema, and `maxBytes` is `z.number()`.
    expect(stored?.connectionParams).toEqual({ maxBytes: 4096 });
    expect(stored?.datasetParams).toEqual({ source: { path: 'out-${run.runId}.csv' } });

    // Removing the last row clears the end outright. `{}` is never written.
    await connGroup.getByRole('button', { name: 'Remove override maxBytes' }).click();
    await expect(connGroup.getByRole('textbox', { name: 'maxBytes' })).toHaveCount(0);
    await expect(
      connGroup.getByRole('combobox', { name: 'Add connection override' }),
    ).toBeVisible();

    await expectQuiet(page, problems);
  });
});
