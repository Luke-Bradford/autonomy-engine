import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openCanvas } from './support/canvas';

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

    // Archive it the way the product does — the API. There is no archive UI
    // (that is #439 UI work); the state is reachable by API and git import, and
    // it is the state this ticket is about.
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
});
