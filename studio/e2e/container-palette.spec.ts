import { expect, test, type Locator, type Page } from '@playwright/test';
import { toolbox, validationIssues, viewportSettled, WIDE_CANVAS } from './support/canvasGraph';
import { answerConfirm } from './support/confirmDialog';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';

/**
 * #1420 — ForEach / Until / Stage in the Activities palette, and filling a box
 * by dragging.
 *
 * The operator could not find ForEach: the only way to make a container was the
 * selected node's Settings → New container. This walks the ADF gesture instead —
 * drop an EMPTY box from the palette, then drag activities into it — through the
 * real canvas, because the pieces it proves are cross-cutting (the palette's drag
 * payload, the drop handler, the anchored empty box in `containerRects`, the
 * drag-stop hit test, and the save badges) and jsdom measures every node 0×0.
 */

function pane(page: Page): Locator {
  return page.locator('.react-flow__pane');
}

/** The box of the one container whose accessible name starts with `name`. */
function containerBox(page: Page, name: string): Locator {
  return page.getByRole('group', { name: new RegExp(`^${name} container`) });
}

/** Drop a palette entry at a screen point, via the pane (HTML5 drag, see activity-toolbox.spec). */
async function dropFromPalette(page: Page, title: string, at: { x: number; y: number }) {
  const paneBox = (await pane(page).boundingBox())!;
  await toolbox(page)
    .getByRole('button', { name: title, exact: true })
    .dragTo(pane(page), { targetPosition: { x: at.x - paneBox.x, y: at.y - paneBox.y } });
}

/** Drag a node by its body so that its CENTRE ends at `to` (screen coords). */
async function dragNodeCentreTo(page: Page, id: string, to: { x: number; y: number }) {
  const b = (await nodeById(page, id).boundingBox())!;
  // The body's centre, not `dragNodeBy`'s top+6: the seeded canvas fits a lone
  // node at a high zoom, where the top band is a port and would start a CONNECTION.
  const grab = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  const dx = to.x - (b.x + b.width / 2);
  const dy = to.y - (b.y + b.height / 2);
  await page.mouse.move(grab.x + dx, grab.y + dy, { steps: 12 });
  await page.mouse.up();
}

function centre(b: { x: number; y: number; width: number; height: number }) {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The container an activity belongs to, as its Settings → Container select names it. */
async function membershipOf(page: Page, id: string): Promise<string> {
  await nodeById(page, id).click();
  return page
    .getByRole('combobox', { name: 'Container membership' })
    .locator('option:checked')
    .innerText();
}

/** The Problems panel's messages, joined — `validationIssues`, for `toContain`. */
async function issues(page: Page): Promise<string> {
  return (await validationIssues(page)).join('\n');
}

test.describe('#1420 containers in the Activities palette', () => {
  test.beforeEach(async ({ page }) => {
    // Room for the box beside the graph without the reveal pan pushing the
    // activity under the toolbox.
    await page.setViewportSize(WIDE_CANVAS);
  });

  test('drop a ForEach as an empty box, then drag an activity into it', async ({ page }) => {
    const problems = collectPageProblems(page);
    // A second, distant node so `fitView` frames a wide graph: a lone node is
    // fitted at the 1:1 cap, centred, and the reveal's minimum pan to the new box
    // can push `b` off screen (where `onlyRenderVisibleElements` culls it).
    await openSeededCanvas(page, 'palette-foreach', {
      nodes: [
        { id: 'b', position: { x: 0, y: 0 } },
        { id: 'far', position: { x: 900, y: 450 } },
      ],
    });

    const group = page.getByRole('list', { name: 'Containers' });
    for (const title of ['ForEach', 'Until', 'Stage']) {
      await expect(group.getByRole('button', { name: title, exact: true })).toBeVisible();
    }

    const node = (await nodeById(page, 'b').boundingBox())!;
    // BELOW the node: the stacked fallback an unanchored empty box gets is to
    // the RIGHT of the graph, so this placement cannot be reached by accident.
    const dropAt = { x: node.x, y: node.y + node.height + 60 };
    await dropFromPalette(page, 'ForEach', dropAt);
    // Two edge-less activities are an inferred chain, and the first container
    // turns it into parallel partitions — the one thing the drop confirms
    // (#1397: in the app's dialog, titled with the question).
    const asked = await answerConfirm(page, 'accept');
    expect(asked.startsWith('Add a ForEach container?')).toBe(true);
    expect(asked).toContain('parallel');

    const box = containerBox(page, 'ForEach 1');
    await expect(box).toHaveAttribute('aria-label', /^ForEach 1 container, 0 activities\b/);
    await viewportSettled(page);
    // The box is where it was dropped, not on the stacked fallback beside the
    // graph. Measured RELATIVE to the node: selecting the new box opens its
    // config panel, and the reveal may pan the view — a pan keeps offsets.
    const boxRect = (await box.boundingBox())!;
    const nodeNow = (await nodeById(page, 'b').boundingBox())!;
    expect(Math.abs(boxRect.x - nodeNow.x - (dropAt.x - node.x))).toBeLessThan(12);
    expect(Math.abs(boxRect.y - nodeNow.y - (dropAt.y - node.y))).toBeLessThan(12);
    // An empty ForEach cannot be saved: `validateDoc` needs a child (and items).
    expect(await issues(page)).toContain('needs at least one child');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await dragNodeCentreTo(page, 'b', centre(boxRect));
    // A drag that joins a box is confirmed when it changes routing, as the
    // Settings → Container select is — titled with what moves where.
    expect(await answerConfirm(page, 'accept')).toMatch(/^Move .+ into ForEach 1\?/);

    await expect(box).toHaveAttribute('aria-label', /^ForEach 1 container, 1 activity\b/);
    expect(await membershipOf(page, 'b')).toBe('ForEach 1');
    expect(await issues(page)).not.toContain('needs at least one child');

    await expectQuiet(page, problems);
  });

  test('an activity dropped from the palette onto an empty Stage goes inside it', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'palette-stage', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    const node = (await nodeById(page, 'a').boundingBox())!;
    await dropFromPalette(page, 'Stage', { x: node.x + node.width + 220, y: node.y });
    const box = containerBox(page, 'Stage 1');
    await expect(box).toHaveAttribute('aria-label', /^Stage 1 container, 0 activities\b/);

    const boxRect = (await box.boundingBox())!;
    await dropFromPalette(page, 'HTTP Request', { x: boxRect.x + 30, y: boxRect.y + 40 });

    await expect(box).toHaveAttribute('aria-label', /^Stage 1 container, 1 activity\b/);

    // The click path (the keyboard-reachable one) adds an empty box too.
    await toolbox(page).getByRole('button', { name: 'Until', exact: true }).click();
    // The new box would change routing, so the click asks, as the drop does.
    expect(await answerConfirm(page, 'accept')).toContain('Add an Until container?');
    await expect(containerBox(page, 'Until 1')).toHaveAttribute(
      'aria-label',
      /^Until 1 container, 0 activities\b/,
    );

    await expectQuiet(page, problems);
  });

  test('nudging an activity that already sits inside a box it is not in does not join it', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    // `b` is drawn INSIDE stage_1's box (the box spans a..c) without being a member.
    await openSeededCanvas(page, 'palette-nudge', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 220, y: 0 } },
        { id: 'c', position: { x: 440, y: 0 } },
      ],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['a', 'c'] }],
    });

    const b = (await nodeById(page, 'b').boundingBox())!;
    await dragNodeCentreTo(page, 'b', { x: centre(b).x + 8, y: centre(b).y + 4 });

    expect(await membershipOf(page, 'b')).toBe('— none —');
    await expect(containerBox(page, 'Stage 1')).toHaveAttribute(
      'aria-label',
      /^Stage 1 container, 2 activities\b/,
    );

    await expectQuiet(page, problems);
  });
});
