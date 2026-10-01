import { expect, test } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { canvasNodes, toolbox, validationIssues } from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * #1413 OR22 / #1420 part 4 — an empty canvas says where to start, and offers
 * starter templates. The CSV template's RUN is proven by
 * `foreach-copy-folder.spec.ts`, which builds its pipeline from the same
 * template; this spec owns what the operator sees on an empty canvas.
 */
test.describe('starter templates on an empty canvas (#1413)', () => {
  test('one click lays out the CSV-folder recipe, in view, and Undo brings the guide back', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    /* NARROW on purpose: at the default size the laid-out recipe happens to fit
       at zoom 1 with no help, so "in view" would hold without the fit-on-insert
       it is here to prove (mutation-checked: it survived at the default size). */
    await page.setViewportSize({ width: 1000, height: 700 });
    await openCanvas(page, 'e2e 1413 csv template');

    const guide = page.getByRole('region', { name: 'Start this pipeline' });
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('Drag one here from the Activities palette');
    const csv = guide.getByRole('button', { name: /^Load every CSV in a folder into a table/ });
    await expect(csv).toHaveAccessibleDescription(/^List a folder, keep its CSV files/);

    /* The overlay must not eat the pane's gestures: transparent to the pointer
       everywhere but its buttons. Computed, because that is what the browser
       hit-tests against. */
    const pointer = await guide.evaluate((el) => ({
      region: getComputedStyle(el).pointerEvents,
      button: getComputedStyle(el.querySelector('button')!).pointerEvents,
      position: getComputedStyle(el).position,
    }));
    expect(pointer).toEqual({ region: 'none', button: 'auto', position: 'absolute' });

    await csv.click();
    await expect(guide).toHaveCount(0);
    // Three activities and the ForEach box around the Copy — all fitted in view.
    await expect(canvasNodes(page)).toHaveCount(4);
    for (const node of await canvasNodes(page).all()) await expect(node).toBeInViewport();
    await expect(
      page.getByRole('group', { name: /^ForEach 1 container, 1 activity/ }),
    ).toBeVisible();
    // The one thing still to do before it saves is the operator's own: bind a dataset.
    await expect
      .poll(() => validationIssues(page))
      .toEqual([expect.stringMatching(/bind a dataset/)]);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(canvasNodes(page)).toHaveCount(0);
    await expect(guide).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('a palette drop onto the guide places the activity, as on a bare canvas', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e 1413 drop through guide');

    const guide = page.getByRole('region', { name: 'Start this pipeline' });
    const target = guide.getByRole('button', { name: /^Summarise every document/ });
    await toolbox(page).getByRole('button', { name: 'HTTP Request', exact: true }).dragTo(target);

    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(guide).toHaveCount(0);
    await expectQuiet(page, problems);
  });
});
