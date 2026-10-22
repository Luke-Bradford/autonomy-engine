import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity } from './support/canvasGraph';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1600 OR41 C12b (catalogue §4.7) — Set variable · Operation *Pipeline return
 * value*: a key · type · value table in the child, read by the calling pipeline
 * as `${nodes.<call>.output.pipelineReturnValue.<key>}` (ADF's
 * `activity('…').output.pipelineReturnValue.<key>`).
 */
test.describe('#1600 C12b — Pipeline return value', () => {
  test('authored from the palette, saved, and read by the calling pipeline', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'e2e 1600 c12b child', {
      nodes: [
        {
          id: 'work',
          type: 'set_variable',
          position: { x: 0, y: 0 },
          config: { variable: 'n', value: '1' },
        },
      ],
      variables: [{ name: 'n', type: 'number', default: 0 }],
    });

    // A Set variable from the palette, switched to Pipeline return value: the
    // Variable and Value fields go, and the Return keys table comes.
    const ids = () =>
      page
        .locator('.react-flow__node')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    const before = new Set(await ids());
    await addActivity(page, 'Set variable');
    await expect.poll(async () => (await ids()).filter((id) => !before.has(id)).length).toBe(1);
    const [added] = (await ids()).filter((id) => !before.has(id));
    await page.locator(`.react-flow__node[data-id="${added}"]`).click();
    const pane = properties(page);
    await expect(pane.getByRole('textbox', { name: 'Variable name', exact: true })).toBeVisible();
    await pane.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('return');
    await expect(pane.getByRole('textbox', { name: 'Variable name', exact: true })).toHaveCount(0);
    await expect(pane.getByRole('textbox', { name: 'Value', exact: true })).toHaveCount(0);

    const addRow = pane.getByRole('button', { name: 'Add return keys row', exact: true });
    await addRow.click();
    await pane.getByRole('textbox', { name: 'Return keys row 1 key', exact: true }).fill('total');
    await pane
      .getByRole('combobox', { name: 'Return keys row 1 type', exact: true })
      .selectOption('number');
    await pane.getByRole('textbox', { name: 'Return keys row 1 value', exact: true }).fill('42');
    await addRow.click();
    await pane.getByRole('textbox', { name: 'Return keys row 2 key', exact: true }).fill('label');
    await pane
      .getByRole('combobox', { name: 'Return keys row 2 type', exact: true })
      .selectOption('string');
    await pane.getByRole('textbox', { name: 'Return keys row 2 value', exact: true }).fill('done');

    // At 1440x900 the table's rows are on screen, and the tab does not scroll sideways.
    const row = await pane
      .getByRole('textbox', { name: 'Return keys row 2 key', exact: true })
      .boundingBox();
    const sideways = await pane
      .getByRole('tabpanel')
      .evaluate((panel) => panel.scrollWidth - panel.clientWidth);
    expect(row!.y + row!.height).toBeLessThanOrEqual(900);
    expect(row!.x + row!.width).toBeLessThanOrEqual(1440);
    expect(sideways).toBeLessThanOrEqual(0);

    await pane.getByRole('button', { name: 'Apply config', exact: true }).click();
    await expect(page.locator(`.react-flow__node[data-id="${added}"]`)).toContainText(
      'return total, label',
    );
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const versions = (await (
      await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
    ).json()) as {
      id: string;
      version: number;
      nodes: { id: string; type: string; config: Record<string, unknown> }[];
    }[];
    const child = versions.reduce((x, y) => (x.version > y.version ? x : y));
    const ret = child.nodes.find((n) => n.id === added)!;
    expect(ret).toMatchObject({
      type: 'set_variable',
      config: {
        operation: 'return',
        returnValues: [
          { key: 'total', type: 'number', value: '42' },
          { key: 'label', type: 'string', value: 'done' },
        ],
        outputs: [{ name: 'pipelineReturnValue', type: 'json' }],
      },
    });
    expect(ret.config).not.toHaveProperty('variable');
    expect(ret.config).not.toHaveProperty('value');

    // The calling pipeline reads one key into a variable.
    const parent = await seedVersion(page, 'e2e 1600 c12b parent', {
      nodes: [
        {
          id: 'caller',
          type: 'execute_pipeline',
          call: { pipelineVersionId: child.id, params: {} },
          position: { x: 0, y: 0 },
        },
        {
          id: 'use',
          type: 'set_variable',
          position: { x: 300, y: 0 },
          config: { variable: 'got', value: '${nodes.caller.output.pipelineReturnValue.total}' },
        },
      ],
      edges: [{ from: 'caller', to: 'use', on: 'success' }],
      variables: [{ name: 'got', type: 'number', default: 0 }],
    });
    const runId = await fireAndSettle(page, parent.pipelineVersionId, 'e2e 1600 c12b');
    const events = (await (
      await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
    ).json()) as { type: string; payload: Record<string, unknown> }[];
    expect(events.find((e) => e.type === 'call.returned')?.payload).toMatchObject({
      childOutcome: 'success',
      outputs: { pipelineReturnValue: { total: 42, label: 'done' } },
    });
    expect(events.find((e) => e.type === 'variable.set')?.payload).toMatchObject({
      name: 'got',
      value: 42,
    });

    await expectQuiet(page, problems);
  });
});
