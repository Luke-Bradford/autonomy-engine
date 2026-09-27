import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { deselect } from './support/canvasGraph';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #844 V6 — authoring a Set variable / Append variable node (spec V-D9).
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
    const variable = properties(page).getByRole('textbox', { name: 'variable', exact: true });
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
    await properties(page).getByRole('textbox', { name: 'value', exact: true }).fill('hello');
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

  test('an Append variable node is offered only arrays, and says so when there are none', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'v6 append chooser', SEED);

    await nodeById(page, 'a').click();
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
    await page.getByLabel('variable 2 type').selectOption('string');
    await nodeById(page, 'a').click();
    await expect(properties(page).getByLabel('Declared variable', { exact: true })).toHaveCount(0);
    await expect(properties(page).locator('.config-field-choices-empty')).toHaveText(
      /^None of this pipeline’s variables is an array/,
    );
    await expect(properties(page)).toContainText('append_variable needs an array variable');

    await expectQuiet(page, problems);
  });
});
