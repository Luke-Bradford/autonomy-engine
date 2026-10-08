import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { seedConnection, seedDataset } from './support/seedResources';
import { chooseRowAction, rowMenuButton } from './support/rowMenu';
import { createPipelineFromList, openImportDrawer } from './support/pipelinesPage';
import { mintVersion, seedVersion } from './support/seedDoc';
import { openNewConnection } from './support/newConnection';

/**
 * #959 — export and import, end to end through a real browser.
 *
 * What ONLY a browser can prove here, and why jsdom cannot: the export path is
 * a `Blob` + `URL.createObjectURL` + an anchor click, and jsdom implements
 * neither object URLs nor navigation — a unit test can assert the helper was
 * CALLED, but only a browser can show that a file actually reaches the disk,
 * with the intended name, containing the server's bytes. The import half then
 * feeds that same downloaded file back through a real `<input type="file">`,
 * which is the one part of the round trip no mock can stand in for.
 *
 * Every test creates its own pipeline under a per-test name: the suite is
 * single-worker over one shared SQLite file, and rows from earlier specs
 * persist, so nothing here counts rows globally.
 */

async function gotoPipelines(page: Page): Promise<void> {
  await page.goto('/#/author/pipelines');
  await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
  await fluentRootReady(page);
}

async function createPipeline(page: Page, name: string): Promise<void> {
  await createPipelineFromList(page, name);
  await expect(page.getByRole('link', { name: `Open ${name}`, exact: true })).toBeVisible();
}

test.describe('#959 portability', () => {
  test('exports a pipeline to a real file, then imports that file back', async ({ page }) => {
    const problems = collectPageProblems(page);
    const name = `Portable ${Date.now()}`;
    await gotoPipelines(page);
    await createPipeline(page, name);

    const downloadPromise = page.waitForEvent('download');
    await chooseRowAction(page, 'Export', name);
    const download = await downloadPromise;

    // The file name carries the resource id, which is what tells two
    // identically-named exports apart after an import round trip.
    expect(download.suggestedFilename()).toMatch(/^pipeline-portable-\d+-[\w-]+\.json$/);

    const file = await download.path();
    expect(file).not.toBeNull();

    // The bytes are the payload: what was saved must be the server's canonical
    // envelope, not a re-serialization of it.
    const saved = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of saved) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const envelope: unknown = JSON.parse(text);
    expect(envelope).toMatchObject({ kind: 'pipeline' });
    const raw = await page.request.get(
      `/api/pipelines/${encodeURIComponent(
        (envelope as { data: { pipeline: { id: string } } }).data.pipeline.id,
      )}/export`,
    );
    // `exportedAt` is stamped per REQUEST, so a second export is never
    // byte-identical to the first — comparing raw text passes only when both
    // land in the same millisecond, which is a test that fails at random. It is
    // the envelope's one volatile field (G1 excludes it from the content hash
    // for exactly this reason); EVERYTHING else, key order and spacing
    // included, must match exactly, which is what the download claim is about.
    expect(text).toMatch(/"exportedAt":\d+/); // …so the substitution is not vacuous
    const stable = (s: string) => s.replace(/"exportedAt":\d+/, '"exportedAt":0');
    expect(stable(text)).toBe(stable(await raw.text()));

    // …and now back in through the picker.
    await (await openImportDrawer(page)).getByLabel('Export file').setInputFiles(file as string);

    const outcome = page.getByRole('status');
    await expect(outcome).toContainText(`Imported pipeline “${name}”`);

    // The import minted a NEW id — the same name now names two pipelines, which
    // is exactly why the panel reports the id and why this assertion counts
    // rows rather than looking one up by name.
    //
    // Counted by the ROW's ⋯ menu button, not by the "Open" link: the outcome
    // panel renders an `Open <name>` link of its own, so a link count here is
    // 3 and says nothing about how many pipelines exist.
    await expect(rowMenuButton(page, name)).toHaveCount(2);

    await expectQuiet(page, problems);
  });

  // #1586 — the toolbar's Export: the pipelines SHOWN, as one file, which the
  // Import drawer reads back as every one of them, each with its own rebind.
  test('exports the shown pipelines as ONE file, and importing it restores them all', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const tag = `Bundled ${Date.now()}`;
    const bound = `${tag} bound`;
    const plain = `${tag} plain`;
    const connectionId = await seedConnection(page, {
      name: `${tag} conn`,
      kind: 'http',
      config: { baseUrl: 'https://example.invalid' },
    });
    await seedVersion(page, bound, {
      nodes: [{ id: 'call', connectionId, position: { x: 0, y: 0 } }],
    });
    await seedVersion(page, plain, { nodes: [{ id: 'call', position: { x: 0, y: 0 } }] });

    // Filtered to these two, so the file is exactly them whatever else the
    // shared database holds.
    await page.goto(`/#/author/pipelines?q=${encodeURIComponent(tag)}`);
    await fluentRootReady(page);
    await expect(rowMenuButton(page)).toHaveCount(2);

    const exportButton = page.getByRole('button', { name: 'Export', exact: true });
    await expect(exportButton).toHaveAttribute('aria-disabled', 'false');
    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^pipelines-\d{8}-\d{6}Z\.json$/);
    const file = await download.path();
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
    const bundle = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      kind: string;
      items: { data: { pipeline: { name: string } } }[];
    };
    expect(bundle.kind).toBe('bundle');
    expect(bundle.items.map((i) => i.data.pipeline.name).sort()).toEqual([bound, plain]);

    await (await openImportDrawer(page)).getByLabel('Export file').setInputFiles(file as string);

    const outcome = page.getByRole('status');
    await expect(outcome).toContainText('Imported 2 pipelines from one file.');
    await expect(outcome).toContainText(`Imported pipeline “${bound}”`);
    await expect(outcome).toContainText(`Imported pipeline “${plain}”`);
    // The bound pipeline's rebind, and only that one's.
    await expect(outcome.getByText(/Node “call” has no connection/)).toHaveCount(1);
    // Every pipeline is now there twice: the originals and the imports.
    await expect(rowMenuButton(page, bound)).toHaveCount(2);
    await expect(rowMenuButton(page, plain)).toHaveCount(2);

    await expectQuiet(page, problems);
  });

  // #1492 — a history version saved before #1480 (here: hand-edited, which the
  // save gate refuses exactly as it refuses a pre-#1480 row) no longer refuses
  // the whole import. The pipeline lands, and the outcome names the version
  // that cannot run.
  test('imports a pipeline whose history holds an unrunnable version, and names it', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const name = `Old history ${Date.now()}`;
    const copy = (mode: string) => ({
      nodes: [
        {
          id: 'load',
          type: 'copy',
          config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }], mode },
          position: { x: 0, y: 0 },
        },
      ],
    });
    const { pipelineId, pipelineVersionId } = await seedVersion(page, name, copy('append'));
    await mintVersion(page, pipelineId, copy('append'), pipelineVersionId, name);
    const exported = await page.request.get(
      `/api/pipelines/${encodeURIComponent(pipelineId)}/export`,
    );
    expect(exported.status()).toBe(200);
    const envelope = (await exported.json()) as {
      data: { versions: { nodes: { config: { mode: string } }[] }[] };
    };
    expect(envelope.data.versions).toHaveLength(2);
    envelope.data.versions[0]!.nodes[0]!.config.mode = 'truncate'; // history, not the head

    await gotoPipelines(page);
    await (await openImportDrawer(page)).getByLabel('Export file').setInputFiles({
      name: 'old-history.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(envelope)),
    });

    const outcome = page.getByRole('status');
    await expect(outcome).toContainText(`Imported pipeline “${name}”`);
    await expect(outcome).toContainText('Version 1 cannot run');
    await expect(outcome).toContainText("node 'load': config.mode");
    await expect(rowMenuButton(page, name)).toHaveCount(2);

    await expectQuiet(page, problems);
  });

  test('refuses a file that is not an envelope, without creating anything', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoPipelines(page);
    const before = await rowMenuButton(page).count();

    await (await openImportDrawer(page)).getByLabel('Export file').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not an export'),
    });

    await expect(page.getByRole('alert')).toContainText('is not a JSON file');
    expect(await rowMenuButton(page).count()).toBe(before);

    await expectQuiet(page, problems);
  });

  /**
   * The attention[] honesty surface, end to end.
   *
   * The pipeline test above cannot reach it: an empty pipeline has no nodes, so
   * its import returns `attention: []`. A connection ALWAYS does — the export
   * ships `requiresSecret: secretRef !== null` and never the ciphertext, so an
   * import of a connection that HAD a secret arrives with none and says so.
   * That sentence is the whole reason a "created" message would be a lie: the
   * imported connection cannot call a provider until the operator re-enters it.
   */
  test('exports a connection, and the re-import says the secret did not travel', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const name = `Portable conn ${Date.now()}`;

    await page.goto('/#/manage/connections');
    await page.getByRole('heading', { name: 'Connections' }).waitFor();
    await fluentRootReady(page);

    await openNewConnection(page, 'anthropic_api');
    const form = page.getByRole('form', { name: 'Connection form' });
    await form.getByLabel('Name').fill(name);
    // A secret IS typed, so `secretRef !== null` server-side — which is the
    // precondition for the attention item this test exists to prove.
    await form.getByLabel('Secret', { exact: true }).fill('sk-not-exported');
    await form.getByRole('button', { name: 'Create connection' }).click();
    await expect(rowMenuButton(page, name)).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await chooseRowAction(page, 'Export', name);
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^connection-portable-conn-\d+-[\w-]+\.json$/);

    const file = await download.path();
    expect(file).not.toBeNull();

    // The bytes must be the server's canonical envelope, not a re-serialization
    // — and they must carry no secret material at all.
    const saved = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of saved) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).not.toContain('sk-not-exported');
    expect(JSON.parse(text)).toMatchObject({ kind: 'connection' });

    await page.getByLabel('Export file').setInputFiles(file as string);

    const outcome = page.getByRole('status');
    await expect(outcome).toContainText(`Imported connection “${name}”`);
    // The honesty surface: not "created", but "created and it cannot run yet".
    await expect(outcome).toContainText('needs its secret');

    // Two rows with the same name now — the import minted a fresh id and does
    // not dedupe by name, which is why the panel reports the id.
    await expect(rowMenuButton(page, name)).toHaveCount(2);

    await expectQuiet(page, problems);
  });

  // #1143 — a dataset cannot exist without a store, so its import is the one
  // that must be TOLD where to land (or resolve it by identity). Both paths,
  // through the real file the row's Export saved.
  test('exports a dataset, and re-imports it into a chosen store and by identity', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    const name = `Portable ds ${stamp}`;
    const srcStore = `Src store ${stamp}`;
    const destStore = `Dest store ${stamp}`;

    await page.goto('/#/manage/datasets');
    const srcId = await seedConnection(page, { name: srcStore, kind: 'fs', config: {} });
    await seedConnection(page, { name: destStore, kind: 'fs', config: {} });
    await seedDataset(page, {
      name,
      kind: 'delimited',
      connectionId: srcId,
      config: { path: 'customers.csv' },
      columns: [{ name: 'id', type: 'integer', nullable: false }],
    });
    await page.reload();
    await page.getByRole('heading', { name: 'Datasets' }).waitFor();
    await fluentRootReady(page);

    const downloadPromise = page.waitForEvent('download');
    await chooseRowAction(page, 'Export', name);
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^dataset-portable-ds-\d+-[\w-]+\.json$/);
    const file = await download.path();
    expect(file).not.toBeNull();

    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(envelope).toMatchObject({ kind: 'dataset', data: { name } });
    // The store travels as its portable identity, never this workspace's key.
    expect(envelope.data.connectionId).not.toBe(srcId);
    expect(envelope.data.connectionId).toMatch(/^res_/);

    const rows = page.getByRole('row').filter({ hasText: name });

    // 1. Into a CHOSEN store — the cross-workspace path.
    await page.getByLabel('Store it in').selectOption({ label: `${destStore} (File system)` });
    await page.getByLabel('Export file').setInputFiles(file as string);
    await expect(page.getByRole('status')).toContainText(`Imported dataset “${name}”`);
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: destStore })).toHaveCount(1);

    // 2. With no choice — resolved by identity to the store it came from.
    await page
      .getByLabel('Store it in')
      .selectOption({ label: 'The connection it was exported from' });
    await page.getByLabel('Export file').setInputFiles(file as string);
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: srcStore })).toHaveCount(2);

    await expectQuiet(page, problems);
  });
});
