import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #605 L9b — an `llm_call` with `capture: 'full'` shows the prompt it sent and
 * the completion it got, and a SECURE one shows neither.
 *
 * EGRESS-FREE: the provider is a stub on 127.0.0.1 answering Ollama's
 * `POST /api/chat`, which takes no credential. The studio server under test is
 * a local process, so it reaches the stub the way it would reach a self-hosted
 * Ollama. This is the first spec to drive a real `llm_call` adapter end to end;
 * `node-cost-and-tools.spec.ts` predates it and uses `agent_cli` instead.
 */

const PROMPT = 'Summarise the quarterly numbers in one line.';
const SYSTEM = 'You are terse.';
const ANSWER = 'Revenue up 4%, costs flat.';

let stub: Server;
let stubUrl: string;

test.beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          message: { role: 'assistant', content: ANSWER },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 12,
          eval_count: 8,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

async function runCaptured(
  page: import('@playwright/test').Page,
  name: string,
  policy?: Record<string, boolean>,
): Promise<string> {
  const created = await page.request.post('/api/connections', {
    data: { name: `${name} ollama`, kind: 'ollama', config: { baseUrl: stubUrl, model: 'stub' } },
  });
  expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
  const { id: connectionId } = (await created.json()) as { id: string };
  const doc = {
    nodes: [
      {
        id: 'ask',
        type: 'llm_call',
        config: { prompt: PROMPT, system: SYSTEM, capture: 'full' },
        connectionId,
        position: { x: 0, y: 0 },
        ...(policy !== undefined ? { policy } : {}),
      },
    ],
  };
  const { pipelineVersionId } = await seedVersion(page, name, doc);
  return fireAndSettle(page, pipelineVersionId, name);
}

async function openDrillIn(page: import('@playwright/test').Page, runId: string) {
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  await page.getByRole('button', { name: 'LLM Call 1' }).click();
  return page.getByRole('complementary', { name: /Node LLM Call 1/ });
}

test('#605 — a full-capture LLM node shows the prompt it sent and the answer it got', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const runId = await runCaptured(page, '#605 capture');

  /* The PREMISE, on the durable log: the text is really stored, so the UI
     assertions below cannot pass against a panel inventing it. */
  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  const events = (await eventsRes.json()) as { type: string; payload: Record<string, unknown> }[];
  const cap = events.find((e) => e.type === 'activity.captured');
  expect(cap?.payload).toMatchObject({
    completion: { text: ANSWER },
    request: { system: { text: SYSTEM }, messages: [{ role: 'user', text: PROMPT }] },
  });

  const panel = await openDrillIn(page, runId);
  const section = panel.getByRole('region', { name: 'Prompt and completion' });
  await expect(section).toBeVisible();
  await expect(section.getByText(SYSTEM, { exact: true })).toBeVisible();
  await expect(section.getByText(PROMPT, { exact: true })).toBeVisible();
  await expect(section.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(section.getByText(/withheld/)).toHaveCount(0);

  await expectQuiet(page, problems);
});

test('#605 — a SECURE full-capture node stores and shows only the marker', async ({ page }) => {
  const problems = collectPageProblems(page);
  const runId = await runCaptured(page, '#605 secure capture', {
    secureInput: true,
    secureOutput: true,
  });

  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  const raw = await eventsRes.text();
  for (const secret of [PROMPT, SYSTEM, ANSWER]) expect(raw).not.toContain(secret);

  const panel = await openDrillIn(page, runId);
  const section = panel.getByRole('region', { name: 'Prompt and completion' });
  await expect(section.getByText(/Secure input or Secure output set/)).toBeVisible();
  await expect(section.getByText(PROMPT)).toHaveCount(0);
  await expect(section.getByText(ANSWER)).toHaveCount(0);

  await expectQuiet(page, problems);
});
