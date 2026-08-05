import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { canvasNodes, edgeGroup, viewportSettled } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';

/**
 * U21 — duplicating a node on the authoring canvas.
 *
 * The store's rules are unit-tested (`canvasStore.test.ts`); what only a real
 * browser and a real server can prove is the round trip — that the control is
 * wired to the action, that the copy is DRAWN, and that the doc it produces is
 * one the SAVE GATE accepts. That last part is the point of the ticket rather
 * than a bonus: the copy inherits `${nodes.a.output.body}` from the node it was
 * copied from, and `validateRefs` scopes a ref to the node's upstream set, so a
 * copy that did not inherit the incoming edge would be refused by the very same
 * validator on the server. A jsdom test cannot see that refusal.
 *
 * Every assertion below was mutation-checked (recorded in the PR): each fails
 * when the behaviour it names is removed.
 */
test.describe('duplicate a node (U21)', () => {
  test('the copy carries the config AND the upstream, and the doc still saves', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'u21 duplicate', {
      nodes: [
        { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'b',
          type: 'http_request',
          position: { x: 240, y: 0 },
          // Reads `a`. This is the config that makes the copy's inherited edge
          // load-bearing rather than cosmetic.
          config: { url: 'https://example.test/${nodes.a.output.body}' },
        },
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' }],
    });

    await page.getByTestId('rf__node-b').click();
    const panel = page.getByRole('complementary', { name: 'Properties' });
    await expect(panel.getByRole('textbox', { name: 'url' })).toHaveValue(
      'https://example.test/${nodes.a.output.body}',
    );

    await panel.getByRole('button', { name: 'Duplicate node' }).click();

    // Drawn: three nodes, and a second edge out of `a` into the copy.
    await expect(canvasNodes(page)).toHaveCount(3);
    await expect(edgeGroup(page)).toHaveCount(2);
    await viewportSettled(page);

    // The panel followed the selection onto the copy — you duplicate in order to
    // edit the copy — and the copy is holding the config it was copied from.
    await expect(panel.getByRole('textbox', { name: 'url' })).toHaveValue(
      'https://example.test/${nodes.a.output.body}',
    );

    await page.getByRole('button', { name: 'Save version' }).click();
    // The server runs `validatePipelineDoc` on the write. A copy stranded
    // without its upstream would come back refused, and this line is where that
    // shows up.
    await expect(page.getByText(/^Saved v2\.$/)).toBeVisible();

    const res = await page.request.get(
      `/api/pipelines/${encodeURIComponent(pipelineId)}/versions`,
    );
    expect(res.status()).toBe(200);
    const versions = (await res.json()) as {
      version: number;
      nodes: { id: string; config: Record<string, unknown> }[];
      edges: { from: string; to: string }[];
    }[];
    const latest = versions.reduce((x, y) => (x.version > y.version ? x : y));

    expect(latest.nodes).toHaveLength(3);
    const copy = latest.nodes.find((n) => n.id !== 'a' && n.id !== 'b');
    expect(copy, 'the copy is a NEW node, not a rewrite of the source').toBeTruthy();
    expect(copy!.config['url']).toBe('https://example.test/${nodes.a.output.body}');
    // Its inherited edge is persisted, and the source keeps its own.
    expect(latest.edges.filter((e) => e.to === copy!.id)).toEqual([
      expect.objectContaining({ from: 'a' }),
    ]);
    expect(latest.edges.filter((e) => e.to === 'b')).toHaveLength(1);

    await expectQuiet(page, problems);
  });
});
