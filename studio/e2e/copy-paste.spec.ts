import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { canvasNodes, edgeGroup, marqueeAllNodes, viewportSettled } from './support/canvasGraph';
import { nodeById, openSeededCanvas, seedVersion } from './support/seedDoc';

/**
 * U21 slice 3 — copy/paste on the authoring canvas, and the ref remapping that
 * makes a MULTI-node copy correct rather than merely plausible.
 * Slice 5 (#935) adds the paste into ANOTHER pipeline, reached client-side so
 * the module-level clipboard survives the move. Slice 6 (#935) adds a CONTAINER
 * on the clipboard, and ⌘X — whose paste has to put back the edge the cut took.
 *
 * The rewriter and the store rules are unit-tested (`nodeRefs.test.ts`,
 * `canvasStore.test.ts`). What only a real browser and a real server can prove
 * is the round trip: that ⌘C/⌘V reach the store at all, that the copies are
 * DRAWN, and — the part that is the ticket — that the doc the paste produces is
 * one the SERVER's `validatePipelineDoc` accepts.
 *
 * That last point is why a remap bug is worth an e2e. A paste that left `b`'s
 * `${nodes.a…}` naming the ORIGINAL `a` still validates and still saves; it just
 * reads the wrong node forever. So the spec asserts the PERSISTED config names
 * the copy, not merely that a save succeeded.
 *
 * Meta throughout, never `ControlOrMeta`: Playwright resolves that from the
 * RUNNER's platform (Control on CI's ubuntu), and `clipboardCommandFor` accepts
 * Meta and Control interchangeably on every platform anyway — so Meta is the one
 * spelling that means the same thing here and on CI.
 *
 * Every assertion below was mutation-checked (recorded in the PR): each fails
 * when the behaviour it names is removed.
 */
test.describe('copy/paste on the canvas (U21)', () => {
  test('a pasted pair references ITSELF, keeps its upstream, and saves', async ({ page }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'u21 copy paste', {
      nodes: [
        {
          id: 'a',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { outputs: [{ name: 'body', type: 'string' }] },
        },
        {
          id: 'b',
          type: 'http_request',
          position: { x: 240, y: 0 },
          // Reads `a`, which is OUTSIDE the copied pair below — this ref must
          // survive untouched.
          config: {
            url: 'https://example.test/${nodes.a.output.body}',
            outputs: [{ name: 'body', type: 'string' }],
          },
        },
        {
          id: 'c',
          type: 'http_request',
          position: { x: 480, y: 0 },
          // Reads `b`, which IS in the copied pair — this is the ref that has to
          // follow the copy.
          config: { url: 'https://example.test/${nodes.b.output.body}' },
        },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b', on: 'success' },
        { id: 'e2', from: 'b', to: 'c', on: 'success' },
      ],
    });

    // Select b and c together. A marquee takes all three, so ⌘-click the pair.
    await viewportSettled(page);
    await page.getByTestId('rf__node-b').click();
    await page.keyboard.down('Meta');
    await page.getByTestId('rf__node-c').click();
    await page.keyboard.up('Meta');

    const panel = page.getByRole('complementary', { name: 'Properties' });
    await expect(panel.getByRole('heading', { name: '2 selected' })).toBeVisible();

    await page.keyboard.press('Meta+c');
    await expect(page.getByText('Copied 2 activities.')).toBeVisible();
    // A copy is not a doc edit: nothing new is drawn yet.
    await expect(canvasNodes(page)).toHaveCount(3);

    await page.keyboard.press('Meta+v');
    await expect(page.getByText('Pasted 2 activities.')).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(5);
    // Four edges: the two originals, the copied b→c, and the re-derived a→b'.
    await expect(edgeGroup(page)).toHaveCount(4);
    await viewportSettled(page);

    await page.getByRole('button', { name: 'Save version' }).click();
    // The server runs `validatePipelineDoc` on the write. A copy stranded
    // without its upstream is refused there, and this line is where it shows up.
    await expect(page.getByText(/^Saved v2\.$/)).toBeVisible();

    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`);
    expect(res.status()).toBe(200);
    const versions = (await res.json()) as {
      version: number;
      nodes: { id: string; config: Record<string, unknown> }[];
      edges: { from: string; to: string }[];
    }[];
    const latest = versions.reduce((x, y) => (x.version > y.version ? x : y));

    expect(latest.nodes).toHaveLength(5);
    const seeded = new Set(['a', 'b', 'c']);
    const copies = latest.nodes.filter((n) => !seeded.has(n.id));
    expect(copies).toHaveLength(2);

    // The copy of `b` is the one still reading `a` — the ref OUT of the copied
    // set, which must NOT have been rewritten.
    const copyB = copies.find(
      (n) => n.config['url'] === 'https://example.test/${nodes.a.output.body}',
    );
    expect(copyB, 'the copy of b still reads the original a').toBeTruthy();
    const copyC = copies.find((n) => n.id !== copyB!.id);

    // THE POINT OF THE SLICE: the copy of `c` reads the COPY of `b`, not `b`.
    expect(copyC!.config['url']).toBe(`https://example.test/\${nodes.${copyB!.id}.output.body}`);

    // The internal edge travelled with the pair, remapped to both copies...
    expect(latest.edges).toContainEqual(
      expect.objectContaining({ from: copyB!.id, to: copyC!.id }),
    );
    // ...and the external in-edge was re-derived, which is what keeps `copyB`'s
    // `${nodes.a…}` in scope for `validateRefs`.
    expect(latest.edges).toContainEqual(expect.objectContaining({ from: 'a', to: copyB!.id }));

    // The clipboard line CLEARS ITSELF. Unlike the save line, which the next
    // save wipes, no later act on this canvas owns it — so left un-expiring it
    // would still be sitting here under the save that came after it, claiming
    // to describe work the operator has long since moved on from.
    await expect(page.getByText('Pasted 2 activities.')).toBeHidden({ timeout: 15_000 });

    await expectQuiet(page, problems);
  });

  test('one undo removes a whole paste, and ⌘D duplicates the selection', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u21 paste undo', {
      nodes: [
        { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', type: 'http_request', position: { x: 240, y: 0 }, config: {} },
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' }],
    });

    await marqueeAllNodes(page, 2);
    await page.keyboard.press('Meta+c');
    await page.keyboard.press('Meta+v');
    await expect(canvasNodes(page)).toHaveCount(4);

    // ONE undo, not four: a paste is one gesture and so one history entry.
    await page.keyboard.press('Meta+z');
    await expect(canvasNodes(page)).toHaveCount(2);

    // ⌘D is the same clone without the clipboard round trip.
    await marqueeAllNodes(page, 2);
    await page.keyboard.press('Meta+d');
    await expect(page.getByText('Duplicated 2 activities.')).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(4);

    await expectQuiet(page, problems);
  });

  /* #935 — the SECOND pipeline shares the id `a` with the first, as two docs
     cut from one import do. A paste that re-derived edges from the target, or
     let a copy keep reading an un-copied `a`, would bind to THIS `a` silently. */
  const TARGET = {
    nodes: [
      { id: 'z', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
      { id: 'a', type: 'http_request', position: { x: 240, y: 0 }, config: {} },
    ],
    edges: [{ id: 'ez', from: 'z', to: 'a', on: 'success' as const }],
  };
  const SOURCE = {
    nodes: [
      {
        id: 'a',
        type: 'http_request',
        position: { x: 0, y: 0 },
        config: { outputs: [{ name: 'body', type: 'string' }] },
      },
      {
        id: 'b',
        type: 'http_request',
        position: { x: 240, y: 0 },
        config: { url: 'https://example.test/${nodes.a.output.body}' },
      },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' as const }],
  };

  /* Client-side, never `page.goto`: the clipboard is module state, so a reload
     empties it and the spec would be testing the empty-clipboard refusal. */
  async function openInApp(page: Page, pipelineId: string, expectIds: string[]): Promise<void> {
    await page.evaluate(
      (h) => {
        window.location.hash = h;
      },
      `#/author/pipelines/${encodeURIComponent(pipelineId)}`,
    );
    for (const id of expectIds) await expect(nodeById(page, id)).toHaveClass(/\bdraggable\b/);
    await viewportSettled(page);
  }

  test('a self-contained copy pastes into ANOTHER pipeline and saves there', async ({ page }) => {
    const problems = collectPageProblems(page);
    const { pipelineId: targetId } = await seedVersion(page, 'u21 paste target', TARGET);
    await openSeededCanvas(page, 'u21 paste source', SOURCE);

    await marqueeAllNodes(page, 2);
    await page.keyboard.press('Meta+c');
    await expect(page.getByText('Copied 2 activities.')).toBeVisible();

    await openInApp(page, targetId, ['z', 'a']);
    await expect(canvasNodes(page)).toHaveCount(2);
    await page.keyboard.press('Meta+v');
    await expect(page.getByText('Pasted 2 activities from another pipeline.')).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(4);
    // z→a, and the copied a'→b'. NOT a re-derived z→a' off the coincident id.
    await expect(edgeGroup(page)).toHaveCount(2);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.getByText(/^Saved v2\.$/)).toBeVisible();

    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(targetId)}/versions`);
    expect(res.status()).toBe(200);
    const versions = (await res.json()) as {
      version: number;
      nodes: { id: string; config: Record<string, unknown> }[];
      edges: { from: string; to: string }[];
    }[];
    const latest = versions.reduce((x, y) => (x.version > y.version ? x : y));
    const copies = latest.nodes.filter((n) => n.id !== 'z' && n.id !== 'a');
    expect(copies).toHaveLength(2);
    const copyB = copies.find((n) => typeof n.config['url'] === 'string');
    const copyA = copies.find((n) => n !== copyB);
    // THE POINT: the copy of b reads the copy of a — not the target's own `a`.
    expect(copyB!.config['url']).toBe(`https://example.test/\${nodes.${copyA!.id}.output.body}`);
    expect(latest.edges).toHaveLength(2);
    expect(latest.edges).toContainEqual(
      expect.objectContaining({ from: copyA!.id, to: copyB!.id }),
    );

    await expectQuiet(page, problems);
  });

  /* #1336 — a foreign paste lands BELOW everything in the target. Here the
     target is a tall column, so after the load-time fit that spot is off-screen,
     and with `onlyRenderVisibleElements` an off-screen copy is not even in the
     DOM. The canvas must pan to the copies — without zooming. */
  const TALL_TARGET = {
    nodes: [
      { id: 'z', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
      { id: 'a', type: 'http_request', position: { x: 0, y: 600 }, config: {} },
    ],
    edges: [{ id: 'ez', from: 'z', to: 'a', on: 'success' as const }],
  };

  test('a paste from another pipeline that lands off-screen is panned into view', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const { pipelineId: targetId } = await seedVersion(page, 'u21 tall target', TALL_TARGET);
    await openSeededCanvas(page, 'u21 reveal source', SOURCE);

    await marqueeAllNodes(page, 2);
    await page.keyboard.press('Meta+c');
    await expect(page.getByText('Copied 2 activities.')).toBeVisible();

    await openInApp(page, targetId, ['z', 'a']);
    const before = await viewportSettled(page);
    await page.keyboard.press('Meta+v');
    await expect(page.getByText('Pasted 2 activities from another pipeline.')).toBeVisible();

    const copies = page.locator('.react-flow__node:not([data-id="z"]):not([data-id="a"])');
    await expect(copies).toHaveCount(2);
    const after = await viewportSettled(page);
    /* Inside the canvas PANE, not merely the browser window: the pane is what
       React Flow culls against, and it is smaller than the page. */
    const pane = await page.locator('.react-flow').boundingBox();
    for (const copy of await copies.all()) {
      const box = await copy.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(pane!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
      expect(box!.x).toBeGreaterThanOrEqual(pane!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(pane!.x + pane!.width);
    }
    // It PANNED: the viewport moved, and the zoom the operator had is kept.
    expect(after).not.toBe(before);
    const scale = (t: string) => /scale\(([^)]+)\)/.exec(t)?.[1];
    expect(scale(after)).toBe(scale(before));

    await expectQuiet(page, problems);
  });

  test('a copy that reads an UN-copied node is refused in another pipeline, by name', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const { pipelineId: targetId } = await seedVersion(page, 'u21 refused target', TARGET);
    await openSeededCanvas(page, 'u21 refused source', SOURCE);

    await page.getByTestId('rf__node-b').click();
    await page.keyboard.press('Meta+c');
    await expect(page.getByText('Copied 1 activity.')).toBeVisible();

    await openInApp(page, targetId, ['z', 'a']);
    const panel = page.getByRole('complementary', { name: 'Properties' });
    await panel.getByRole('button', { name: 'Paste' }).click();
    await expect(
      page.getByText(
        'Not pasted: the copied activities read from a, which was not copied. Copy it too.',
      ),
    ).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(2);

    await expectQuiet(page, problems);
  });

  test('a paste with nothing copied SAYS so instead of silently doing nothing', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u21 empty clipboard', {
      nodes: [{ id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    });

    // The nothing-selected panel is where Paste lives, and where an operator
    // discovers the gesture exists at all.
    const panel = page.getByRole('complementary', { name: 'Properties' });
    await panel.getByRole('button', { name: 'Paste' }).click();
    await expect(page.getByText('Nothing has been copied yet.')).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(1);

    await expectQuiet(page, problems);
  });

  /* #935 — a CONTAINER on the clipboard. The store rules are unit-tested; what
     this proves is that ⌘C on a selected box reaches `copyContainer`, and that
     the doc a paste into ANOTHER pipeline produces is one the SERVER accepts,
     with the copy's `exitWhen` naming the copy's own child. Unremapped, it names
     the source loop's child, which the save gate refuses. */
  test('a container copies into ANOTHER pipeline, exits on its own child, and saves', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const { pipelineId: targetId } = await seedVersion(page, 'u21 box paste target', TARGET);
    await openSeededCanvas(page, 'u21 box paste source', {
      nodes: [
        {
          id: 'x',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { outputs: [{ name: 'body', type: 'string' }] },
        },
        {
          id: 'y',
          type: 'http_request',
          position: { x: 240, y: 0 },
          config: { url: 'https://example.test/${nodes.x.output.body}' },
        },
      ],
      edges: [{ id: 'e_xy', from: 'x', to: 'y', on: 'success' }],
      containers: [
        {
          id: 'loop_1',
          kind: 'loop',
          children: ['x', 'y'],
          exitWhen: '${equals(nodes.y.status, "success")}',
          maxRounds: 2,
        },
      ],
    });

    await page.getByRole('button', { name: 'Configure loop 1' }).click();
    await page.keyboard.press('Meta+c');
    await expect(page.getByText('Copied loop 1.')).toBeVisible();
    // A container is never cut — said, not silently ignored.
    await page.keyboard.press('Meta+x');
    await expect(page.getByText('A container cannot be cut. Copy it with ⌘C.')).toBeVisible();

    await openInApp(page, targetId, ['z', 'a']);
    await page.keyboard.press('Meta+v');
    await expect(page.getByText('Pasted loop 1 from another pipeline.')).toBeVisible();
    await expect(page.locator('.flow-container')).toHaveCount(1);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.getByText(/^Saved v2\.$/)).toBeVisible();

    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(targetId)}/versions`);
    expect(res.status()).toBe(200);
    const versions = (await res.json()) as {
      version: number;
      nodes: { id: string; config: Record<string, unknown> }[];
      edges: { from: string; to: string }[];
      containers: { id: string; children: string[]; exitWhen?: string }[];
    }[];
    const latest = versions.reduce((p, q) => (p.version > q.version ? p : q));
    expect(latest.containers).toHaveLength(1);
    const box = latest.containers[0]!;
    const copyY = latest.nodes.find(
      (n) => box.children.includes(n.id) && typeof n.config['url'] === 'string',
    )!;
    // THE POINT: the copy exits on ITS OWN copy of `y`...
    expect(box.exitWhen).toBe(`\${equals(nodes.${copyY.id}.status, "success")}`);
    // ...and nothing was wired to it off the target's coincident ids.
    expect(latest.edges).toHaveLength(2);
    expect(latest.edges.some((e) => e.to === box.id)).toBe(false);

    await expectQuiet(page, problems);
  });

  /* #935 — ⌘X then ⌘V in the SAME pipeline. The cut deletes `b`'s in-edge, so a
     paste that only re-derived edges from the live graph brought `b` back with
     no upstream while its url still read `a`: "Pasted", then refused at save. */
  test('a cut activity pastes back wired to its upstream, and saves', async ({ page }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'u21 cut paste', SOURCE);

    await nodeById(page, 'b').click();
    await page.keyboard.press('Meta+x');
    await expect(page.getByText('Cut 1 activity.')).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(edgeGroup(page)).toHaveCount(0);

    await page.keyboard.press('Meta+v');
    await expect(page.getByText('Pasted 1 activity.')).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(2);
    await expect(edgeGroup(page)).toHaveCount(1);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.getByText(/^Saved v2\.$/)).toBeVisible();

    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`);
    expect(res.status()).toBe(200);
    const versions = (await res.json()) as {
      version: number;
      nodes: { id: string; config: Record<string, unknown> }[];
      edges: { from: string; to: string }[];
    }[];
    const latest = versions.reduce((p, q) => (p.version > q.version ? p : q));
    const copy = latest.nodes.find((n) => n.id !== 'a')!;
    expect(copy.id).not.toBe('b');
    expect(copy.config['url']).toBe('https://example.test/${nodes.a.output.body}');
    expect(latest.edges).toEqual([expect.objectContaining({ from: 'a', to: copy.id })]);

    await expectQuiet(page, problems);
  });
});
