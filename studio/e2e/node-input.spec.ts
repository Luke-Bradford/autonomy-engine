import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { seedConnection } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #890 — the drill-in's Input section shows the config a node was DISPATCHED
 * with (after `${}` substitution), and a secure node's input is withheld both
 * on screen and in the stored log.
 *
 * Both nodes also bind a connection PARAMETER (`maxEntries`, declared on the
 * connection), which the drill-in shows under its own Parameters heading and
 * withholds on the secure node with the config.
 *
 * `file_list` over a local `fs` connection, because a control activity (`fail`,
 * `filter`) is settled by the engine and never dispatched, so it records no
 * input at all — and this needs no network.
 */
test('#890 — a node shows the input it ran with; a secure node withholds it', async ({ page }) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-890-')));
  try {
    const visible = join(root, 'visible-dir');
    const hidden = join(root, 'hidden-890-dir');
    mkdirSync(visible);
    mkdirSync(hidden);
    const connectionId = await seedConnection(page, {
      name: '#890 local files',
      kind: 'fs',
      config: { roots: [root] },
      parameters: ['maxEntries'],
    });
    const { pipelineVersionId } = await seedVersion(page, '#890 input', {
      params: [{ name: 'dir', type: 'string' as const, required: false, default: visible }],
      nodes: [
        {
          id: 'shown',
          type: 'file_list',
          connectionId,
          config: { path: '${params.dir}' },
          connectionParams: { maxEntries: 50 },
          position: { x: 0, y: 0 },
        },
        {
          id: 'secure',
          type: 'file_list',
          connectionId,
          config: { path: hidden },
          connectionParams: { maxEntries: 4321 },
          policy: { secureInput: true },
          position: { x: 0, y: 200 },
        },
      ],
    });
    const runId = await fireAndSettle(page, pipelineVersionId);

    /* The stored log first: the substituted path is on the plain node's
       dispatch, and the secure node's dispatch holds only the marker. */
    const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
    expect(res.status()).toBe(200);
    const events = (await res.json()) as { payload: Record<string, unknown> }[];
    const inputOf = (nodeId: string) =>
      events.find((e) => e.payload['type'] === 'node.dispatched' && e.payload['nodeId'] === nodeId)
        ?.payload['input'] as { text: string } | undefined;
    expect(JSON.parse(inputOf('shown')?.text ?? 'null')).toEqual({ path: visible });
    expect(inputOf('secure')?.text).toBe('[redacted: secure]');
    const paramsOf = (nodeId: string) =>
      events.find((e) => e.payload['type'] === 'node.dispatched' && e.payload['nodeId'] === nodeId)
        ?.payload['params'] as { text: string } | undefined;
    expect(JSON.parse(paramsOf('shown')?.text ?? 'null')).toEqual({
      connectionParams: { maxEntries: 50 },
    });
    expect(paramsOf('secure')?.text).toBe('[redacted: secure]');
    const secureDispatch = events.find(
      (e) => e.payload['type'] === 'node.dispatched' && e.payload['nodeId'] === 'secure',
    );
    expect(JSON.stringify(secureDispatch)).not.toContain('hidden-890-dir');
    expect(JSON.stringify(secureDispatch)).not.toContain('4321');

    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);

    await page.getByRole('button', { name: 'List Directory 1', exact: true }).click();
    const shown = page.getByRole('complementary', { name: 'Node List Directory 1' });
    const shownInput = shown.locator('section', {
      has: page.getByRole('heading', { name: 'Input' }),
    });
    await expect(shownInput.locator('code.node-detail-outputs')).toHaveText([
      JSON.stringify({ path: visible }),
      JSON.stringify({ connectionParams: { maxEntries: 50 } }),
    ]);
    await expect(shownInput.getByRole('heading', { name: 'Parameters' })).toBeVisible();

    await page.getByRole('button', { name: 'List Directory 2', exact: true }).click();
    const secure = page.getByRole('complementary', { name: 'Node List Directory 2' });
    const secureInput = secure.locator('section', {
      has: page.getByRole('heading', { name: 'Input' }),
    });
    await expect(secureInput).toContainText('withheld from the run log');
    await expect(secureInput).not.toContainText('hidden-890-dir');
    await expect(secureInput).not.toContainText('4321');
    await expect(secureInput.getByText(/withheld from the run log/)).toHaveCount(2);

    await expectQuiet(page, problems);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
