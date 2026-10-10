import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { deselect, validationIssues } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

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

test.describe('U16 — pipeline params/outputs authoring', () => {
  test('a param authored on the canvas SURVIVES a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u16 round trip', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    // A brand-new canvas pipeline: no contract at all. This is the hole.
    await expect(properties(page).getByText('None declared.').first()).toBeVisible();

    await page.getByRole('button', { name: 'Add parameter' }).click();
    await page.getByLabel('Parameter 1 name').fill('topic');
    await page.getByLabel('Parameter 1 type').selectOption('number');
    await page.getByLabel('Parameter 1 default').fill('42');
    // Blur commits the default — the one control that cannot write per keystroke.
    await page.getByLabel('Parameter 1 name').click();

    // #844 — outputs are the property dock's second tab.
    await page.getByRole('tab', { name: 'Outputs' }).click();
    await page.getByRole('button', { name: 'Add output' }).click();
    await page.getByLabel('Output 1 name').fill('answer');
    await page.getByLabel('Output 1 type').selectOption('json');

    expect(await validationIssues(page), 'the contract left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the LATEST version from the server, so
    // what renders here is what was actually persisted — not what the store
    // happened to still be holding.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();

    await expect(page.getByLabel('Parameter 1 name')).toHaveValue('topic');
    await expect(page.getByLabel('Parameter 1 type')).toHaveValue('number');
    // Typed, not the raw text: the doc stores the NUMBER 42, which formats back
    // to '42' — a stored string would too, so the server body is checked below.
    await expect(page.getByLabel('Parameter 1 default')).toHaveValue('42');
    await page.getByRole('tab', { name: 'Outputs' }).click();
    await expect(page.getByLabel('Output 1 name')).toHaveValue('answer');
    await expect(page.getByLabel('Output 1 type')).toHaveValue('json');

    // What the string check above cannot see: the persisted default is a JSON
    // number. `${params.topic}` types off this declaration (#6 E6), so storing
    // '42' would type as a string everywhere it is referenced.
    const versions = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    expect(versions.status()).toBe(200);
    const items = (await versions.json()) as {
      version: number;
      params: { name: string; default?: unknown }[];
    }[];
    const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
    expect(latest.params[0]!.default).toBe(42);

    await expectQuiet(page, problems);
  });

  test('#844 4c — an empty-string default SURVIVES a save and reload as `""`', async ({ page }) => {
    // Blank means "no default", so `''` is its own tick box. What the unit suite
    // cannot see: that the KEY reaches the server, since `default: ''` and no
    // default at all look identical in the field.
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u16 empty default', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [{ name: 'suffix', type: 'string', required: false }],
    });

    const box = page.getByLabel('Parameter 1 empty-string default');
    await expect(box).not.toBeChecked();
    await box.check();
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await expect(page.getByLabel('Parameter 1 empty-string default')).toBeChecked();
    await expect(page.getByLabel('Parameter 1 default')).toHaveValue('');

    const versions = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    const items = (await versions.json()) as {
      version: number;
      params: Record<string, unknown>[];
    }[];
    const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
    expect(Object.prototype.hasOwnProperty.call(latest.params[0], 'default')).toBe(true);
    expect(latest.params[0]!['default']).toBe('');

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

    await expect(page.getByLabel('Parameter 1 name')).toHaveValue('kept');

    // #844 — outputs are the property dock's second tab.
    await page.getByRole('tab', { name: 'Outputs' }).click();
    await page.getByRole('button', { name: 'Add output' }).click();
    await page.getByLabel('Output 2 name').fill('added');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const versions = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    const items = (await versions.json()) as {
      version: number;
      params: { name: string }[];
      outputs: { name: string }[];
    }[];
    const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
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

    await page.getByRole('button', { name: 'Add parameter' }).click();
    await page.getByLabel('Parameter 2 name').fill('topic');

    // The SERVER refuses this too (`refuseDuplicateNames`), so gating here only
    // spares a round-trip to a 400 — and the message is the server's own words.
    expect((await validationIssues(page)).join('\n')).toContain('duplicate param name');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // The exit, through the control that got here. This is what makes the gate
    // safe: a doc the canvas refuses is one the canvas can also repair.
    await page.getByLabel('Parameter 2 name').fill('other');
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await expectQuiet(page, problems);
  });

  test('#844 — a non-identifier name and a ${} default are NOTED on the row, and Save stays open', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u16 advisories', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [{ name: 'topic', type: 'string', required: false }],
    });

    await page.getByLabel('Parameter 1 name').fill('topic.id');
    const dflt = page.getByLabel('Parameter 1 default');
    await dflt.fill('run-${run.runId}');
    await dflt.blur();

    await expect(properties(page).getByText("'topic.id' is not a plain identifier")).toBeVisible();
    await expect(properties(page).getByText('used exactly as written')).toBeVisible();
    // Notes, not gates: the doc is legal and the server takes it.
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    // A string default carried into a json param now reads as the string it is.
    await page.getByLabel('Parameter 1 type').selectOption('json');
    await expect(dflt).toHaveValue('"run-${run.runId}"');

    await expectQuiet(page, problems);
  });

  test('a type-mismatched default BLOCKS the save, and the editor is the exit', async ({
    page,
  }) => {
    // This test asserted the OPPOSITE until #843, and the reversal is the
    // ticket. The old posture — advise, never gate — rested on the server
    // ACCEPTING such a doc, which made a client refusal a one-way trap (#748):
    // an imported pipeline holding a bad default could never be saved again.
    // #843 moved the check to the server write gate, so the doc is refused
    // either way and the trap argument collapses. What makes gating safe is the
    // same thing that makes it safe for a duplicate name: the editor that
    // surfaces the defect can also repair it.
    //
    // Getting a bad default onto the canvas at all takes some care, and the
    // reason is worth recording. It can no longer be SEEDED (the API 400s now),
    // and it cannot be TYPED either — `coerceDefaultInput` refuses to store text
    // that does not fit the declared type, so the field reports its own parse
    // error and writes nothing. The one authoring gesture that mints this doc is
    // a TYPE change over a default that was already stored, which the type
    // `<select>` deliberately allows: dropping the default on a mis-click would
    // destroy authored data, so it is kept and the gate explains it. That is
    // also the realistic operator mistake, so it is the right thing to drive.
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u16 default gate', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [{ name: 'n', type: 'string', required: false, default: 'abc' }],
    });

    await page.getByLabel('Parameter 1 type').selectOption('number');

    // The row names it, and the doc-level badge names it in the SAME words.
    await expect(properties(page).getByText("param 'n': expected a finite number")).toBeVisible();
    expect(await validationIssues(page)).toContain("param 'n': expected a finite number");
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // The exit, through the control that got here.
    await page.getByLabel('Parameter 1 type').selectOption('string');
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await expectQuiet(page, problems);
  });

  test('#844 V3 — a variable authored in its tab SURVIVES a save and reload, typed', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'v3 round trip', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    await page.getByRole('tab', { name: 'Variables' }).click();
    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByLabel('Variable 1 name').fill('count');
    // A type change converts the new row's '' default to the number's zero, so
    // the doc is legal before the author types a value at all.
    await page.getByLabel('Variable 1 type').selectOption('number');
    await expect(page.getByLabel('Variable 1 default')).toHaveValue('0');
    await page.getByLabel('Variable 1 default').fill('5');
    await page.getByLabel('Variable 1 name').click(); // blur commits the default

    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByLabel('Variable 2 name').fill('rows');
    await page.getByLabel('Variable 2 type').selectOption('array');
    await page.getByLabel('Variable 2 default').fill('[1, "a"]');
    await page.getByLabel('Variable 2 name').click();

    expect(await validationIssues(page), 'the variables left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await page.getByRole('tab', { name: 'Variables' }).click();
    await expect(page.getByLabel('Variable 1 name')).toHaveValue('count');
    await expect(page.getByLabel('Variable 1 type')).toHaveValue('number');
    await expect(page.getByLabel('Variable 2 default')).toHaveValue('[1,"a"]');

    // The field text cannot tell 5 from '5'; the persisted version can.
    const versions = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    expect(versions.status()).toBe(200);
    const items = (await versions.json()) as {
      version: number;
      variables: { name: string; type: string; default: unknown }[];
    }[];
    const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
    expect(latest.variables).toEqual([
      { name: 'count', type: 'number', default: 5 },
      { name: 'rows', type: 'array', default: [1, 'a'] },
    ]);

    await expectQuiet(page, problems);
  });

  test('#844 V3 — an unreferenceable or duplicate variable name BLOCKS Save, and the row repairs it', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'v3 names', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      variables: [{ name: 'total', type: 'number', default: 0 }],
    });
    await page.getByRole('tab', { name: 'Variables' }).click();

    await page.getByLabel('Variable 1 name').fill('my-total');
    expect((await validationIssues(page)).join('\n')).toContain(
      "variable 'my-total' cannot be referenced",
    );
    // The row states the same sentence, where the fix is made.
    await expect(properties(page).getByRole('alert')).toContainText(
      "'my-total' cannot be referenced",
    );
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await page.getByLabel('Variable 1 name').fill('total');
    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByLabel('Variable 2 name').fill('total');
    expect((await validationIssues(page)).join('\n')).toContain('duplicate variable name');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await page.getByLabel('Variable 2 name').fill('other');
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await expectQuiet(page, problems);
  });

  test('the panel is reachable by deselecting, and yields to a selected node', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u16 reachable', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    await expect(page.getByRole('button', { name: 'Add parameter' })).toBeVisible();

    // Selecting a node swaps the panel to that node's inspector...
    await page.locator('.react-flow__node[data-id="a"]').click();
    await expect(page.getByRole('button', { name: 'Apply config' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add parameter' })).toHaveCount(0);

    // ...and clicking the background brings the pipeline contract back. Without
    // this the editor would have no route to it at all.
    await deselect(page);
    await expect(page.getByRole('button', { name: 'Add parameter' })).toBeVisible();

    await expectQuiet(page, problems);
  });
});
