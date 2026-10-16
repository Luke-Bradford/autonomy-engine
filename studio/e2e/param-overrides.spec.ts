import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { properties, pickConnection } from './support/panels';

/**
 * #1304 — a node's per-dispatch parameter overrides are authored on the canvas.
 *
 * Before this, `connectionParams` and `datasetParams` worked at dispatch but
 * could only be written through the REST API or a git commit. This spec walks the
 * authoring path end to end against LIVE rows:
 *
 *  - the rows are the real resources' `parameters` allowlists, so a
 *    key the owner did not declare is not on offer;
 *  - a number setting's text reaches the persisted version as a NUMBER, which is
 *    what dispatch re-validates the merged config against;
 *  - the doc survives the client-side `PipelineVersionWriteSchema.parse` and the
 *    server's save gate, and a reload renders what was PERSISTED.
 */

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
    await addActivity(page, 'Lookup');
    await canvasNodes(page).first().click();

    // No editor until an end is bound: an override without its binding is refused by the save gate.
    const connGroup = properties(page).getByRole('group', { name: 'Connection overrides' });
    await expect(connGroup).toHaveCount(0);

    await pickConnection(page, 'Connection', { id: connId });
    await properties(page).getByRole('combobox', { name: 'Source dataset' }).selectOption(setId);

    // #1694 OR42 item 8 — the rows are the connection's allowlist: `maxBytes`
    // and nothing else. `maxEntries` exists on the kind and is not declared, so
    // it is absent. Each row is blank, with the connection's own value as its
    // placeholder, until it is typed into; there is no Add control.
    await expect(connGroup.getByRole('rowheader')).toHaveText(['Largest file read (bytes)']);
    await expect(connGroup.getByRole('button', { name: /^Add/ })).toHaveCount(0);
    const maxBytes = connGroup.getByRole('textbox', { name: 'Largest file read (bytes)' });
    await expect(maxBytes).toHaveValue('');
    await expect(maxBytes).toHaveAttribute('placeholder', '1000');
    await maxBytes.fill('4096');

    const setGroup = properties(page).getByRole('group', { name: 'Source dataset overrides' });
    const path = setGroup.getByRole('textbox', { name: 'File path' });
    await expect(path).toHaveAttribute('placeholder', 'people.csv');
    await path.fill('out-${run.runId}.csv');

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();
    await expect(connGroup.getByRole('textbox', { name: 'Largest file read (bytes)' })).toHaveValue(
      '4096',
    );
    await expect(setGroup.getByRole('textbox', { name: 'File path' })).toHaveValue(
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

    // Removing the last override clears the end outright. `{}` is never written.
    // The row stays, blank, so the setting can be overridden again.
    await connGroup
      .getByRole('button', { name: 'Remove override Largest file read (bytes)' })
      .click();
    await expect(connGroup.getByRole('textbox', { name: 'Largest file read (bytes)' })).toHaveValue(
      '',
    );
    // Clearing a box removes its override the same way.
    await setGroup.getByRole('textbox', { name: 'File path' }).fill('');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v3.');
    const after = (await (
      await page.request.get(`/api/pipelines/${pipelineId}/versions`)
    ).json()) as typeof versions;
    const v3 = after.reduce((a, b) => (b.version > a.version ? b : a));
    const cleared = v3.nodes.find((n) => n.type === 'lookup');
    expect(cleared && 'connectionParams' in cleared).toBe(false);
    expect(cleared && 'datasetParams' in cleared).toBe(false);

    await expectQuiet(page, problems);
  });
});
