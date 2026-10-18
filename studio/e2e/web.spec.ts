import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, fillSelectedNodeConfig, toolbox } from './support/canvasGraph';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { pickConnection, properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C11a — Web on an http connection (activity catalogue §4.6, ADF's
 * Web activity).
 *
 * What only a browser can show: the palette offers Web beside Webhook, its
 * Request · Auth · Settings tabs draw inside 1440x900 with ADF's defaults (Fail
 * on HTTP error on, so Treat as success shows; Parse as JSON), the form saves the
 * config, and the saved version reads a JSON response into `body`. A 404 FAILS
 * the run, where `http_request` succeeds with it.
 *
 * EGRESS-FREE: the endpoint is a stub on 127.0.0.1, as in `llm-capture.spec.ts`.
 */

const ITEMS = { rows: [{ id: 1 }, { id: 2 }] };

let stub: Server;
let stubUrl: string;

test.beforeAll(async () => {
  stub = createServer((req, res) => {
    if (req.url === '/items') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ITEMS));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no such path"}');
    }
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

const tab = (page: Page, name: string) => properties(page).getByRole('tab', { name, exact: true });
const checkbox = (page: Page, name: string) =>
  properties(page).getByRole('checkbox', { name, exact: true });
const combobox = (page: Page, name: string) =>
  properties(page).getByRole('combobox', { name, exact: true });

type RunEvent = { type: string; payload: Record<string, unknown> };
const eventsOf = async (page: Page, runId: string) =>
  (await (
    await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
  ).json()) as RunEvent[];

test.describe('#1600 C11a — Web', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('authors a Web call and reads its JSON response', async ({ page }) => {
    const problems = collectPageProblems(page);
    const http = await seedConnection(page, {
      name: 'e2e 1600 c11a http',
      kind: 'http',
      config: { baseUrl: stubUrl },
    });
    const pipelineId = await openSeededCanvas(page, 'e2e 1600 c11a web', { nodes: [] });

    // `exact`: Webhook (external wait) sits in the same group.
    await expect(toolbox(page).getByRole('button', { name: 'Web', exact: true })).toHaveCount(1);
    await addActivity(page, 'Web');
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();

    await expect(properties(page).getByRole('tab')).toHaveText([
      'General',
      'Request',
      'Auth',
      'Settings',
    ]);

    await tab(page, 'Request').click();
    await pickConnection(page, 'Connection', { id: http });
    await expect(combobox(page, 'Method').locator('option:checked')).toHaveText('GET (default)');

    // ADF's defaults, shown unset.
    await tab(page, 'Settings').click();
    await expect(checkbox(page, 'Fail on HTTP error')).toBeChecked();
    await expect(properties(page).getByLabel('Treat as success', { exact: true })).toBeVisible();
    await expect(combobox(page, 'Parse as').locator('option:checked')).toHaveText('JSON (default)');
    await expect(
      combobox(page, 'When over the limit').locator('option:checked'),
    ).toHaveText('Fail (default)');
    await expect(checkbox(page, 'Retry on 429 and 503')).toBeChecked();
    // Measured at 1440x900: the whole Settings tab is in the docked pane's view.
    const last = await checkbox(page, 'Retry on 429 and 503').boundingBox();
    expect(last, 'Retry on 429 and 503 has a box').not.toBeNull();
    expect(last!.y + last!.height).toBeLessThanOrEqual(900);

    // Treat as success is Fail on HTTP error's: it goes when that is off.
    await checkbox(page, 'Fail on HTTP error').uncheck();
    await expect(properties(page).getByLabel('Treat as success', { exact: true })).toHaveCount(0);
    await checkbox(page, 'Fail on HTTP error').check();

    await fillSelectedNodeConfig(page, { 'Request URL': '/items' });
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const versions = (await (
      await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
    ).json()) as {
      id: string;
      version: number;
      nodes: { type: string; config: Record<string, unknown> }[];
    }[];
    const latest = versions.sort((a, b) => b.version - a.version)[0]!;
    expect(latest.nodes.map((n) => n.type)).toEqual(['web']);
    expect(latest.nodes[0]!.config).toMatchObject({ url: '/items', failOnHttpError: true });

    const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c11a');
    const events = await eventsOf(page, runId);
    const done = events.find((e) => e.type === 'node.succeeded');
    expect(done, `events: ${JSON.stringify(events.map((e) => e.type))}`).toBeDefined();
    expect(done!.payload.outputs).toMatchObject({
      status: 200,
      body: ITEMS,
      bytes: JSON.stringify(ITEMS).length,
      truncated: false,
      callback: null,
    });
    await expectQuiet(page, problems);
  });

  test('a 404 fails the run, with the status and the response excerpt', async ({ page }) => {
    const http = await seedConnection(page, {
      name: 'e2e 1600 c11a http 404',
      kind: 'http',
      config: { baseUrl: stubUrl },
    });
    const { pipelineVersionId } = await seedVersion(page, 'e2e 1600 c11a web 404', {
      nodes: [{ id: 'call', type: 'web', connectionId: http, config: { url: '/missing' } }],
    });
    const runId = await fireAndSettle(page, pipelineVersionId, 'e2e 1600 c11a 404');
    const run = (await (
      await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)
    ).json()) as { status: string };
    expect(run.status).toBe('failure');
    const failed = (await eventsOf(page, runId)).find((e) => e.type === 'node.failed');
    expect(failed?.payload).toMatchObject({ kind: 'permanent' });
    expect(String(failed?.payload.error)).toBe('HTTP 404 Not Found: {"error":"no such path"}');
  });
});
