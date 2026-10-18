import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { deselect, toolbox } from './support/canvasGraph';
import { fireAndSettle, nodeById, openSeededCanvas, seedVersion } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #844 V6 — authoring a Set variable node (spec V-D9). #1600 C12a — Append
 * variable is now Set variable's Operation Append, and a stored one opens as it.
 *
 * V5 made the two writers runnable, but their `variable` field was a bare text
 * box: the author had to already know the declared names, and the `${}` flyout
 * beside it offered references the save gate refuses there (a writer's
 * `variable` must be a literal name). What only an e2e can prove is the whole
 * path: the chooser lists what the Variables tab declares, filtered per writer,
 * and a choice reaches the server through Apply and Save.
 */

/** The seeded doc every test starts from: one of each writer, both valid. */
const SEED = {
  nodes: [
    {
      id: 's',
      type: 'set_variable',
      position: { x: 0, y: 0 },
      config: { variable: 'count', value: '1' },
    },
    {
      id: 'a',
      type: 'append_variable',
      position: { x: 0, y: 200 },
      config: { variable: 'rows', value: 'x' },
    },
  ],
  variables: [
    { name: 'count', type: 'number' as const, default: 0 },
    { name: 'rows', type: 'array' as const, default: [] },
    { name: 'label', type: 'string' as const, default: '' },
  ],
};

/** The chooser's options as `[value, text]`, placeholder included. */
async function chooserOptions(page: Page): Promise<string[][]> {
  return properties(page)
    .getByLabel('Declared variable', { exact: true })
    .locator('option')
    .evaluateAll((opts) => opts.map((o) => [(o as HTMLOptionElement).value, o.textContent ?? '']));
}

test.describe('#844 V6 — set/append variable config form', () => {
  test('a Set variable node chooses a DECLARED variable, and the choice survives a save', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'v6 set chooser', SEED);

    await nodeById(page, 's').click();
    const variable = properties(page).getByRole('textbox', { name: 'Variable name', exact: true });
    await expect(variable).toHaveValue('count');
    // Every declared variable, typed, in declaration order.
    expect(await chooserOptions(page)).toEqual([
      ['', '— choose —'],
      ['count', 'count (number)'],
      ['rows', 'rows (array)'],
      ['label', 'label (string)'],
    ]);
    await expect(properties(page).getByLabel('Declared variable', { exact: true })).toHaveValue(
      'count',
    );
    // The name is a literal: no `${}` flyout on it. The value keeps its own.
    await expect(
      properties(page).getByRole('button', { name: 'Insert reference into variable' }),
    ).toHaveCount(0);
    await expect(
      properties(page).getByRole('button', { name: 'Insert reference into value' }),
    ).toBeVisible();

    await properties(page).getByLabel('Declared variable', { exact: true }).selectOption('label');
    await expect(variable).toHaveValue('label');
    await properties(page).getByRole('textbox', { name: 'Value', exact: true }).fill('hello');
    await properties(page).getByRole('button', { name: 'Apply config' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    expect(res.status()).toBe(200);
    const items = (await res.json()) as {
      version: number;
      nodes: { id: string; config: Record<string, unknown> }[];
    }[];
    const latest = items.reduce((x, y) => (x.version > y.version ? x : y));
    expect(latest.nodes.find((n) => n.id === 's')?.config).toMatchObject({
      variable: 'label',
      value: 'hello',
    });

    await expectQuiet(page, problems);
  });

  test('#1600 C12a — Operation Append is offered only arrays, and says so when there are none', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'v6 append chooser', SEED);

    // Choosing Append narrows a Set variable's chooser to the arrays at once,
    // before Apply; back to Set, every variable again.
    await nodeById(page, 's').click();
    const operation = properties(page).getByRole('combobox', { name: 'Operation', exact: true });
    await expect(operation.locator('option:checked')).toHaveText('Set (default)');
    await operation.selectOption('append');
    expect(await chooserOptions(page)).toEqual([
      ['', '— choose —'],
      ['rows', 'rows (array)'],
    ]);
    await operation.selectOption('set');
    expect((await chooserOptions(page)).map(([v]) => v)).toEqual(['', 'count', 'rows', 'label']);
    await properties(page).getByRole('button', { name: 'Revert', exact: true }).click();

    // The seed's stored Append variable opens as a Set variable · Append.
    await nodeById(page, 'a').click();
    await expect(operation.locator('option:checked')).toHaveText('Append');
    expect(await chooserOptions(page)).toEqual([
      ['', '— choose —'],
      ['rows', 'rows (array)'],
    ]);
    await expect(properties(page).locator('.config-field-choices-empty')).toHaveCount(0);

    // Retype the only array variable. The node now names a variable it may
    // not append to: the chooser has nothing to offer and says WHY, and the
    // node's own issue list carries the save gate's refusal.
    // The pipeline's tabs are the nothing-selected panel.
    await deselect(page);
    await page.getByRole('tab', { name: 'Variables' }).click();
    await page.getByLabel('Variable 2 type').selectOption('string');
    await nodeById(page, 'a').click();
    await expect(properties(page).getByLabel('Declared variable', { exact: true })).toHaveCount(0);
    await expect(properties(page).locator('.config-field-choices-empty')).toHaveText(
      /^No array variables/,
    );
    await expect(properties(page)).toContainText('Append needs an array variable');

    await expectQuiet(page, problems);
  });

  test('#1600 C12a — a stored Append variable runs as before, opens as Set variable · Append, and saves as one', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const { pipelineId, pipelineVersionId } = await seedVersion(page, 'e2e 1600 c12a legacy', {
      nodes: [
        {
          id: 'add',
          type: 'append_variable',
          position: { x: 0, y: 0 },
          config: { variable: 'rows', value: 'x' },
        },
      ],
      variables: [{ name: 'rows', type: 'array', default: [] }],
    });
    const appendsOf = async (versionId: string, name: string) => {
      const runId = await fireAndSettle(page, versionId, name);
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: { nodeId?: string; name?: string; value?: unknown } }[];
      expect(events.some((e) => e.type === 'variable.set')).toBe(false);
      return events
        .filter((e) => e.type === 'variable.append')
        .map((e) => [e.payload.nodeId, e.payload.name, e.payload.value]);
    };
    // The stored version is untouched by the lowering: it runs as append_variable.
    expect(await appendsOf(pipelineVersionId, 'e2e 1600 c12a old')).toEqual([['add', 'rows', 'x']]);

    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await expect(nodeById(page, 'add')).toBeVisible();
    await expect(
      toolbox(page).getByRole('button', { name: 'Append variable', exact: true }),
    ).toHaveCount(0);
    await expect(
      toolbox(page).getByRole('button', { name: 'Set variable', exact: true }),
    ).toHaveCount(1);
    await nodeById(page, 'add').click();
    await expect(
      properties(page)
        .getByRole('combobox', { name: 'Operation', exact: true })
        .locator('option:checked'),
    ).toHaveText('Append');
    await expect(
      properties(page).getByRole('textbox', { name: 'Variable name', exact: true }),
    ).toHaveValue('rows');
    // Any edit saves the node as its replacement.
    await properties(page).getByRole('tab', { name: 'General' }).click();
    await properties(page)
      .getByRole('textbox', { name: 'Activity description' })
      .fill('lowered from Append variable');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const versions = (await (
      await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
    ).json()) as {
      id: string;
      version: number;
      nodes: { id: string; type: string; config: Record<string, unknown> }[];
    }[];
    const latest = versions.reduce((x, y) => (x.version > y.version ? x : y));
    expect(latest.nodes[0]).toMatchObject({
      id: 'add',
      type: 'set_variable',
      config: { operation: 'append', variable: 'rows', value: 'x' },
    });
    // The saved Set variable · Append writes exactly what the old type did.
    expect(await appendsOf(latest.id, 'e2e 1600 c12a new')).toEqual([['add', 'rows', 'x']]);

    await expectQuiet(page, problems);
  });
});
