import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { editorMenuItem, openCanvas } from './support/canvas';
import { answerConfirm } from './support/confirmDialog';

/**
 * #907 — an ARCHIVED pipeline refuses every save, the canvas says so before the
 * work happens, and the same banner carries the way back out.
 *
 * Why this needs a browser at all. The two unit suites each cover one side and
 * neither can cover the seam: the server test proves the route 409s, and the
 * route test proves `archived` reaches the canvas — but the canvas is mocked
 * there (it is React-Flow-heavy), so nothing in vitest renders the banner, its
 * button, or the message the refusal actually produces. The failure this guards
 * against is precisely the seam one: a banner that never renders, or an
 * Unarchive button wired to a route that answers 409, would pass every unit run
 * in the repo.
 */

/** The pipeline id out of the canvas's own URL (`#/author/pipelines/<id>`). */
function pipelineIdFrom(url: string): string {
  const id = url.split('/').pop();
  expect(id, `no pipeline id in canvas url ${url}`).toBeTruthy();
  return id!;
}

test.describe('#907 an archived pipeline cannot be saved, and says so', () => {
  test('warns, refuses the save, then unarchives back to an editable canvas', async ({ page }) => {
    const problems = collectPageProblems(page);

    await openCanvas(page, 'e2e 907 archived');
    const canvasUrl = page.url();
    const pipelineId = pipelineIdFrom(canvasUrl);

    // Not archived yet: the banner must be ABSENT, or the assertions below
    // would pass against a banner that is simply always on screen.
    const banner = page.getByRole('alert').filter({ hasText: 'This pipeline is archived' });
    await expect(banner).toHaveCount(0);

    // Archived over the API, deliberately, even though #1058 has since given
    // the pipelines list an Archive button. This spec is the CANVAS narrative:
    // it is about what an already-archived pipeline does to the editing
    // surface, and reaching that state through the UI would make every
    // assertion below depend on the list page too. The list surface has its own
    // spec (`archive-from-list.spec.ts`).
    const archived = await page.request.post(`/api/pipelines/${pipelineId}/archive`);
    expect(archived.status()).toBe(200);

    // The route fetches once at mount, so the open canvas cannot know yet —
    // reload to get the answer the next visitor would get.
    await page.reload();
    await page.locator('.react-flow__renderer').waitFor();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('saving is refused');
    // The banner states the ONE thing a reader would otherwise assume wrongly:
    // unarchiving does not re-arm what archiving switched off.
    await expect(banner).toContainText('triggers stay disabled');

    // The refusal is REAL, not just advertised — the server is the authority
    // and this is the only assertion that touches it end to end.
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.getByText(/Save failed:.*archived/i)).toBeVisible();
    await expect(page.getByText(/unarchive it first/i)).toBeVisible();

    // The way back, from the banner itself.
    await page.getByRole('button', { name: 'Unarchive pipeline' }).click();
    await expect(banner).toHaveCount(0);

    // And the canvas is genuinely editable again — the same save now lands,
    // which is what makes the banner's disappearance mean something rather
    // than just being a hidden element.
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.getByText(/Saved v\d+/i)).toBeVisible();

    // The 409 is provoked ON PURPOSE, so the browser's own network entry for it
    // is expected output rather than a regression.
    await expectQuiet(page, problems, [/Failed to load resource.*409/]);
  });

  /**
   * #1397 — Archive from the editor's ⋯ menu. Through the SAME confirmation the
   * pipelines list asks, then straight into the banner above: the route adopts
   * the archived row, so no reload is needed for the canvas to know.
   */
  test('archives from the ⋯ menu, after asking, and the banner follows', async ({ page }) => {
    const problems = collectPageProblems(page);
    const name = `e2e 1397 archive ${Date.now()}`;
    await openCanvas(page, name);
    const banner = page.getByRole('alert').filter({ hasText: 'This pipeline is archived' });
    const paneRow = page.locator('.factory-resources').getByRole('link', { name, exact: true });
    await expect(banner).toHaveCount(0);
    await expect(paneRow).toHaveCount(1);

    // Cancel leaves it alone.
    await (await editorMenuItem(page, /^Archive/)).click();
    await answerConfirm(page, 'cancel');
    await expect(banner).toHaveCount(0);

    // A refused archive says so, and leaves the pipeline as it was.
    const archiveRoute = '**/api/pipelines/*/archive';
    await page.route(archiveRoute, (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
    );
    await (await editorMenuItem(page, /^Archive/)).click();
    await answerConfirm(page, 'accept');
    await expect(page.getByRole('status').filter({ hasText: 'Could not archive' })).toBeVisible();
    await expect(banner).toHaveCount(0);
    await page.unroute(archiveRoute);

    await (await editorMenuItem(page, /^Archive/)).click();
    const asked = await answerConfirm(page, 'accept');
    expect(asked).toContain(`Archive pipeline "${name}"?`);
    expect(asked).toContain('this is not a delete');

    await expect(banner).toBeVisible();
    // It left the side pane's list, which lists live pipelines only.
    await expect(paneRow).toHaveCount(0);
    // And the menu will not archive it twice — it says why.
    const again = await editorMenuItem(page, /^Archive/);
    await expect(again).toBeDisabled();
    await expect(again).toContainText('already archived');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Unarchive pipeline' }).click();
    await expect(banner).toHaveCount(0);
    await expect(paneRow).toHaveCount(1);

    // The 500 above is provoked on purpose.
    await expectQuiet(page, problems, [/Failed to load resource.*500/]);
  });
});
