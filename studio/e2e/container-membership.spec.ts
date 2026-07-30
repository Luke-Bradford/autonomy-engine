import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas, type SeedDoc } from './support/seedDoc';

/**
 * #746 — deleting an ENCLOSED activity, end to end.
 *
 * The unit suites pin the prune and the validator's verdict. Neither can pin
 * what the operator actually reported, which is a UI state: the Save button
 * dead, a badge naming a node that is no longer on screen, and the container box
 * teleporting off to the side because every child it lists has become a phantom.
 * Those are cross-cutting — store, validator, `PipelineCanvas` badge, the U6c
 * derived-box layout — and jsdom cannot see the last of them at all, since a
 * container's rect is derived from MEASURED child sizes it reports as 0×0.
 *
 * So this spec walks the path: seed a doc with a container (the canvas cannot
 * author one until U6d, so the seed goes through the real write gate), delete a
 * child, and assert the doc is still savable — by SAVING it, which is the only
 * assertion that proves the save BODY no longer carries the phantom.
 *
 * The container's GEOMETRY is deliberately NOT asserted here, though #746
 * describes a box that teleports. It was written, and it PASSED with the prune
 * reverted — so it could not fail for this fix and was removed rather than
 * shipped. The reason it cannot discriminate is U6c's own honesty: the box is
 * derived from the children it can actually DRAW, so a listed-but-deleted child
 * and a pruned one produce the identical rect (and emptying a container reaches
 * the same fallback branch either way). `container-rendering.spec.ts` owns that
 * geometry. What #746 changes is the doc, and the doc is what is asserted.
 */

/** Two activities inside a stage, one outside it, and a `stage -> outside` edge. */
function stageDoc(): SeedDoc {
  return {
    nodes: [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 0, y: 200 } },
      { id: 'after', type: 'file_write', position: { x: 460, y: 100 } },
    ],
    // From the CONTAINER, not from a child: an edge crossing the boundary is
    // exactly what the write gate refuses, so the seed would not mint.
    edges: [{ from: 'stage_1', to: 'after', on: 'success' }],
    containers: [{ id: 'stage_1', kind: 'stage', children: ['a', 'b'] }],
  };
}

/** Select an activity and delete it through the property panel. */
async function deleteActivity(page: Page, id: string): Promise<void> {
  await nodeById(page, id).click();
  await page.getByRole('button', { name: 'Delete node' }).click();
  await expect(nodeById(page, id)).toHaveCount(0);
}

/** The validation badge's messages, or `[]` when there is no badge. */
async function validationIssues(page: Page): Promise<string[]> {
  const list = page.locator('.badge-list li');
  return (await list.count()) === 0 ? [] : list.allTextContents();
}

test.describe('#746 container membership follows a delete', () => {
  /**
   * The headline, stated as the operator experiences it: delete an enclosed
   * activity and the doc still saves.
   *
   * Asserted by actually clicking Save and reading the confirmation, not by
   * asserting the button is enabled. `canSave` is a pure predicate the unit
   * suite already covers; what it CANNOT cover is that the body sent to the
   * server no longer lists the deleted child — and the server's own write gate
   * (the same `validatePipelineDoc`) is what proves it, by minting v2 instead of
   * returning a 400.
   */
  test('a deleted child leaves a doc that still saves', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'membership-save', stageDoc());

    await deleteActivity(page, 'b');

    expect(await validationIssues(page), 'the delete left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await expectQuiet(page, problems);
  });

  /**
   * A container is deliberately NOT deleted with its last child — it owns edges
   * and config (`exitWhen`/`items`/`maxRounds`/`timeout`) that the canvas cannot
   * re-author, so a cascade would destroy authored structure to spare one refused
   * save. What that leaves behind is pinned here: the refusal names the REAL
   * problem instead of naming the node the operator just deleted.
   *
   * It is no longer a dead end — the escape route is the #748 describe below —
   * but it is still the state the operator lands in, and the difference between
   * an error you can act on and one you cannot is the message.
   */
  test('emptying a loop is refused for the right reason, not for a phantom', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'membership-residue', {
      nodes: [{ id: 'only', position: { x: 0, y: 0 } }],
      containers: [
        {
          id: 'loop_1',
          kind: 'loop',
          children: ['only'],
          exitWhen: '${equals(nodes.only.status, "success")}',
          maxRounds: 3,
        },
      ],
    });

    await deleteActivity(page, 'only');

    const issues = await validationIssues(page);
    expect(issues.join('\n')).not.toContain('is not a node in this pipeline');
    expect(issues.join('\n')).toContain('makes no progress');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await expectQuiet(page, problems);
  });
});

/**
 * #748 — the ESCAPE ROUTE, walked end to end.
 *
 * This is the half a unit test cannot reach, and the reason it is worth a real
 * browser: the delete control is hit-testable only because the stylesheet opts it
 * back in (the box itself is `pointer-events: none`), and jsdom loads no
 * stylesheet at all.
 * A unit test clicking that button passes whether or not the rule that makes it
 * clickable exists. Here, a click that does not land simply does not delete.
 *
 * The other end-to-end claim is the SAVE. The store dropping a container from an
 * array proves nothing about the doc the server accepts — the incident edge
 * `loop_1 → after` has to go with the box, or the body carries an edge naming a
 * container that is not there and the write gate refuses it with exactly the kind
 * of message #746 was filed about.
 */
test.describe('#748 an emptied container is not a one-way trap', () => {
  /** A loop with one child, wired to an activity OUTSIDE it. */
  function wiredLoopDoc(): SeedDoc {
    return {
      nodes: [
        { id: 'only', position: { x: 0, y: 0 } },
        { id: 'after', type: 'file_write', position: { x: 420, y: 0 } },
      ],
      edges: [{ from: 'loop_1', to: 'after', on: 'success' }],
      containers: [
        {
          id: 'loop_1',
          kind: 'loop',
          children: ['only'],
          exitWhen: '${equals(nodes.only.status, "success")}',
          maxRounds: 3,
        },
      ],
    };
  }

  test('an emptied loop can be deleted from the canvas, and the doc then saves', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    // The delete is confirmed (there is no undo, and the container's config does
    // not survive it). Playwright DISMISSES dialogs by default, which would make
    // this test pass for the wrong reason — nothing deleted, nothing to save.
    page.on('dialog', (dialog) => void dialog.accept());
    const pipelineId = await openSeededCanvas(page, 'container-escape', wiredLoopDoc());

    await deleteActivity(page, 'only');

    // The trap, as the operator meets it: the doc is refused, Save is dead.
    expect((await validationIssues(page)).join('\n')).toContain('makes no progress');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    /* The emptied box is NOT on screen at this point, and that is a real residue
       rather than a quirk of this test — measured here, filed as #785.
       `containerRects` places a container it cannot derive a size from to the
       RIGHT of all remaining content, and `onlyRenderVisibleElements` then culls
       it: after the delete above, `document.querySelectorAll('.react-flow__node')`
       returns `['after']` — the container is not in the DOM at all. Because a
       fitted viewport ends flush with the content bounds, "just outside them" is
       reliably just off-screen, so this is systematic, not occasional.

       So the escape route is real but two-step: bring the box into view, then use
       it. Fit-view is the honest stand-in for the panning an operator would do
       (the badge tells them a CONTAINER is the problem, so they know what they
       are looking for).

       ASSERTED, not just described. A bare fit-view click would leave the spec
       passing whether or not the residue exists, and "documented in a comment"
       is not the same as pinned — so the absence is a real assertion, and #785's
       acceptance is that BOTH lines below come out together and the rest of this
       test still passes. */
    await expect(
      nodeById(page, 'loop_1'),
      'the emptied box is on screen — #785 fixed?',
    ).toHaveCount(0);
    await page.locator('.react-flow__controls-fitview').click();
    await expect(nodeById(page, 'loop_1')).toHaveCount(1);

    // The way out — the box's own control, inside a box that is otherwise inert.
    await nodeById(page, 'loop_1').getByRole('button', { name: 'Delete loop container' }).click();
    await expect(nodeById(page, 'loop_1')).toHaveCount(0);
    // The activity outside the box is untouched.
    await expect(nodeById(page, 'after')).toHaveCount(1);

    expect(await validationIssues(page), 'deleting the empty loop left it invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    /* The incident edge `loop_1 -> after`, asserted on the MINTED VERSION rather
       than on screen — the only place the claim is observable.
       Mutation-testing this spec is what forced the change: an on-screen check
       (`[aria-label*="from loop_1"]` gone) and the save SUCCEEDING both stay
       green with the cascade deleted, for two independent reasons. React Flow
       drops an edge whose endpoint is missing from its lookup, silently, so the
       stranded edge disappears from the DOM either way; and the write gate does
       not refuse one either — an edge naming a container that no longer exists
       passes `validatePipelineDoc` clean today (measured, filed as #786). So the
       cascade has no backstop anywhere, and reading the version back is the only
       assertion that fails when it is removed. */
    const v2 = (await (
      await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions/2`)
    ).json()) as { nodes: Array<{ id: string }>; edges: unknown[]; containers: unknown[] };
    expect(v2.containers).toEqual([]);
    expect(v2.edges).toEqual([]);
    expect(v2.nodes.map((n) => n.id)).toEqual(['after']);

    await expectQuiet(page, problems);
  });

  /**
   * The children SURVIVE the box.
   *
   * Deleting a container that still HAS children un-groups them; it does not
   * delete them. Asserted against a saved version rather than the canvas alone,
   * because the claim is about the doc that gets minted — an un-grouped activity
   * that the save silently dropped would look identical on screen.
   */
  test('deleting a populated stage keeps the activities inside it', async ({ page }) => {
    const problems = collectPageProblems(page);
    page.on('dialog', (dialog) => void dialog.accept());
    const pipelineId = await openSeededCanvas(page, 'container-ungroup', stageDoc());

    await nodeById(page, 'stage_1').getByRole('button', { name: 'Delete stage container' }).click();

    await expect(nodeById(page, 'stage_1')).toHaveCount(0);
    await expect(nodeById(page, 'a')).toHaveCount(1);
    await expect(nodeById(page, 'b')).toHaveCount(1);

    expect(await validationIssues(page)).toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const v2 = (await (
      await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions/2`)
    ).json()) as { nodes: Array<{ id: string }>; containers: unknown[] };
    expect(v2.containers).toEqual([]);
    // Un-grouped, not deleted — and still there in the doc that was minted.
    expect(v2.nodes.map((n) => n.id).sort()).toEqual(['a', 'after', 'b']);

    await expectQuiet(page, problems);
  });

  /**
   * Pressing the button does not PAN the canvas.
   *
   * Hit-testable is not the same as exempt from the pane's gesture filter, and
   * the two are easy to conflate — this button re-enables `pointer-events`, but
   * React Flow's pan filter bails only on `.nopan` ancestry, so without
   * `nodrag nopan` a press-and-twitch on the × drags the whole viewport. An
   * ACTIVITY node is immune for a reason that does not apply here: it is
   * `draggable`, so d3-drag intercepts the mousedown. A container is
   * `draggable: false`, so nothing would.
   *
   * Only a real browser can answer this — it is React Flow's own d3-zoom
   * behaviour reading a class off a DOM ancestor chain, not anything jsdom
   * models. Asserted on the viewport TRANSFORM, the thing that actually moves,
   * rather than on the class attribute, which would pass with the behaviour
   * broken and only restate the source.
   */
  test('pressing the delete button does not pan the canvas', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'container-nopan', stageDoc());

    const transform = () =>
      page.evaluate(
        () => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform,
      );
    const before = await transform();

    const button = nodeById(page, 'stage_1').getByRole('button', {
      name: 'Delete stage container',
    });
    const box = (await button.boundingBox())!;
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 90, cy + 70, { steps: 10 });
    await page.mouse.up();

    expect(await transform(), 'pressing the delete button panned the canvas').toBe(before);
    // And nothing was deleted: the pointer left the button before release, so no
    // click fired — which is what makes the transform the only thing under test.
    await expect(nodeById(page, 'stage_1')).toHaveCount(1);

    await expectQuiet(page, problems);
  });
});
