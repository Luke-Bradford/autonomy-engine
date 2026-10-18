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

    // General, then §4.6's Request · Auth · Settings, left to right.
    await expect(properties(page).getByRole('tab')).toHaveCount(4);
    const xs: number[] = [];
    for (const name of ['General', 'Request', 'Auth', 'Settings']) {
      xs.push((await tab(page, name).boundingBox())!.x);
    }
    expect(xs).toEqual([...xs].sort((a, b) => a - b));

    await tab(page, 'Request').click();
    await pickConnection(page, 'Connection', { id: http });
    await expect(combobox(page, 'Method').locator('option:checked')).toHaveText('GET (default)');

    // ADF's defaults, shown unset.
    await tab(page, 'Settings').click();
    await expect(checkbox(page, 'Fail on HTTP error')).toBeChecked();
    await expect(
      properties(page).getByRole('textbox', { name: /^Treat as success/ }),
    ).toBeVisible();
    await expect(combobox(page, 'Parse as').locator('option:checked')).toHaveText('JSON (default)');
    await expect(combobox(page, 'When over the limit').locator('option:checked')).toHaveText(
      'Fail (default)',
    );
    await expect(checkbox(page, 'Retry on 429 and 503')).toBeChecked();
    // Measured at 1440x900: the whole Settings tab is in the docked pane's
    // view, its short fields packed in pairs (seven fields, five rows).
    const pane = (await properties(page).boundingBox())!;
    for (const control of [
      checkbox(page, 'Retry on 429 and 503'),
      combobox(page, 'When over the limit'),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(Math.min(pane.y + pane.height, 900));
    }
    const failBox = (await checkbox(page, 'Fail on HTTP error').boundingBox())!;
    const retryBox = (await checkbox(page, 'Retry on 429 and 503').boundingBox())!;
    expect(Math.abs(failBox.y - retryBox.y)).toBeLessThan(4);

    // Treat as success is Fail on HTTP error's: it goes when that is off.
    await checkbox(page, 'Fail on HTTP error').uncheck();
    await expect(properties(page).getByRole('textbox', { name: /^Treat as success/ })).toHaveCount(
      0,
    );
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
    expect(latest.nodes[0]!.config).toMatchObject({ url: '/items' });
    // Ticked back to its default, Fail on HTTP error writes nothing: the key
    // stays absent and the schema's default (on) applies.
    expect(latest.nodes[0]!.config).not.toHaveProperty('failOnHttpError');

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
      nodes: [
        {
          id: 'call',
          type: 'web',
          position: { x: 0, y: 0 },
          connectionId: http,
          config: { url: '/missing' },
        },
      ],
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

test.describe('#1600 C11b — a stored HTTP request opens as Web', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('it keeps its run, opens as Web with Fail on HTTP error off and Parse as Text, and saves as Web', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const http = await seedConnection(page, {
      name: 'e2e 1600 c11b http',
      kind: 'http',
      config: { baseUrl: stubUrl },
    });
    const { pipelineId, pipelineVersionId } = await seedVersion(page, 'e2e 1600 c11b legacy', {
      nodes: [
        {
          id: 'call',
          type: 'http_request',
          position: { x: 0, y: 0 },
          connectionId: http,
          config: { url: '/missing', method: 'get' },
        },
      ],
    });
    const answerOf = async (versionId: string, name: string) => {
      const runId = await fireAndSettle(page, versionId, name);
      const done = (await eventsOf(page, runId)).find(
        (e) => e.type === 'node.succeeded' && e.payload['nodeId'] === 'call',
      );
      expect(done, 'the node succeeds: a 404 is data, not a failure').toBeDefined();
      const { status, body } = done!.payload['outputs'] as Record<string, unknown>;
      return { status, body };
    };
    // The stored version is untouched by the lowering: it runs as http_request.
    const before = await answerOf(pipelineVersionId, 'e2e 1600 c11b old');
    expect(before).toEqual({ status: 404, body: '{"error":"no such path"}' });

    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(
      toolbox(page).getByRole('button', { name: 'HTTP request', exact: true }),
    ).toHaveCount(0);
    await expect(toolbox(page).getByRole('button', { name: 'Web', exact: true })).toBeVisible();
    await canvasNodes(page)
      .filter({ hasText: /^Web\b/ })
      .click();
    await expect(combobox(page, 'Method').locator('option:checked')).toHaveText('GET');
    await tab(page, 'Settings').click();
    await expect(checkbox(page, 'Fail on HTTP error')).not.toBeChecked();
    await expect(combobox(page, 'Parse as').locator('option:checked')).toHaveText('Text');
    // Any edit saves the node as its replacement.
    await tab(page, 'General').click();
    await properties(page)
      .getByRole('textbox', { name: 'Activity description' })
      .fill('lowered from HTTP request');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const versions = (await (
      await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
    ).json()) as {
      id: string;
      version: number;
      nodes: { id: string; type: string; config: Record<string, unknown> }[];
    }[];
    const latest = versions.sort((a, b) => b.version - a.version)[0]!;
    expect(latest.nodes[0]).toMatchObject({
      id: 'call',
      type: 'web',
      config: { url: '/missing', method: 'GET', failOnHttpError: false, parseAs: 'text' },
    });
    // The re-saved node answers as the old one did.
    expect(await answerOf(latest.id, 'e2e 1600 c11b new')).toEqual(before);
    await expectQuiet(page, problems);
  });
});
