import { expect, test, type Page } from '@playwright/test';
import { connectById, outcomePort, outcomeRadio, selectEdge } from './support/canvasGraph';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { resolvedPaletteColor } from './support/theme';
import { CONNECTION_RADIUS } from '../packages/web/src/pages/pipeline/ports';

/**
 * U19 — outcome-by-source-handle, in a real browser.
 *
 * The gesture this ticket exists for cannot be unit-tested at all: jsdom
 * measures every element as zero and React Flow culls unmeasured nodes, so a
 * simulated drag in the unit suite asserts on nothing. Worse, the failure mode
 * here is SILENT in both directions — an edge whose `sourceHandle` names a port
 * that does not exist is drawn as nothing at all (no error, no warning), and a
 * drag that snapped to the neighbouring port authors a perfectly valid edge on
 * the wrong outcome. Neither shows up as an exception anywhere.
 *
 * So the assertions are all COMPUTED values: which handle ids the node actually
 * renders, what the property panel says the drawn edge fires on, and the
 * resolved stroke of the line. "It looked right" cannot distinguish any of the
 * cases above.
 */

/** A port's handle, by outcome, on a named node. */
function port(page: Page, nodeId: string, handleId: string) {
  return page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${handleId}"]`,
  );
}

/** Every source-port handle id the node renders, in DOM order. */
function renderedPorts(page: Page, nodeId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!node) throw new Error(`no node ${id} on the canvas`);
    return [...node.querySelectorAll('.react-flow__handle-right')].map(
      (h) => h.getAttribute('data-handleid') ?? '',
    );
  }, nodeId);
}

const TWO_NODES = {
  nodes: [
    { id: 'a', position: { x: 0, y: 0 } },
    { id: 'b', position: { x: 320, y: 0 } },
  ],
};

test.describe('U19 outcome ports', () => {
  /**
   * The whole ticket in one gesture: the operator drags from the port they mean
   * and the edge carries THAT outcome, without touching the property panel.
   *
   * Before U19 every drawn edge was `success` and the condition was re-picked
   * afterwards from a dropdown. The panel is still read here — as the ORACLE for
   * what was persisted, not as the thing under test.
   */
  test('a drag from the failure port authors a FAILURE edge', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u19 drag', TWO_NODES);

    await connectById(page, 'a', 'b', undefined, outcomePort('failure'));

    const edge = page.locator('.react-flow__edge');
    await expect(edge).toHaveCount(1);
    // The hue is the visible claim; the panel is the persisted one. Both, so a
    // pass cannot come from a correct edge painted wrong or the reverse.
    await expect(edge).toHaveClass(/\bedge-variant-failure\b/);
    await selectEdge(page);
    await expect(outcomeRadio(page, outcomePort('failure'))).toBeChecked();

    const stroke = await page.evaluate(
      () => getComputedStyle(document.querySelector('.react-flow__edge-path')!).stroke,
    );
    expect(stroke).toBe(await resolvedPaletteColor(page, '--error'));

    await expectQuiet(page, problems);
  });

  /**
   * The neighbour-snap this ticket had to design around.
   *
   * React Flow's `getClosestHandle` snaps a drag to any handle inside
   * `connectionRadius` and skips only the exact one it started on, so ports
   * packed closer than that radius make the port you grabbed and the port you
   * drew from two different things — silently, since the resulting edge is
   * perfectly valid. `ports.ts` pins the radius under half the pitch; this is
   * the check that the pitch survives the real cascade, where a stylesheet
   * change could collapse the column.
   */
  test('the ports sit far enough apart that a drag cannot snap to its neighbour', async ({
    page,
  }) => {
    await openSeededCanvas(page, 'u19 spacing', TWO_NODES);

    /* #997 — the pitch only EXISTS while the fan is out: at rest every port is
       collapsed onto one point, so the gaps below are all zero and the snap
       radius has nothing to be compared against. That is not a weakening of this
       check, it is its precise scope — two ports can only be confused by a drag
       during the state in which a drag can reach them. */
    const nodeA = page.locator('.react-flow__node[data-id="a"]');
    await nodeA.hover();
    await expect(nodeA.locator('.flow-node')).toHaveAttribute('data-ports-expanded', 'true');

    const centres = await page.evaluate(() =>
      [
        ...document.querySelectorAll('.react-flow__node[data-id="a"] .react-flow__handle-right'),
      ].map((h) => {
        const box = h.getBoundingClientRect();
        return box.y + box.height / 2;
      }),
    );
    expect(centres.length).toBeGreaterThan(1);
    const gaps = centres.slice(1).map((y, i) => y - centres[i]!);
    /* Against the CONSTANT, not a copy of its value: two adjacent ports must
       not both fall inside one snap radius, and a spec that hardcodes 12 stops
       tracking `CONNECTION_RADIUS` the moment anyone changes it. */
    for (const gap of gaps) expect(gap).toBeGreaterThan(2 * CONNECTION_RADIUS);
  });

  /**
   * #997 — and the DOT's spacing above is not the whole of it, because the dot
   * is not what a drop is resolved against.
   *
   * React Flow decides which port a gesture landed on with
   * `document.elementFromPoint`, in preference to its own measured geometry —
   * `isValidHandle` says so in as many words ("we always want to prioritize the
   * handle below the mouse cursor over the closest distance handle",
   * `@xyflow/system` 0.0.79 index.js:2570). So the port a drag reaches is
   * whatever is topmost at the pointer, which since #997 is an INVISIBLE box
   * (`::after`) larger than the dot it hangs off. Nothing above can see that box:
   * the gaps are measured from `getBoundingClientRect`, which a pseudo-element
   * does not have, and `CONNECTION_RADIUS` is the path RF only falls back to.
   *
   * It shipped at 24px against a 14px pitch, so each port's target reached both
   * neighbours and the topmost sibling took the drop. That is a WRONG GRAPH, not
   * a stiff gesture: `connect-validation.spec.ts`'s backwards drag finished
   * exactly on `success` and authored an `on failure` edge, and the duplicate it
   * should have refused was never refused.
   *
   * Asserted as OWNERSHIP rather than as a size, and the difference is what makes
   * it a regression net: a size check restates the stylesheet, while this says
   * what the size is FOR — a point unambiguously nearer one port than any other
   * belongs to that port. 45% of the measured pitch is inside that port's half of
   * the column with room to spare, and clear of the seam where two equal targets
   * meet. Measured, never hardcoded, so it tracks `SOURCE_PORT_PITCH`.
   */
  test('each port owns its share of the column, invisible hit target included', async ({
    page,
  }) => {
    await openSeededCanvas(page, 'u19 targets', TWO_NODES);
    const nodeA = page.locator('.react-flow__node[data-id="a"]');
    await nodeA.hover();
    await expect(nodeA.locator('.flow-node')).toHaveAttribute('data-ports-expanded', 'true');

    const claims = await page.evaluate(() => {
      const handles = [
        ...document.querySelectorAll('.react-flow__node[data-id="a"] .react-flow__handle-right'),
      ];
      const centres = handles.map((h) => {
        const box = h.getBoundingClientRect();
        return {
          id: h.getAttribute('data-handleid') ?? '',
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        };
      });
      const pitch = centres[1]!.y - centres[0]!.y;
      // Both ways from each port: a target that overreaches does so upward for
      // one port and downward for its neighbour, and only one of the two is the
      // direction a given drag happens to approach from.
      return centres.flatMap((c) =>
        [-0.45, 0.45].map((f) => {
          const y = c.y + pitch * f;
          const at = document.elementFromPoint(c.x, y);
          return {
            port: c.id,
            offset: Math.round(pitch * f),
            hit: at?.classList.contains('react-flow__handle')
              ? (at.getAttribute('data-handleid') ?? '(handle, no id)')
              : `${at?.tagName ?? 'nothing'}.${at?.className ?? ''}`,
          };
        }),
      );
    });

    expect(claims.length).toBeGreaterThan(2);
    for (const c of claims) {
      expect(c.hit, `${c.offset}px from '${c.port}' resolves to '${c.hit}'`).toBe(c.port);
    }

    /* And the OUTWARD side belongs to something else entirely. React Flow draws
       a selected edge's reconnect anchor tangent to the dot and displaced
       outward, so the strip just past a port is the only place that edge's end
       can be picked up — and a handle paints above an edge, so a target that
       reaches into it silently converts "grab this edge" into "start a new
       connection". That is what `edge-reconnect.spec.ts` reports as a retype
       that did not happen; this says why, one pixel past the dot. */
    const outward = await page.evaluate(() => {
      const h = document.querySelector('.react-flow__node[data-id="a"] .react-flow__handle-right')!;
      const box = h.getBoundingClientRect();
      const at = document.elementFromPoint(box.x + box.width + 2, box.y + box.height / 2);
      return at?.classList.contains('react-flow__handle') === true;
    });
    expect(outward, 'the hit target reaches past the dot, into the reconnect anchor').toBe(false);
  });

  /**
   * The labels are asked for, not drawn permanently — and they cost the node no
   * width.
   *
   * Both halves are load-bearing. A permanent label gutter widened every node by
   * ~30%, and `addNode` staggers a new node only 40px diagonally, so each added
   * activity landed on the previous one's ports; the mid-gesture handle state in
   * `connect-validation.spec.ts` is what caught it. So the words appear on hover
   * and the accessible name carries them the rest of the time.
   */
  test('a port names itself on hover, and always to a screen reader', async ({ page }) => {
    await openSeededCanvas(page, 'u19 labels', TWO_NODES);

    const label = page
      .locator('.react-flow__node[data-id="a"] .flow-port-label')
      .filter({ hasText: 'failure' });
    await expect(label).toHaveCSS('opacity', '0');
    await expect(port(page, 'a', outcomePort('failure'))).toHaveAttribute('aria-label', 'failure');

    await page.locator('.react-flow__node[data-id="a"] .flow-node').hover();
    await expect(label).toHaveCSS('opacity', '1');
  });

  /**
   * The same reveal, for a keyboard.
   *
   * A CONTAINER is a legal edge source and draws the same outcome ports, but its
   * reveal shipped with `:hover` alone while an activity node had `:focus-within`
   * too — so a keyboard user who tabbed into a container never got the words a
   * mouse user got. Both arms are asserted because the defect was precisely the
   * ASYMMETRY: a hover-only spec passed throughout.
   *
   * The two gestures are aimed at what is actually hit-testable. `.flow-container`
   * is `pointer-events: none` (the box must not eat pane clicks aimed between its
   * children), with the handles and the two chrome buttons opting back in — so
   * the hover arm hovers a PORT and relies on `:hover` matching the ancestor box,
   * and the focus arm tabs to the Configure button, which is a real control a
   * real keyboard reaches. Neither is simulated.
   */
  test('a container port names itself on hover AND on keyboard focus', async ({ page }) => {
    await openSeededCanvas(page, 'u19 container labels', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['a'] }],
    });

    const box = page.locator('.react-flow__node[data-id="stage_1"] .flow-container');
    const label = box.locator('.flow-port-label').filter({ hasText: 'failure' });
    await expect(label).toHaveCSS('opacity', '0');

    /* A DIFFERENT port than the label asserted on, so what is proved is the
       box-level reveal rather than a port revealing its own name. */
    await port(page, 'stage_1', outcomePort('success')).hover();
    await expect(label).toHaveCSS('opacity', '1');

    // Away from the box entirely, or the hover arm would mask the focus one.
    await page.mouse.move(0, 0);
    await expect(label).toHaveCSS('opacity', '0');

    await box.getByRole('button', { name: 'Configure stage 1' }).focus();
    await expect(label).toHaveCSS('opacity', '1');
  });

  /**
   * A `switch` routes by CASE, and every case it declares is drawable.
   *
   * The branch ports are the half of U19 the dropdown could express but the
   * canvas could not: before this, a five-case switch was a node with one
   * anonymous port, and which arm an edge took was invisible until you selected
   * it.
   */
  test('a switch draws one port per case, plus default', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u19 switch', {
      nodes: [
        {
          id: 'sw',
          type: 'switch',
          config: { on: '${run.runId}', cases: ['red', 'blue'] },
          position: { x: 0, y: 0 },
        },
        { id: 'b', position: { x: 360, y: 0 } },
      ],
    });

    expect(await renderedPorts(page, 'sw')).toEqual([
      'op:success',
      'op:failure',
      'op:completion',
      'op:skipped',
      'branch:red',
      'branch:blue',
      'branch:default',
    ]);
    // The label is the ROUTING KEY, not the literal "branch" — the one piece of
    // information that says where the arm goes.
    await expect(port(page, 'sw', 'branch:red')).toHaveAttribute('aria-label', 'red');

    await connectById(page, 'sw', 'b', undefined, 'branch:blue');
    await selectEdge(page);
    await expect(outcomeRadio(page, 'branch:blue')).toBeChecked();

    await expectQuiet(page, problems);
  });

  /**
   * The ORPHAN port — the silent edge-loss this feature would otherwise have
   * introduced.
   *
   * `declaredBranchesOf` reads `config.cases` LIVE, so a doc can legitimately
   * hold an edge routing on a case the source no longer declares (rename it in
   * the node panel, or import the doc from git). Without a port for it, React
   * Flow resolves that edge's `sourceHandle` to nothing and the line simply is
   * not drawn — the edge is still in the doc, still refused by the save gate,
   * and invisible on the one surface that is meant to show it.
   */
  test('an edge on an undeclared case still has a port, and is still drawn', async ({ page }) => {
    await openSeededCanvas(page, 'u19 orphan', {
      nodes: [
        {
          id: 'sw',
          type: 'switch',
          config: { on: '${run.runId}', cases: ['red', 'blue'] },
          position: { x: 0, y: 0 },
        },
        { id: 'b', position: { x: 360, y: 0 } },
        // A THIRD node, so the orphan-drag below is judged as undeclared rather
        // than as a duplicate of the `sw → b` edge that made the port an orphan.
        { id: 'c', position: { x: 360, y: 220 } },
      ],
      edges: [{ from: 'sw', to: 'b', on: 'branch', branch: 'blue' }],
    });

    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(port(page, 'sw', 'branch:blue')).not.toHaveClass(/\bflow-port--orphaned\b/);

    /* Un-declare `blue` the way an operator reaches this state: edit the
       switch's cases in the node panel. The doc is now unsavable (the validation
       badge says so) — but it is still the doc on screen, and the canvas is the
       surface that has to keep showing what is in it. Seeding this state
       directly is impossible on purpose: the write gate refuses a branch edge
       whose case is not declared, which is why the ONLY route here is an edit. */
    await nodeById(page, 'sw').click();
    /* By ROLE, not by label: U8a's expression toggle sits beside each field and
       carries the field's name in its accessible name, so `getByLabel('cases')`
       matches the textarea AND the button (`node-config-form.spec.ts` records
       the same constraint). */
    const cases = page
      .getByRole('complementary', { name: 'Properties' })
      .getByRole('textbox', { name: /^cases/ });
    await cases.fill('red');
    // The form is APPLY-gated — typing alone edits nothing, which is what keeps
    // a half-typed identifier out of the doc.
    await page.getByRole('button', { name: 'Apply config' }).click();

    await expect(port(page, 'sw', 'branch:blue')).toHaveClass(/\bflow-port--orphaned\b/);
    await expect(port(page, 'sw', 'branch:blue')).toHaveAttribute(
      'aria-label',
      'blue — not offered by this source',
    );
    /* The point of the orphan port. Without it React Flow resolves this edge's
       `sourceHandle` to nothing and draws NO line — the edge stays in the doc,
       invisible, on the one surface meant to show it. */
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    /* …and the OTHER half of that: the port is there to keep an existing edge
       drawn, not to start a new one. Drawing from it would author an outcome the
       source does not declare, on a doc the save gate then refuses — the "draw
       it, watch it appear, then find out it cannot save" defect the connect-time
       rules exist to remove. Refused with a SENTENCE rather than by an inert
       handle, so the operator is told why rather than left with a drag that does
       nothing. */
    await connectById(page, 'sw', 'c', undefined, 'branch:blue');
    const refusal = page.locator('.canvas-refusal');
    await expect(refusal.getByRole('alert')).toContainText('blue');
    // The refusal is a refusal: nothing was authored.
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });
});
