import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { viewportSettled } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';

/**
 * U21 (#935) — duplicating a CONTAINER, body and all.
 *
 * The store rules are unit-tested (`canvasStore.test.ts`, "duplicateContainer").
 * What only a browser and a real server can prove is the round trip: that the
 * panel button and ⌘D reach the store, that the copy is DRAWN as its own box
 * beside the original, and that the doc it produces is one the SERVER's
 * `validatePipelineDoc` accepts — with the copy's `exitWhen` naming the copy's
 * own child. Left unremapped, that ref names the ORIGINAL loop's child, which
 * the save gate refuses because `exitWhen` is scoped to a container's children.
 */

type SavedVersion = {
  version: number;
  nodes: { id: string; config: Record<string, unknown> }[];
  edges: { from: string; to: string }[];
  containers: { id: string; kind: string; children: string[]; exitWhen?: string }[];
};

test.describe('duplicate a container (U21)', () => {
  test('the copy is its own box, exits on its own child, and saves', async ({ page }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'u21 container duplicate', {
      nodes: [
        {
          id: 'up',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { outputs: [{ name: 'body', type: 'string' }] },
        },
        {
          id: 'x',
          type: 'http_request',
          position: { x: 260, y: 0 },
          config: { outputs: [{ name: 'body', type: 'string' }] },
        },
        {
          id: 'y',
          type: 'http_request',
          position: { x: 500, y: 0 },
          config: { url: 'https://example.test/${nodes.x.output.body}' },
        },
      ],
      edges: [
        { id: 'e_in', from: 'up', to: 'loop_1', on: 'success' },
        { id: 'e_xy', from: 'x', to: 'y', on: 'success' },
      ],
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
    await viewportSettled(page);
    const boxes = page.locator('.flow-container');
    await expect(boxes).toHaveCount(1);

    await page.getByRole('button', { name: 'Configure loop 1' }).click();
    await page.getByRole('button', { name: 'Duplicate container' }).click();
    await expect(page.getByText('Duplicated loop 1.')).toBeVisible();
    await expect(boxes).toHaveCount(2);
    // The copy is the panel's subject now — "another one of these, but different".
    const panel = page.getByRole('complementary', { name: 'Properties' });
    await expect(panel.getByRole('heading', { name: 'loop 2' })).toBeVisible();

    // Beside the original, not over it: the two drawn boxes do not intersect.
    await viewportSettled(page);
    const [a, b] = await Promise.all([boxes.nth(0).boundingBox(), boxes.nth(1).boundingBox()]);
    expect(a && b, 'both boxes are drawn').toBeTruthy();
    const overlap = a!.x < b!.x + b!.width && b!.x < a!.x + a!.width;
    const sameBand = a!.y < b!.y + b!.height && b!.y < a!.y + a!.height;
    expect(overlap && sameBand, 'the copy box overlaps the original').toBe(false);

    // ⌘D on a selected container duplicates it too. The third box lands clear
    // of both others, past the pane's right edge, so it is only DRAWN at all
    // (`onlyRenderVisibleElements`) because a container that appears is panned
    // into view — the canvas's current subject is never left culled.
    await page.keyboard.press('Meta+d');
    await expect(page.getByText('Duplicated loop 2.')).toBeVisible();
    await expect(page.getByRole('group', { name: /^loop 3 container/ })).toBeInViewport();

    await page.getByRole('button', { name: 'Save version' }).click();
    // The server runs `validatePipelineDoc` on the write; an exitWhen still
    // naming the original loop's child is refused here.
    await expect(page.getByText(/^Saved v2\.$/)).toBeVisible();

    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`);
    expect(res.status()).toBe(200);
    const versions = (await res.json()) as SavedVersion[];
    const latest = versions.reduce((p, q) => (p.version > q.version ? p : q));
    expect(latest.containers).toHaveLength(3);
    expect(latest.nodes).toHaveLength(7);
    for (const copy of latest.containers.filter((c) => c.id !== 'loop_1')) {
      expect(copy.children).toHaveLength(2);
      expect(copy.children.some((id) => ['x', 'y'].includes(id))).toBe(false);
      // THE POINT: the copy exits on ITS OWN copy of `y`...
      const copyY = latest.nodes.find(
        (n) => copy.children.includes(n.id) && typeof n.config['url'] === 'string',
      )!;
      expect(copy.exitWhen).toBe(`\${equals(nodes.${copyY.id}.status, "success")}`);
      // ...and keeps the upstream the original box was wired from.
      expect(latest.edges).toContainEqual(expect.objectContaining({ from: 'up', to: copy.id }));
    }

    await expectQuiet(page, problems);
  });
});
