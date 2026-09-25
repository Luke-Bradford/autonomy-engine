import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1305 — a connection's or dataset's own `parameters` allowlist (which config
 * keys a node may override per run) is edited on its page. #1304 gave the canvas
 * the node half; `param-overrides.spec.ts` covers that the canvas offers exactly
 * the allowlisted keys, so this spec stops at the page → server round trip.
 *
 * What it pins against the LIVE server, not a mock:
 *  - ticking a key stores it;
 *  - a save that does not touch the allowlist (a rename) leaves it alone — the
 *    write omits the key, because an explicit list REPLACES the stored one;
 *  - unticking every key stores an explicit `[]`;
 *  - a kind with nothing overridable says so instead of drawing an empty set.
 */

async function stored(page: Page, path: string): Promise<string[]> {
  const res = await page.request.get(path);
  expect(res.ok(), `GET ${path}`).toBe(true);
  return ((await res.json()) as { parameters: string[] }).parameters;
}

async function openEdit(page: Page, hash: string, heading: string, rowName: string) {
  await page.goto(hash);
  await page.getByRole('heading', { name: heading }).waitFor();
  await fluentRootReady(page);
  const row = page.getByRole('row', { name: new RegExp(rowName) });
  await row.getByRole('button', { name: /^Edit / }).click();
}

test.describe('#1305 — the override allowlist is edited on the resource pages', () => {
  test('a connection’s allowlist is ticked, survives a rename, and clears', async ({ page }) => {
    const problems = collectPageProblems(page);
    const name = `ovr-files-${Date.now()}`;
    const id = await seedConnection(page, { name, kind: 'fs', config: { roots: ['/tmp'] } });
    const form = page.getByRole('form', { name: 'Connection form' });
    const allowlist = form.getByRole('group', { name: 'Overridable per node' });

    await openEdit(page, '/#/manage/connections', 'Connections', name);
    // `roots` is the confinement boundary: never offered.
    await expect(allowlist.getByRole('checkbox')).toHaveCount(2);
    await allowlist.getByLabel('Overridable: maxBytes', { exact: true }).check();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(await stored(page, `/api/connections/${id}`)).toEqual(['maxBytes']);

    await openEdit(page, '/#/manage/connections', 'Connections', name);
    await expect(allowlist.getByLabel('Overridable: maxBytes', { exact: true })).toBeChecked();
    await form.getByLabel('Name', { exact: true }).fill(`${name}-v2`);
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(await stored(page, `/api/connections/${id}`)).toEqual(['maxBytes']);

    await openEdit(page, '/#/manage/connections', 'Connections', `${name}-v2`);
    await allowlist.getByLabel('Overridable: maxBytes', { exact: true }).uncheck();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(await stored(page, `/api/connections/${id}`)).toEqual([]);

    await expectQuiet(page, problems);
  });

  test('a dataset’s allowlist is ticked, and a table dataset says it has none', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    const files = await seedConnection(page, {
      name: `ovr-fs-${stamp}`,
      kind: 'fs',
      config: { roots: ['/tmp'] },
    });
    const db = await seedConnection(page, {
      name: `ovr-db-${stamp}`,
      kind: 'sqlite',
      config: { roots: ['/tmp'], path: `/tmp/ovr-${stamp}.db` },
    });
    const csv = `ovr-csv-${stamp}`;
    const csvId = await seedDataset(page, {
      name: csv,
      kind: 'delimited',
      connectionId: files,
      config: { path: 'in.csv' },
      columns: [],
    });
    const tbl = `ovr-tbl-${stamp}`;
    await seedDataset(page, {
      name: tbl,
      kind: 'table',
      connectionId: db,
      config: { table: 'orders' },
      columns: [],
    });
    const form = page.getByRole('form', { name: 'Dataset form' });
    const allowlist = form.getByRole('group', { name: 'Overridable per node' });

    await openEdit(page, '/#/manage/datasets', 'Datasets', csv);
    await allowlist.getByLabel('Overridable: path', { exact: true }).check();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(await stored(page, `/api/datasets/${csvId}`)).toEqual(['path']);

    await openEdit(page, '/#/manage/datasets', 'Datasets', tbl);
    await expect(allowlist).toContainText('A table dataset has no settings a node can override.');
    await expect(allowlist.getByRole('checkbox')).toHaveCount(0);

    await expectQuiet(page, problems);
  });
});
