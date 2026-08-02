import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, viewportSettled } from './support/canvasGraph';
import { fluentRootReady } from './support/theme';
import { mintVersion, nodeById, seedVersion, type SeedDoc } from './support/seedDoc';

/**
 * U22 slice 1 (#903) — a pipeline's version history, end to end.
 *
 * Every Save mints an immutable version and the canvas only ever opened the
 * newest one, so the rest were unreachable from the app that made them. Three
 * of the properties below cannot be reached by a unit test at all: React Flow
 * does not render in jsdom, so "the preview shows v1's graph", "the editor is
 * UNMOUNTED behind it" and "the restored POSITIONS reach the screen" are all
 * only checkable here.
 *
 * That last one is the sharp edge. React Flow owns a node's position once its id
 * is in the view array, so a restore into a LIVE canvas would write the restored
 * geometry to the domain and leave the head's on screen — a half-applied restore
 * that a doc-level assertion would call a pass. The spec asserts the RELATIVE
 * order of two nodes rather than absolute coordinates, because `fitView`
 * re-centres and re-zooms asynchronously and absolute screen coords are a
 * moving target.
 */

/** `n_a` LEFT of `n_b` — what v1 says, and what a restore must put back. */
const V1: SeedDoc = {
  nodes: [
    { id: 'n_a', position: { x: 0, y: 0 } },
    { id: 'n_b', position: { x: 320, y: 0 } },
  ],
  edges: [{ from: 'n_a', to: 'n_b', on: 'success' }],
};

/** `n_a` RIGHT of `n_b`, plus a third node v1 never had. */
const V3: SeedDoc = {
  nodes: [
    { id: 'n_a', position: { x: 320, y: 0 } },
    { id: 'n_b', position: { x: 0, y: 0 } },
    { id: 'n_c', position: { x: 640, y: 0 } },
  ],
  edges: [{ from: 'n_b', to: 'n_a', on: 'success' }],
};

/**
 * v2 gives the list a middle row that is neither head nor first — and it is the
 * version the preview-switch test lands on SECOND, so it deliberately differs
 * from v1 by a node the first preview never drew.
 */
const V2: SeedDoc = {
  nodes: [
    { id: 'n_a', position: { x: 0, y: 0 } },
    { id: 'n_b', position: { x: 320, y: 0 } },
    { id: 'n_c', position: { x: 640, y: 0 } },
  ],
  edges: [{ from: 'n_a', to: 'n_b', on: 'success' }],
};

/** Seed one pipeline carrying three versions, and open its canvas on the head. */
async function seedThreeVersions(page: Page, name: string): Promise<string> {
  const { pipelineId } = await seedVersion(page, name, V1);
  await mintVersion(page, pipelineId, V2, name);
  await mintVersion(page, pipelineId, V3, name);

  await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
  await fluentRootReady(page);
  await page.locator('.react-flow__renderer').waitFor();
  await expect(nodeById(page, 'n_c')).toHaveClass(/\bdraggable\b/);
  await viewportSettled(page);
  return pipelineId;
}

/** The left edge of one node's box, in screen coords. */
async function leftOf(page: Page, id: string): Promise<number> {
  const box = await nodeById(page, id).boundingBox();
  expect(box, `node ${id} has no box`).not.toBeNull();
  return box!.x;
}

const historyButton = (page: Page) => page.getByRole('button', { name: 'Version history' });
const rows = (page: Page) => page.locator('.version-history-row');

test.describe('pipeline version history', () => {
  test('lists every version newest-first, marking the latest and the one on the canvas', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await seedThreeVersions(page, 'history-list');

    await expect(page.getByTestId('version-history')).toHaveCount(0);

    // While collapsed the panel is UNMOUNTED, so the toggle must not name it:
    // an `aria-controls` pointing at an absent id resolves to nothing for a
    // screen reader. `aria-expanded` is what carries the closed state.
    await expect(historyButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(historyButton(page)).not.toHaveAttribute('aria-controls', /./);

    await historyButton(page).click();

    // Open, it names the panel AND that id is really in the DOM.
    await expect(historyButton(page)).toHaveAttribute('aria-expanded', 'true');
    const controls = await historyButton(page).getAttribute('aria-controls');
    expect(controls).toBe('version-history-panel');
    await expect(page.locator(`#${controls}`)).toHaveCount(1);

    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(0)).toContainText('v3');
    await expect(rows(page).nth(1)).toContainText('v2');
    await expect(rows(page).nth(2)).toContainText('v1');

    // The head is BOTH the latest and what the editor is based on, until a
    // preview parts them.
    await expect(rows(page).nth(0)).toContainText('latest');
    await expect(rows(page).nth(0)).toContainText('on the canvas');
    await expect(rows(page).nth(2)).not.toContainText('latest');

    // The shape summary is what an operator picks between — v1 had two nodes,
    // the head has three.
    await expect(rows(page).nth(0)).toContainText('3 nodes');
    await expect(rows(page).nth(2)).toContainText('2 nodes');

    await expectQuiet(page, problems);
  });

  test('previews a version read-only, with the editor unmounted and no run vocabulary', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await seedThreeVersions(page, 'history-preview');
    await historyButton(page).click();
    await rows(page).nth(2).click();

    await expect(page.getByTestId('version-preview-bar')).toContainText('Viewing v1');
    await expect(page.getByTestId('version-preview-bar')).toContainText('read-only');

    /* The editor is GONE, not hidden. That is what makes the restore below able
       to put the restored positions on screen. */
    await expect(page.locator('.canvas-grid')).toHaveCount(0);
    await expect(page.getByTestId('run-canvas')).toBeVisible();

    // v1's graph, not the head's: two nodes and no `n_c`.
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(nodeById(page, 'n_c')).toHaveCount(0);

    /* There is no run behind a stored version, so the monitor's "not projected"
       would describe a run that does not exist. Asserted on the accessible name
       too, which is where it survived being dropped from the drawn box. */
    await expect(page.locator('.canvas-preview')).not.toContainText('not projected');
    const ariaLabels = await page
      .locator('.react-flow__node')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    expect(ariaLabels.every((l) => l.length > 0)).toBe(true);
    expect(ariaLabels.some((l) => l.includes('not projected'))).toBe(false);

    // Saving the working graph is meaningless while looking at another version.
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await page.getByRole('button', { name: 'Back to editing' }).click();
    await expect(page.locator('.canvas-grid')).toHaveCount(1);
    await expect(nodeById(page, 'n_c')).toBeVisible();

    await expectQuiet(page, problems);
  });

  /**
   * Switching straight from one preview to another, without going back to the
   * editor in between.
   *
   * `RunCanvas` was built for the monitor, where `doc` is immutable for the
   * component's whole lifetime — so swapping `doc` on a LIVE instance leaves
   * state nothing rebuilds. `mergeRunNodes` keeps a node whole when its `data`
   * and position are unchanged, and `fitView` only runs on init. This is the
   * case the first version of this spec never reached, because it only ever
   * opened v1.
   */
  test('shows the version it is switched TO, not a hybrid of the two', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedThreeVersions(page, 'history-switch');
    await historyButton(page).click();

    // v1 — two nodes, `n_a` left of `n_b`.
    await rows(page).nth(2).click();
    await viewportSettled(page);
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    expect(await leftOf(page, 'n_a')).toBeLessThan(await leftOf(page, 'n_b'));

    // Straight to v2 — three nodes, and `n_c` is one this canvas has never drawn.
    await rows(page).nth(1).click();
    await viewportSettled(page);
    await expect(page.getByTestId('version-preview-bar')).toContainText('Viewing v2');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    // Visible, not merely present: a viewport left at v1's fit would leave the
    // third node culled by `onlyRenderVisibleElements`.
    await expect(nodeById(page, 'n_c')).toBeVisible();

    // And back down to v1, so the shrink direction is covered too.
    await rows(page).nth(2).click();
    await viewportSettled(page);
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(nodeById(page, 'n_c')).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('restores an old version as a new head — contents AND positions', async ({ page }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await seedThreeVersions(page, 'history-restore');

    // The head draws `n_a` to the RIGHT of `n_b`. v1 says the opposite.
    expect(await leftOf(page, 'n_a')).toBeGreaterThan(await leftOf(page, 'n_b'));

    await historyButton(page).click();
    await rows(page).nth(2).click();

    page.once('dialog', (d) => {
      // The confirmation must state what is created and that nothing is lost —
      // an operator who thinks this discards their later work will not press it.
      expect(d.message()).toContain('v1');
      expect(d.message()).toContain('v4');
      expect(d.message()).toContain('kept');
      void d.accept();
    });
    await page.getByRole('button', { name: 'Restore v1' }).click();

    await expect(page.locator('.notice')).toContainText('Restored v1 as v4');
    // Back in the editor, on the restored version.
    await expect(page.locator('.canvas-grid')).toHaveCount(1);
    await expect(page.getByTestId('version-preview-bar')).toHaveCount(0);

    await viewportSettled(page);
    // v1's graph is what is now editable: `n_c` is gone…
    await expect(nodeById(page, 'n_c')).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    // …and v1's GEOMETRY reached the screen, which a stale React Flow view
    // array would have silently withheld while the DB held the right answer.
    expect(await leftOf(page, 'n_a')).toBeLessThan(await leftOf(page, 'n_b'));

    // The restore ADDED a version; nothing was overwritten.
    const listed = await page.request.get(
      `/api/pipelines/${encodeURIComponent(pipelineId)}/versions`,
    );
    const versions = (await listed.json()) as {
      version: number;
      nodes: { id: string; position: { x: number; y: number } }[];
    }[];
    expect(versions.map((v) => v.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    const v4 = versions.find((v) => v.version === 4)!;
    const v1 = versions.find((v) => v.version === 1)!;
    expect(v4.nodes).toEqual(v1.nodes);

    await expectQuiet(page, problems);
  });

  /**
   * The data-loss window the review of this PR found. A restore rebases the
   * canvas onto the version it mints, and that is only safe into an editor that
   * is NOT mounted — every route out of the preview remounts one, so an operator
   * who leaves mid-flight and types has work the arriving response overwrites.
   *
   * Only reachable here: it needs a REAL in-flight request, held open, which is
   * exactly what a unit test cannot give. There are three such routes and the
   * finding named one, so all three are asserted.
   */
  test('locks every route out of the preview while a restore is in flight', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedThreeVersions(page, 'history-inflight');

    // Hold the POST open so the in-flight window is observable at all. Only the
    // POST — the GET that lists versions must still answer, or the page never
    // reaches the state under test.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/pipelines/*/versions', async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    });

    await historyButton(page).click();
    await rows(page).nth(2).click();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Restore v1' }).click();

    // In flight: the restore is running…
    await expect(page.getByRole('button', { name: 'Restoring…' })).toBeDisabled();
    // …and NO exit is live. Back to editing is the one the review named.
    const back = page.getByRole('button', { name: 'Back to editing' });
    await expect(back).toBeDisabled();
    // The history toggle clears the preview as it closes — the same exit
    // wearing a different button.
    await expect(historyButton(page)).toBeDisabled();
    // A row toggles the preview: off entirely, or across to another version.
    await expect(rows(page)).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(rows(page).nth(i)).toBeDisabled();

    /* The property all four exist to hold: the editor is still not mounted, so
       there is no canvas holding edits for the response to overwrite. */
    await expect(page.locator('.canvas-grid')).toHaveCount(0);

    release();

    // Released, it completes normally and hands the controls back.
    await expect(page.locator('.notice')).toContainText('Restored v1 as v4');
    await expect(page.getByTestId('version-preview-bar')).toHaveCount(0);
    await expect(page.locator('.canvas-grid')).toHaveCount(1);
    await expect(historyButton(page)).toBeEnabled();

    await expectQuiet(page, problems);
  });

  test('refuses to restore while the canvas has unsaved edits', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedThreeVersions(page, 'history-refusal');

    await addActivity(page, 'HTTP Request');
    await expect(page.getByText(/Unsaved changes/)).toBeVisible();

    await historyButton(page).click();
    await rows(page).nth(2).click();

    /* Refused rather than discarded: the canvas reloads onto the version a
       restore mints, so unsaved work would go with it. The reason has to be on
       the control itself, not only in the prose beside it. */
    const restore = page.getByRole('button', { name: 'Restore v1' });
    await expect(restore).toBeDisabled();
    await expect(page.getByTestId('version-preview-bar')).toContainText('unsaved changes');

    await expectQuiet(page, problems);
  });
});
