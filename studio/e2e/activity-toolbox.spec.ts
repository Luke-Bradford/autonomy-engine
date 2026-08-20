import { expect, test, type Locator, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { canvasNodes, toolbox } from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * U5 — the Activities toolbox and its drag-drop onto the canvas.
 *
 * What only a real browser can prove here is the whole drag half. jsdom
 * implements no `DataTransfer` and fires no native drag events, so every unit
 * test of a drop has to hand-build the event — which means the unit suite can
 * verify the HANDLERS but can never verify that a real drag reaches them, that
 * the payload survives the browser's drag-data store, or that the node lands
 * where the pointer released it under React Flow's live viewport transform.
 *
 * Playwright's `dragTo` is what drives HTML5 drag-and-drop in Chromium; a
 * hand-rolled `mouse.down/move/up` (the idiom `shell-pane.spec.ts` correctly
 * uses for the POINTER-events splitter) fires no drag events at all and would
 * produce a spec that passes by doing nothing.
 */

/** The canvas pane — React Flow's own background surface, not its chrome. */
function canvasPane(page: Page): Locator {
  return page.locator('.react-flow__pane');
}

test.describe('U5 activities toolbox', () => {
  test('filters the catalog and hides emptied category groups', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e u5 filter');

    // Groups are present and populated before any filtering.
    await expect(toolbox(page).getByRole('list', { name: 'General' })).toBeVisible();
    await expect(toolbox(page).getByRole('list', { name: 'AI' })).toBeVisible();
    await expect(toolbox(page).getByRole('button', { name: 'HTTP Request' })).toBeVisible();

    await toolbox(page).getByRole('searchbox', { name: 'Filter activities' }).fill('http');
    await expect(toolbox(page).getByRole('button', { name: 'HTTP Request' })).toBeVisible();
    await expect(toolbox(page).getByRole('button', { name: 'LLM Call' })).toHaveCount(0);
    // A heading over nothing would be a false "this category has matches" signal.
    await expect(toolbox(page).getByRole('list', { name: 'AI' })).toHaveCount(0);
    await expect(toolbox(page).getByRole('list', { name: 'General' })).toBeVisible();

    await toolbox(page).getByRole('searchbox', { name: 'Filter activities' }).fill('zzzz');
    await expect(toolbox(page).getByRole('status')).toContainText('No activities match');

    await expectQuiet(page, problems);
  });

  test('a search surfaces matches through a COLLAPSED group, and restores it after', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e u5 collapse search');

    await toolbox(page).getByRole('button', { name: 'Collapse General' }).click();
    await expect(toolbox(page).getByRole('button', { name: 'HTTP Request' })).toHaveCount(0);

    // The match must not stay behind a disclosure closed while looking at a
    // different list — otherwise search appears to return nothing at all.
    await toolbox(page).getByRole('searchbox', { name: 'Filter activities' }).fill('http');
    await expect(toolbox(page).getByRole('button', { name: 'HTTP Request' })).toBeVisible();
    // ...and no disclosure is offered while it has nothing to control, so there
    // is no control whose label disagrees with the screen and whose click would
    // rewrite the saved preference invisibly.
    await expect(toolbox(page).getByRole('button', { name: /General$/ })).toHaveCount(0);

    await toolbox(page).getByRole('searchbox', { name: 'Filter activities' }).fill('');
    // Suspended, not discarded.
    await expect(toolbox(page).getByRole('button', { name: 'Expand General' })).toBeVisible();
    await expect(toolbox(page).getByRole('button', { name: 'HTTP Request' })).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('collapses a category group without collapsing the others', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e u5 collapse');

    await toolbox(page).getByRole('button', { name: 'Collapse General' }).click();
    // `hidden` on the list, so the items are gone from the a11y tree too, not
    // merely painted out.
    await expect(toolbox(page).getByRole('button', { name: 'HTTP Request' })).toHaveCount(0);
    await expect(toolbox(page).getByRole('button', { name: 'LLM Call' })).toBeVisible();

    await toolbox(page).getByRole('button', { name: 'Expand General' }).click();
    await expect(toolbox(page).getByRole('button', { name: 'HTTP Request' })).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('adds an activity by KEYBOARD alone — the non-drag path WCAG 2.5.7 requires', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e u5 keyboard');

    await expect(canvasNodes(page)).toHaveCount(0);
    const item = toolbox(page).getByRole('button', { name: 'HTTP Request' });
    await item.focus();
    // The element the browser actually focused, not the one we asked it to —
    // an item that is not a real button would fail here rather than silently
    // leave focus on `<body>`.
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(canvasNodes(page)).toContainText('HTTP Request');
    await expectQuiet(page, problems);
  });

  test('a keyboard-focused activity has a visible focus ring', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e u5 focus');

    // TABBED to, not `.focus()`ed. `:focus-visible` is a heuristic on how focus
    // ARRIVED: after `openCanvas`'s clicks, Chromium treats a programmatic
    // `.focus()` as pointer-originated and matches no ring at all — so a
    // `.focus()` version of this spec fails against correct CSS, and would have
    // been "fixed" by weakening the assertion. Tab out of the filter box: one
    // hop to the group disclosure, a second to its first activity.
    await toolbox(page).getByRole('searchbox', { name: 'Filter activities' }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    // Assert WHERE focus landed before asserting how it looks — otherwise a
    // changed tab order would silently move this test onto another element.
    // The name is pinned to whatever sorts FIRST in the first group, which
    // `activityGroups.ts` orders by `title.localeCompare`: 'Copy Data' (#1139)
    // took that place from 'Copy File'. Re-pin it when a new general activity
    // sorts ahead of it — that is this assertion doing its job, not breaking.
    const item = toolbox(page).getByRole('button', { name: 'Copy Data', exact: true });
    await expect(item).toBeFocused();

    const ring = await item.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset };
    });
    expect(ring.style).toBe('solid');
    expect(parseFloat(ring.width)).toBeGreaterThan(0);
    // STRICTLY negative: drawn inside the border box, so the toolbox's own
    // `overflow-y: auto` cannot clip it — the same reasoning as the U3 pane.
    expect(parseFloat(ring.offset)).toBeLessThan(0);

    await expectQuiet(page, problems);
  });

  test('drags an activity onto the canvas and drops it AT THE POINTER', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e u5 drag');

    // Seed one node by keyboard FIRST, deliberately.
    //
    // `<ReactFlow fitView>` queues its fit until nodes are initialised, so on an
    // EMPTY canvas the fit is still pending and resolves the moment the first
    // node is measured — re-centring and re-zooming the viewport right after the
    // drop. Asserting a drop position on the first node would be asserting
    // against a viewport that moves under the assertion. With a node already
    // present the fit has resolved, which is also the state an author is in for
    // every drop after their first.
    await toolbox(page).getByRole('button', { name: 'LLM Call' }).focus();
    await page.keyboard.press('Enter');
    await expect(canvasNodes(page)).toHaveCount(1);

    const pane = canvasPane(page);
    const paneBox = await pane.boundingBox();
    expect(paneBox).not.toBeNull();
    // A target well inside the pane and clear of the chrome (Controls sit
    // bottom-left, the MiniMap bottom-right).
    const target = { x: Math.round(paneBox!.width * 0.5), y: Math.round(paneBox!.height * 0.3) };

    await toolbox(page)
      .getByRole('button', { name: 'HTTP Request' })
      .dragTo(pane, { targetPosition: target });

    await expect(canvasNodes(page)).toHaveCount(2);
    const dropped = canvasNodes(page).filter({ hasText: 'HTTP Request' });
    await expect(dropped).toHaveCount(1);

    // The node's TOP-LEFT lands under the pointer (see `FlowCanvas.onDrop` for
    // why it is not centred). The tolerance covers sub-pixel rounding in the
    // viewport transform, not a different placement rule — 12px is far tighter
    // than the ~180px error a missing `screenToFlowPosition` (raw client
    // coordinates) or a default staggered position would produce.
    const box = await dropped.boundingBox();
    expect(box).not.toBeNull();
    const droppedAt = { x: paneBox!.x + target.x, y: paneBox!.y + target.y };
    expect(Math.abs(box!.x - droppedAt.x)).toBeLessThan(12);
    expect(Math.abs(box!.y - droppedAt.y)).toBeLessThan(12);

    await expectQuiet(page, problems);
  });

  test('a drop RELEASED OVER THE MINIMAP authors nothing', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e u5 chrome');

    // React Flow spreads `onDrop` onto its outer wrapper and renders the
    // MiniMap, Controls and attribution inside it, so without the chrome guard
    // this drop would author a node at whatever flow position sits under that
    // corner — a placement the operator never pointed at.
    const minimap = page.locator('.react-flow__minimap');
    await expect(minimap).toBeVisible();
    await toolbox(page).getByRole('button', { name: 'HTTP Request' }).dragTo(minimap);

    await expect(canvasNodes(page)).toHaveCount(0);
    // And the canvas is still usable afterwards — the refused drag left no
    // stuck state behind.
    await toolbox(page).getByRole('button', { name: 'HTTP Request' }).click();
    await expect(canvasNodes(page)).toHaveCount(1);

    await expectQuiet(page, problems);
  });
});
