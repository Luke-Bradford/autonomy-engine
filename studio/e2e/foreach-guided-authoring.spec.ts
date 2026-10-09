import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1420 OR26 part 2 — ForEach authoring that guides you.
 *
 * The operator's recipe is List Directory → Filter (files only) → ForEach
 * { Copy each file }. Writing it meant knowing that a listed entry is
 * `{name, type}` and that `${item.name}` reaches into one. Nothing in the app
 * said so. Now the picker offers the element's known fields wherever `${item}`
 * is bound: in a filter's predicate, and inside a box over the entries (through
 * the filter's result as well). The box also says in words whether its
 * batchCount means one item at a time or several at once.
 *
 * The save is the assertion that the offer is real, as in the U8a spec: a
 * reference the gate refused would leave Save disabled.
 */

/** One node's stored config, read back from the LATEST persisted version. */
async function persistedConfig(
  page: Page,
  pipelineId: string,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`);
  expect(res.status()).toBe(200);
  const items = (await res.json()) as {
    version: number;
    nodes: { id: string; config: Record<string, unknown> }[];
  }[];
  const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
  const node = latest.nodes.find((n) => n.id === nodeId);
  expect(node, `${nodeId} survived the save`).toBeTruthy();
  return node!.config;
}

test('#1420 — inside a ForEach over listed files, the picker offers item → name', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const id = await openSeededCanvas(page, '#1420 guided foreach', {
    nodes: [
      { id: 'list', type: 'file_list', position: { x: 0, y: 0 }, config: { path: 'in' } },
      {
        id: 'files',
        type: 'filter',
        position: { x: 260, y: 0 },
        config: { items: '${nodes.list.output.entries}', predicate: '${greater(2, 1)}' },
      },
      {
        id: 'fetch',
        type: 'http_request',
        position: { x: 540, y: 0 },
        config: { url: 'https://seed.test/', method: 'GET' },
      },
    ],
    edges: [
      { id: 'e1', from: 'list', to: 'files', on: 'success' },
      { id: 'e2', from: 'files', to: 'each', on: 'success' },
    ],
    containers: [
      {
        id: 'each',
        kind: 'foreach',
        children: ['fetch'],
        items: '${nodes.files.output.result}',
      },
    ],
  });

  // The filter's predicate: its own element is a listed entry.
  await nodeById(page, 'files').click();
  await properties(page).getByRole('button', { name: 'Insert reference into predicate' }).click();
  await expect(properties(page).getByRole('button', { name: /^item → type/ })).toBeVisible();

  // Inside the box: the element is the filter's result, whose elements are
  // still listed entries.
  await nodeById(page, 'fetch').click();
  await properties(page).getByRole('button', { name: 'Insert reference into url' }).click();
  await expect(properties(page).getByRole('button', { name: /^item — / })).toBeVisible();
  await properties(page)
    .getByRole('button', { name: /^item → name/ })
    .click();
  await properties(page).getByRole('button', { name: 'Apply config' }).click();

  await expect(page.locator('.badge-list')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.notice')).toHaveText('Saved v2.');
  expect(String((await persistedConfig(page, id, 'fetch')).url)).toContain('${item.name}');

  await expectQuiet(page, problems);
});

test('#1420 — a ForEach says whether batchCount runs items one at a time or together', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, '#1420 foreach mode', {
    nodes: [{ id: 'n_a', position: { x: 40, y: 60 } }],
    containers: [
      { id: 'foreach_1', kind: 'foreach', children: ['n_a'], items: '${createArray(1, 2)}' },
    ],
  });

  await page.getByRole('button', { name: 'Configure ForEach 1' }).click();
  const panel = properties(page);
  await panel.getByRole('tab', { name: 'Concurrency' }).click();
  await expect(panel.getByText(/^Sequential: items run one at a time, in order\./)).toBeVisible();
  await panel.getByLabel(/^Batch count/).fill('3');
  await expect(panel.getByText(/^Parallel: up to 3 items run at once\./)).toBeVisible();
  await expect(panel.getByText(/^Sequential:/)).toHaveCount(0);

  await expectQuiet(page, problems);
});
