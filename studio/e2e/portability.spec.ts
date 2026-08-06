import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

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
  const form = page.getByRole('form', { name: 'New pipeline' });
  await form.getByLabel('Name').fill(name);
  await form.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(page.getByRole('link', { name: `Open ${name}`, exact: true })).toBeVisible();
}

test.describe('#959 portability', () => {
  test('exports a pipeline to a real file, then imports that file back', async ({ page }) => {
    const problems = collectPageProblems(page);
    const name = `Portable ${Date.now()}`;
    await gotoPipelines(page);
    await createPipeline(page, name);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: `Export ${name}`, exact: true }).click();
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
    await page.getByLabel('Export file').setInputFiles(file as string);

    const outcome = page.getByRole('status');
    await expect(outcome).toContainText(`Imported pipeline “${name}”`);

    // The import minted a NEW id — the same name now names two pipelines, which
    // is exactly why the panel reports the id and why this assertion counts
    // rows rather than looking one up by name.
    //
    // Counted by the ROW's Export button, not by the "Open" link: the outcome
    // panel renders an `Open <name>` link of its own, so a link count here is
    // 3 and says nothing about how many pipelines exist.
    await expect(page.getByRole('button', { name: `Export ${name}`, exact: true })).toHaveCount(2);

    await expectQuiet(page, problems);
  });

  test('refuses a file that is not an envelope, without creating anything', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoPipelines(page);
    const before = await page.getByRole('button', { name: /^Export / }).count();

    await page.getByLabel('Export file').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not an export'),
    });

    await expect(page.getByRole('alert')).toContainText('is not a JSON file');
    expect(await page.getByRole('button', { name: /^Export / }).count()).toBe(before);

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

    await page.getByRole('button', { name: 'New connection' }).click();
    const form = page.getByRole('form', { name: 'Connection form' });
    await form.getByLabel('Name').fill(name);
    // A secret IS typed, so `secretRef !== null` server-side — which is the
    // precondition for the attention item this test exists to prove.
    await form.getByLabel('Secret').fill('sk-not-exported');
    await form.getByRole('button', { name: 'Create connection' }).click();
    await expect(page.getByRole('button', { name: `Export ${name}`, exact: true })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: `Export ${name}`, exact: true }).click();
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
    await expect(page.getByRole('button', { name: `Export ${name}`, exact: true })).toHaveCount(2);

    await expectQuiet(page, problems);
  });
});
