import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1393 (OR2) — "When I make an edit, the page shifts around."
 *
 * Every notice the editor raised used to be its own sibling above or below the
 * canvas, and the dock is a share of the canvas area, so each one arriving or
 * leaving moved the canvas, the dock AND the field under the operator's
 * pointer. A field error replaced its hint and pushed the fields below it.
 *
 * The property is geometric, so it is asserted as geometry: the boxes of the
 * canvas, the dock, the dock's first field, a field BELOW the one that raises an
 * error, and the Save button (which now carries the dirty mark) are recorded
 * once and must not move by more than a pixel through the whole edit cycle the
 * issue names. jsdom computes no layout; only a browser can say this.
 */

const boxes = {
  canvas: (page: Page) => page.locator('.canvas-wrap'),
  dock: (page: Page) => page.locator('.property-dock'),
  firstField: (page: Page) =>
    properties(page).locator('input:visible, textarea:visible, select:visible').first(),
  // #1477 OR29 — Retry interval now packs beside Retries; Secure input is
  // the first control on the row below.
  belowRetries: (page: Page) => properties(page).getByRole('checkbox', { name: 'Secure input' }),
  save: (page: Page) => page.getByRole('button', { name: 'Save version' }),
};

type Box = { x: number; y: number; width: number; height: number };

async function measure(page: Page): Promise<Record<keyof typeof boxes, Box>> {
  const out = {} as Record<keyof typeof boxes, Box>;
  for (const [name, locate] of Object.entries(boxes) as [
    keyof typeof boxes,
    (p: Page) => ReturnType<Page['locator']>,
  ][]) {
    const box = await locate(page).boundingBox();
    expect(box, `${name} is on screen`).not.toBeNull();
    out[name] = box!;
  }
  return out;
}

async function expectUnmoved(page: Page, baseline: Record<string, Box>, step: string) {
  const now = await measure(page);
  for (const [name, box] of Object.entries(now)) {
    const was = baseline[name]!;
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(
        Math.abs(box[k] - was[k]),
        `${name}.${k} after "${step}" (was ${String(was[k])}, now ${String(box[k])})`,
      ).toBeLessThanOrEqual(1);
    }
  }
}

test.describe('#1393 the editor does not shift when you edit', () => {
  test('canvas, dock and fields hold still through edit, error, fix, paste, issue and save', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'or2 no shift', {
      nodes: [{ id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
    });

    await page.getByTestId('rf__node-a').click();
    // General, where Retries lives. The tab choice survives a change of
    // selection, so every node selected below shows the same form.
    await properties(page).getByRole('tab', { name: 'General' }).click();
    const retries = properties(page).getByRole('textbox', { name: 'Retries' });
    await expect(retries).toBeVisible();
    const baseline = await measure(page);
    const title = await page.title();
    expect(title.startsWith('•')).toBe(false);

    // 1. An edit. It used to add "Unsaved changes" UNDER the canvas.
    await retries.fill('2');
    await retries.blur();
    await expect(page.locator('.dirty-dot')).toHaveCSS('visibility', 'visible');
    await expect(page).toHaveTitle(`• ${title}`);
    await expectUnmoved(page, baseline, 'edit');

    // 2. An invalid value, blurred. Its error used to replace the hint.
    await retries.fill('x');
    await retries.blur();
    await expect(properties(page).getByRole('alert')).toBeVisible();
    await expect(retries).toHaveAttribute('aria-invalid', 'true');
    await expectUnmoved(page, baseline, 'blur invalid');

    // 3. Fixed — and the error goes as soon as it is fixed.
    await retries.fill('3');
    await expect(properties(page).getByRole('alert')).toHaveCount(0);
    await retries.blur();
    await expectUnmoved(page, baseline, 'fix');

    // 4. Copy and paste, whose six-second notice used to shrink the canvas and
    // grow it back.
    await page.getByTestId('rf__node-a').click();
    await page.keyboard.press('Meta+c');
    await expect(page.getByText('Copied 1 activity.')).toBeVisible();
    await expectUnmoved(page, baseline, 'copy');
    await page.keyboard.press('Meta+v');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expectUnmoved(page, baseline, 'paste');

    // 5. A node the validator refuses. The issue list used to grow above the
    // canvas by one line per issue; it is the Problems column now.
    await addActivity(page, 'Execute pipeline');
    const problemsList = page.getByRole('complementary', { name: 'Problems' });
    await expect(problemsList.locator('.badge-list li')).toContainText(['needs a call config']);
    await expect(boxes.save(page)).toBeDisabled();
    // Announced from the dock header, which stays shown when the list folds.
    await expect(page.locator('.property-dock__header [role="status"]')).toHaveText(
      '1 validation issue(s) — fix these to save.',
    );
    // Save's description keeps the refusal reason beside the dirty note.
    await expect(boxes.save(page)).toHaveAccessibleDescription(
      'Unsaved changes Fix the 1 validation issue(s) in the Problems panel to save.',
    );
    await expectUnmoved(page, baseline, 'validation issue');

    // Undone, so the doc can save again.
    await page.getByTestId('rf__node-a').click();
    await page.keyboard.press('Meta+z');
    await expect(problemsList.getByText('No problems.')).toBeVisible();
    await expectUnmoved(page, baseline, 'undo');

    // 6. Saved. The message lands in the strip, and the dirty marks clear.
    await boxes.save(page).click();
    await expect(page.locator('.notice', { hasText: 'Saved v2.' })).toBeVisible();
    await expect(page.locator('.dirty-dot')).toHaveCSS('visibility', 'hidden');
    await expect(page).toHaveTitle(title);
    // A save reloads the working graph, which drops the selection; the same
    // node re-selected must come back to the same place.
    await page.getByTestId('rf__node-a').click();
    await expect(retries).toBeVisible();
    await expectUnmoved(page, baseline, 'save');

    await expectQuiet(page, problems);
  });
});
