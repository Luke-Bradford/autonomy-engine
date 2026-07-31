import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { deselect } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';

/**
 * U16 — authoring a pipeline's typed `params`/`outputs` contract on the canvas.
 *
 * Until this ticket there was no UI for either, so `toVersionBody` carried them
 * forward from the version the canvas was opened on. That meant a pipeline built
 * from scratch on the canvas could never declare a param: `${params.x}` had
 * nothing to resolve, and a trigger had nothing typed to bind its values to.
 *
 * The unit suites pin the rules and the store actions. What only an e2e can
 * prove is the thing the whole ticket is about — that a param authored on screen
 * REACHES THE SERVER and comes back on reload. That is a round-trip through the
 * write gate and an immutable version mint; no jsdom test can see it, and it is
 * exactly what a regression to the old carry-forward would silently break.
 */

/** The panel is the nothing-selected slot, so a fresh canvas already shows it. */
function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** The validation badge's messages, or `[]` when there is no badge. */
async function validationIssues(page: Page): Promise<string[]> {
  const list = page.locator('.badge-list li');
  return (await list.count()) === 0 ? [] : list.allTextContents();
}

test.describe('U16 — pipeline params/outputs authoring', () => {
  test('a param authored on the canvas SURVIVES a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u16 round trip', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    // A brand-new canvas pipeline: no contract at all. This is the hole.
    await expect(panel(page).getByText('None declared.').first()).toBeVisible();

    await page.getByRole('button', { name: 'Add param' }).click();
    await page.getByLabel('param 1 name').fill('topic');
    await page.getByLabel('param 1 type').selectOption('number');
    await page.getByLabel('param 1 default').fill('42');
    // Blur commits the default — the one control that cannot write per keystroke.
    await page.getByLabel('param 1 name').click();

    await page.getByRole('button', { name: 'Add output' }).click();
    await page.getByLabel('output 1 name').fill('answer');
    await page.getByLabel('output 1 type').selectOption('json');

    expect(await validationIssues(page), 'the contract left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the LATEST version from the server, so
    // what renders here is what was actually persisted — not what the store
    // happened to still be holding.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();

    await expect(page.getByLabel('param 1 name')).toHaveValue('topic');
    await expect(page.getByLabel('param 1 type')).toHaveValue('number');
    // Typed, not the raw text: the doc stores the NUMBER 42, which formats back
    // to '42' — a stored string would too, so the server body is checked below.
    await expect(page.getByLabel('param 1 default')).toHaveValue('42');
    await expect(page.getByLabel('output 1 name')).toHaveValue('answer');
    await expect(page.getByLabel('output 1 type')).toHaveValue('json');

    // What the string check above cannot see: the persisted default is a JSON
    // number. `${params.topic}` types off this declaration (#6 E6), so storing
    // '42' would type as a string everywhere it is referenced.
    const versions = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    expect(versions.status()).toBe(200);
    const body = (await versions.json()) as {
      items: { version: number; params: { name: string; default?: unknown }[] }[];
    };
    const latest = body.items.reduce((a, b) => (a.version > b.version ? a : b));
    expect(latest.params[0].default).toBe(42);

    await expectQuiet(page, problems);
  });

  test('an existing contract is NOT dropped by a save that only moves the graph', async ({
    page,
  }) => {
    // The carry-forward this ticket replaced existed to prevent exactly this
    // loss, so the new working-state path has to keep the property it had.
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u16 preserve', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [{ name: 'kept', type: 'string', required: true }],
      outputs: [{ name: 'also_kept', type: 'string' }],
    });

    await expect(page.getByLabel('param 1 name')).toHaveValue('kept');

    await page.getByRole('button', { name: 'Add output' }).click();
    await page.getByLabel('output 2 name').fill('added');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const versions = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    const body = (await versions.json()) as {
      items: { version: number; params: { name: string }[]; outputs: { name: string }[] }[];
    };
    const latest = body.items.reduce((a, b) => (a.version > b.version ? a : b));
    expect(latest.params.map((p) => p.name)).toEqual(['kept']);
    expect(latest.outputs.map((o) => o.name)).toEqual(['also_kept', 'added']);

    await expectQuiet(page, problems);
  });

  test('a duplicate name blocks Save, and the editor is the way back out', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u16 duplicate', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [{ name: 'topic', type: 'string', required: false }],
    });

    await page.getByRole('button', { name: 'Add param' }).click();
    await page.getByLabel('param 2 name').fill('topic');

    // The SERVER refuses this too (`refuseDuplicateNames`), so gating here only
    // spares a round-trip to a 400 — and the message is the server's own words.
    expect((await validationIssues(page)).join('\n')).toContain('duplicate param name');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // The exit, through the control that got here. This is what makes the gate
    // safe: a doc the canvas refuses is one the canvas can also repair.
    await page.getByLabel('param 2 name').fill('other');
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await expectQuiet(page, problems);
  });

  test('a type-mismatched default ADVISES but never blocks the save', async ({ page }) => {
    // The posture that decided this ticket. A version minted before this editor
    // existed can hold a default the run will reject; the server accepts such a
    // doc, so REFUSING to save it would leave that pipeline permanently
    // unsaveable — the one-way trap #748 closed, re-created by the check meant
    // to help. Say what is wrong; do not bar the exit.
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u16 advisory', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [{ name: 'n', type: 'number', required: false, default: 'abc' }],
    });

    await expect(panel(page).getByText(/not a finite number/)).toBeVisible();
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await expectQuiet(page, problems);
  });

  test('the panel is reachable by deselecting, and yields to a selected node', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u16 reachable', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    await expect(page.getByRole('button', { name: 'Add param' })).toBeVisible();

    // Selecting a node swaps the panel to that node's inspector...
    await page.locator('.react-flow__node[data-id="a"]').click();
    await expect(page.getByLabel('Container membership')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add param' })).toHaveCount(0);

    // ...and clicking the background brings the pipeline contract back. Without
    // this the editor would have no route to it at all.
    await deselect(page);
    await expect(page.getByRole('button', { name: 'Add param' })).toBeVisible();

    await expectQuiet(page, problems);
  });
});
