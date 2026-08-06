import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { canvasNodes, edgeGroup, marqueeAllNodes, viewportSettled } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';

/**
 * U21 slice 3 — copy/paste on the authoring canvas, and the ref remapping that
 * makes a MULTI-node copy correct rather than merely plausible.
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
});
