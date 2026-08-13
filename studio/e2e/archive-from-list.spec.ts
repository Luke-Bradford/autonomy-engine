import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #1058 — a pipeline can be RETIRED from the app, and brought back.
 *
 * Why this needs a browser. The unit suites each cover one side and neither can
 * cover the seam: the server test proves `?archived=true` selects the archived
 * set, and `PipelinesPage.test.tsx` proves the page calls the right functions —
 * but every API function is mocked there, so nothing in vitest checks that the
 * archived list the page renders is the one the server actually answers with.
 * The failure this guards against is exactly that: an Archive button whose row
 * never reappears under Show archived would pass every unit run in the repo,
 * and would be a one-way trap in the product.
 *
 * The CANVAS side of archive (a save refused, the banner, its own Unarchive) is
 * `archived-pipeline.spec.ts` — that one archives over the API on purpose.
 */

/** Unique per run: the suite is single-worker over ONE shared SQLite file, and
 *  earlier specs leave their pipelines behind. A substring collision here would
 *  read as "the Archive button is missing". */
const NAME = 'e2e 1058 retire me';

test.describe('#1058 archive from the pipelines list, and unarchive back', () => {
  test('archives, disappears from the list, and comes back from Show archived', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);

    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);

    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(NAME);
    await page.getByRole('button', { name: 'Create pipeline' }).click();

    const archiveButton = page.getByRole('button', { name: `Archive ${NAME}`, exact: true });
    await expect(archiveButton).toBeVisible();

    // The confirm is the only place the consequences can be stated — the route
    // discards the trigger ids it disabled. Capture the real dialog text rather
    // than trusting the builder's unit test, which is what makes this the seam.
    let confirmText = '';
    page.once('dialog', (dialog) => {
      confirmText = dialog.message();
      void dialog.accept();
    });
    await archiveButton.click();

    // Gone from the live list — the actual retirement.
    await expect(archiveButton).toHaveCount(0);
    expect(confirmText).toContain(NAME);
    expect(confirmText).toMatch(/run history are KEPT/i);
    expect(confirmText).toContain('triggers stay disabled');
    expect(confirmText).toMatch(/Commit will delete its file/);

    // The way back. Closed by default, so nothing was fetched until now.
    await page.getByRole('button', { name: 'Show archived' }).click();
    const unarchiveButton = page.getByRole('button', { name: `Unarchive ${NAME}`, exact: true });
    await expect(unarchiveButton).toBeVisible();

    await unarchiveButton.click();

    // Back in the live list, and out of the archived one — which is what makes
    // the round trip mean something rather than just rendering two tables.
    await expect(archiveButton).toBeVisible();
    await expect(unarchiveButton).toHaveCount(0);

    await expectQuiet(page, problems);
  });
});
