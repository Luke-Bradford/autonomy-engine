import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas, seedVersion } from './support/seedDoc';

/**
 * #425 — authoring a `call_pipeline` node on the canvas.
 *
 * The last of #425's four gaps. `execute_pipeline` was catalogued but
 * deliberately unreachable from the canvas: the palette hid it, the drop path
 * refused it, `addNode` refused it, and the inspector showed a read-only stub —
 * because its settings live in `Node.call`, which the generic `node.config`
 * form cannot author. So "this pipeline runs that pipeline", the engine's only
 * composition primitive, could be built through the API and nowhere else.
 *
 * What no unit test can reach, and this spec is here for:
 *
 *  - the panel's target list is fetched from the LIVE server, so the pipeline
 *    and version an operator picks are real rows rather than a stub's fixture;
 *  - the child's DECLARED params drive the form, which means the two pipelines
 *    have to actually exist together in one workspace;
 *  - and the round trip through Save proves `node.call` reached an immutable
 *    version — `toVersionBody` carrying it, the write gate accepting it, and
 *    the reload rendering it back into the same picker.
 */

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

async function validationIssues(page: Page): Promise<string[]> {
  const list = page.locator('.badge-list li');
  return (await list.count()) === 0 ? [] : list.allTextContents();
}

const CHILD = 'e2e 425 child';

test.describe('#425 — call-node authoring', () => {
  test('a call node is authored on the canvas and SURVIVES a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);

    // The child, minted through the API so it exists as a real version with a
    // real declared contract before the parent's canvas ever opens.
    await seedVersion(page, CHILD, {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [
        { name: 'query', type: 'string', required: true },
        { name: 'limit', type: 'number', required: false },
      ],
    });

    const parentId = await openSeededCanvas(page, 'e2e 425 parent', { nodes: [] });

    // The palette OFFERS it now — this click is the whole retired exclusion.
    await addActivity(page, 'Execute Pipeline');
    await expect(canvasNodes(page)).toHaveCount(1);

    // Added with no `call`, which is a doc the save gate refuses — deliberately,
    // because there is no honest default target. The diagnostic says what to do
    // rather than naming a Zod path, and Save stays dead until it is satisfied.
    expect((await validationIssues(page)).join('\n')).toContain('needs a call config');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await canvasNodes(page).first().click();
    await expect(panel(page).getByRole('heading', { name: 'Call target' })).toBeVisible();

    // The child's params are UNKNOWN until a version is chosen — they are a
    // property of the target, not of the node.
    await expect(panel(page).getByLabel('query')).toHaveCount(0);

    await panel(page).getByLabel('Pipeline').selectOption({ label: CHILD });
    await panel(page).getByLabel('Version', { exact: true }).selectOption({ label: 'v1' });

    // Now they are on screen, straight from the version the picker resolved.
    await expect(panel(page).getByLabel('query')).toBeVisible();
    await panel(page).getByLabel('query').fill('ships');
    await panel(page).getByLabel('limit').fill('25');
    await panel(page).getByLabel('Wait for the child run').check();
    await panel(page).getByRole('button', { name: 'Apply call' }).click();

    expect(await validationIssues(page), 'the authored call left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the LATEST version from the server, so
    // what renders here is what was PERSISTED — not what the store still held.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(parentId)}`);
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();

    // Resolved back to the pipeline AND the version, from the stored id alone —
    // the picker is showing what the doc says, not a remembered selection.
    await expect(panel(page).getByLabel('Pipeline')).toHaveValue(/.+/);
    await expect(panel(page).getByLabel('Pipeline')).toContainText(CHILD);
    await expect(panel(page).getByLabel('query')).toHaveValue('ships');
    await expect(panel(page).getByLabel('limit')).toHaveValue('25');
    await expect(panel(page).getByLabel('Wait for the child run')).toBeChecked();

    // The contract that would otherwise be destroyed silently: a call node's
    // outputs come from the CHILD projection, so `config.outputs` must be ABSENT
    // (store every child output), never the catalog's `[]` (store none). Read
    // from the persisted version, because the flip is invisible on screen.
    const persisted = await page.request.get(`/api/pipelines/${parentId}/versions`);
    const versions = (await persisted.json()) as {
      version: number;
      nodes: { type: string; config: Record<string, unknown>; call?: unknown }[];
    }[];
    const saved = versions.find((v) => v.version === 2)!;
    const node = saved.nodes.find((n) => n.type === 'execute_pipeline')!;
    expect(node.config['outputs'], 'a catalog outputs:[] was baked in').toBeUndefined();
    expect(node.call).toMatchObject({ params: { query: 'ships', limit: 25 }, wait: true });

    expectQuiet(problems);
  });

  test('an EXPRESSION target is authorable, and says it is not statically checked', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const parentId = await openSeededCanvas(page, 'e2e 425 expression', {
      nodes: [],
      params: [{ name: 'target', type: 'string', required: true }],
    });

    await addActivity(page, 'Execute Pipeline');
    await canvasNodes(page).first().click();
    await panel(page).getByRole('radio', { name: 'Expression' }).check();

    // The honesty the panel owes the operator: `validateRefs` does not walk
    // `node.call`, and the call-depth guard only sees literal targets, so this
    // form has none of the save-time checking the rest of the config surface has.
    await expect(panel(page).getByText(/not checked when you save/)).toBeVisible();

    await panel(page).getByLabel('Version id or expression').fill('${params.target}');
    // The target is not a listable version, so its declared params are unknown —
    // the arguments are entered directly rather than guessed at.
    await panel(page).getByLabel('Parameters (JSON object)').fill('{"query":"ships"}');
    await panel(page).getByRole('button', { name: 'Apply call' }).click();

    expect(await validationIssues(page)).toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // Reloaded, the expression comes back as ITSELF — the hazard this arm
    // guards is a target the picker cannot resolve being presented as "nothing
    // chosen" and then lost on the next Apply.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(parentId)}`);
    await canvasNodes(page).first().click();
    await expect(panel(page).getByLabel('Version id or expression')).toHaveValue(
      '${params.target}',
    );
    await expect(panel(page).getByLabel('Parameters (JSON object)')).toHaveValue(
      '{\n  "query": "ships"\n}',
    );

    expectQuiet(problems);
  });
});
