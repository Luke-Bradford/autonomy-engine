import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { fluentRootReady, resolvedPaletteColor, setTheme } from './support/theme';

/**
 * #1394 OR3 slice 2 — the run graph draws the authoring card (name, what the
 * step does, badges) with what the run measured under the status, and the
 * authoring canvas's map can be folded away.
 *
 * Egress-free: a one-second `wait` (a real, measured span) into a `fail` (a
 * single terminal event, so no span at all), both inside a stage so the card's
 * fixed height is checked against the box drawn around it.
 */
const DOC = {
  nodes: [
    {
      id: 'hold',
      type: 'wait',
      config: { seconds: '${1}' },
      policy: { retry: 2 },
      position: { x: 0, y: 0 },
    },
    { id: 'stop', type: 'fail', config: { message: 'planned' }, position: { x: 300, y: 0 } },
  ],
  edges: [{ from: 'hold', to: 'stop', on: 'success' as const }],
  containers: [{ id: 'stg', kind: 'stage' as const, children: ['hold', 'stop'] }],
};

test('a run card says what the step does and what the run measured, inside its box', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const { pipelineVersionId } = await seedVersion(page, 'OR3 run cards', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, 'OR3 run cards');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const canvas = page.getByTestId('run-canvas');
  // Retrying waits for the OVERLAY (the graph draws before the replay lands).
  await expect(canvas.locator('.run-node-failure')).toHaveCount(1);
  await expect(canvas.locator('.run-node-facts')).toHaveCount(1);

  // One evaluate, every fact.
  const read = await page.evaluate(() => {
    const box = document
      .querySelector('.react-flow__node[data-id="stg"] .run-container')!
      .getBoundingClientRect();
    const card = (id: string) => {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"] .run-node`)!;
      const r = node.getBoundingClientRect();
      const txt = (sel: string) => node.querySelector(sel)?.textContent?.trim() ?? null;
      return {
        title: txt('.flow-node-title'),
        summary: txt('.flow-node-summary'),
        badges: [...node.querySelectorAll('.flow-node-badge')].map((b) =>
          b.getAttribute('aria-label'),
        ),
        status: txt('.run-node-status'),
        facts: txt('.run-node-facts'),
        glyph: node.querySelector('.flow-node-icon svg') !== null,
        height: (node as HTMLElement).offsetHeight,
        overflows: node.scrollHeight > node.clientHeight,
        insideBox:
          r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right,
      };
    };
    return { hold: card('hold'), stop: card('stop') };
  });

  expect(read.hold).toMatchObject({
    title: 'Wait 1',
    summary: 'wait 1s',
    badges: ['Retries up to 2 times'],
    status: 'Succeeded',
    glyph: true,
    // One FIXED height (`RUN_NODE_BASE_HEIGHT`), which the box is drawn from.
    height: 104,
    overflows: false,
    insideBox: true,
  });
  // A real measurement of a one-second timer — asserted by shape, not value.
  expect(read.hold.facts).toMatch(/^\d+(ms|s)$/);
  // A `fail` settles on ONE event: nothing was measured, so nothing is said.
  expect(read.stop).toMatchObject({
    summary: 'planned',
    facts: null,
    height: 104,
    overflows: false,
    insideBox: true,
  });

  // The measured line is muted text in both themes.
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(page, theme);
    const muted = await resolvedPaletteColor(page, '--muted');
    const drawn = await canvas
      .locator('.run-node-facts')
      .evaluate((e) => getComputedStyle(e).color);
    expect(drawn, theme).toBe(muted);
  }

  await expectQuiet(page, problems);
});

test('the map folds away, and stays folded after a reload', async ({ page }) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'OR3 map toggle', {
    nodes: [{ id: 'w', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } }],
  });
  const map = page.locator('.react-flow__minimap');
  await expect(map).toBeVisible();

  await page.getByRole('button', { name: 'Hide map' }).click();
  await expect(map).toHaveCount(0);
  const show = page.getByRole('button', { name: 'Show map' });
  await expect(show).toHaveAttribute('aria-pressed', 'false');

  await page.reload();
  await fluentRootReady(page);
  await page.locator('.react-flow__renderer').waitFor();
  await expect(show).toBeVisible();
  await expect(map).toHaveCount(0);

  await show.click();
  await expect(map).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide map' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectQuiet(page, problems);
});
