import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';

/**
 * U8a — the expression-insert flyout.
 *
 * Until this ticket, wiring one activity's output into another's input meant
 * knowing `${nodes.<id>.output.<name>}` by heart AND knowing which ids and
 * output names the graph actually contained. Nothing in the app said either.
 * The unit suites pin the catalog's rules and the caret arithmetic; what only an
 * e2e can prove is the property the ticket is about — that a reference CHOSEN
 * from the list survives the save gate and reaches the stored version.
 *
 * The second test is the load-bearing one. An `if` condition must be one whole
 * `${...}` expression, so a naive insert-at-cursor would splice into it and
 * produce a doc the gate REFUSES — and the refusal would surface as a disabled
 * Save, not as a message about the picker. Saving successfully is therefore the
 * assertion: it can only pass if the picker replaced rather than spliced.
 */

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

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

const FETCH = {
  id: 'fetch',
  type: 'http_request',
  position: { x: 0, y: 0 },
  config: {
    url: 'https://seed.test',
    method: 'GET',
    outputs: [{ name: 'body', type: 'string' }],
  },
};

test.describe('U8a — expression insert flyout', () => {
  test('an upstream output can be CHOSEN, and reaches the stored version', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u8a insert a reference', {
      nodes: [
        FETCH,
        { id: 'call', type: 'http_request', position: { x: 260, y: 0 }, config: { method: 'GET' } },
      ],
      edges: [{ id: 'e1', from: 'fetch', to: 'call', on: 'success' }],
    });

    await nodeById(page, 'call').click();
    await panel(page).getByRole('button', { name: 'Insert reference into url' }).click();

    // The discovery this ticket exists for: the producer is named by the title
    // its BOX carries, and its declared output name is spelled out — neither of
    // which the author had any way to read off the canvas before. The id is
    // appended because this doc has TWO `http_request` nodes, so the title alone
    // would not say which box the reference points at.
    const option = panel(page).getByRole('button', { name: /HTTP Request \(fetch\) → body/ });
    await expect(option).toBeVisible();
    await option.click();

    await expect(panel(page).getByRole('textbox', { name: 'url' })).toHaveValue(
      '${nodes.fetch.output.body}',
    );
    await panel(page).getByRole('button', { name: 'Apply config' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect(await persistedConfig(page, id, 'call')).toMatchObject({
      url: '${nodes.fetch.output.body}',
    });

    await expectQuiet(page, problems);
  });

  test('a type-checked field offers only what it would accept', async ({ page }) => {
    // A `filter`'s `items` must resolve to an ARRAY and is whole-value, so the
    // picker is in REPLACE mode there. Offering a string reference would destroy
    // the author's working expression and leave the doc unsavable — the one
    // combination that must never ship.
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u8a type checked field', {
      nodes: [
        {
          id: 'src',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: {
            url: 'https://seed.test',
            method: 'GET',
            outputs: [
              { name: 'rows', type: 'json' },
              { name: 'label', type: 'string' },
            ],
          },
        },
        {
          id: 'pick',
          type: 'filter',
          position: { x: 260, y: 0 },
          config: { items: '${nodes.src.output.rows}', predicate: '${item}' },
        },
      ],
      edges: [{ id: 'e1', from: 'src', to: 'pick', on: 'success' }],
    });

    await nodeById(page, 'pick').click();
    await panel(page).getByRole('button', { name: 'Insert reference into items' }).click();

    await expect(panel(page).getByRole('button', { name: /HTTP Request → rows/ })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /HTTP Request → label/ })).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: /^runId/ })).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('a whole-value field is REPLACED, so the doc it produces still saves', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u8a whole value field', {
      nodes: [
        FETCH,
        {
          id: 'gate',
          type: 'if',
          position: { x: 260, y: 0 },
          // A pre-existing value, so an insert-at-cursor has something to splice
          // INTO. With an empty field the two behaviours are indistinguishable
          // and this spec would pass either way.
          config: { condition: '${default(nodes.fetch.output.body, "")}' },
        },
      ],
      edges: [{ id: 'e1', from: 'fetch', to: 'gate', on: 'success' }],
    });

    await nodeById(page, 'gate').click();
    await panel(page).getByRole('button', { name: 'Insert reference into condition' }).click();

    // Said BEFORE the author commits: this field takes one expression, so the
    // choice is destructive.
    await expect(panel(page).getByText(/REPLACES its current value/)).toBeVisible();
    await panel(page)
      .getByRole('button', { name: /HTTP Request → body/ })
      .click();
    await panel(page).getByRole('button', { name: 'Apply config' }).click();

    // The whole point. A spliced value (`${default(…)}${nodes.…}`) is not a
    // whole-value expression, `validatePipelineDoc` refuses it, and Save is
    // gated on that — so this line fails outright if the mode probe regresses.
    await expect(page.locator('.badge-list')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect(await persistedConfig(page, id, 'gate')).toMatchObject({
      condition: '${nodes.fetch.output.body}',
    });

    await expectQuiet(page, problems);
  });
});
