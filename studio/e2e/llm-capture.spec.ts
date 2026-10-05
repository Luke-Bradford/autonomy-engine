import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';
import { nodesTable } from './support/panels';

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
/* #605 — a structured node's stub answers: out-of-enum on the first request,
   valid on the repair. Chosen from the REQUEST (its turn count), never from a
   call counter, so a retried test sees the same sequence. */
const STRUCT_PROMPT = 'Classify this ticket: the export button crashes.';
const STRUCT_INVALID = '{"category":"question"}';
const STRUCT_VALID = '{"category":"bug"}';
/* #605 — a tool node's stub asks for `adder` until a tool result has been
   sent, then answers. Chosen from the REQUEST, as above. */
const TOOL_PROMPT = 'What is 19 plus 23? Use the adder.';
const TOOL_ANSWER = 'It is 42.';
/* #605 — the stub's reasoning, sent as Ollama's `message.thinking` whenever the
   request set `think` (a node's `reasoningEffort`), as a thinking model does. */
const THINKING = 'The numbers moved little; lead with revenue.';
const TRACE = { capture: 'full', captureReasoning: true, reasoningEffort: 'high' };
const ADDER = {
  name: 'adder',
  description: 'Adds two numbers.',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
  expression: '${add(tool.args.a, tool.args.b)}',
};

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
      const sent = JSON.parse(body) as {
        format?: unknown;
        tools?: unknown;
        think?: unknown;
        messages: { role: string }[];
      };
      const turns = sent.messages.filter((m) => m.role !== 'system').length;
      const askForTool = sent.tools !== undefined && !sent.messages.some((m) => m.role === 'tool');
      const content =
        sent.tools !== undefined
          ? askForTool
            ? ''
            : TOOL_ANSWER
          : sent.format === undefined
            ? ANSWER
            : turns === 1
              ? STRUCT_INVALID
              : STRUCT_VALID;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content,
            ...(sent.think !== undefined ? { thinking: THINKING } : {}),
            ...(askForTool
              ? { tool_calls: [{ function: { name: 'adder', arguments: { a: 19, b: 23 } } }] }
              : {}),
          },
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
  config: Record<string, unknown> = { prompt: PROMPT, system: SYSTEM, capture: 'full' },
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
        config,
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
  await nodesTable(page).getByRole('button', { name: 'LLM Call 1' }).click();
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
  const section = panel.getByRole('region', { name: 'Prompt & completion' });
  await expect(section).toBeVisible();
  await expect(section.getByText(SYSTEM, { exact: true })).toBeVisible();
  await expect(section.getByText(PROMPT, { exact: true })).toBeVisible();
  await expect(section.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(section.getByText(/withheld/)).toHaveCount(0);

  await expectQuiet(page, problems);
});

test('#605 — a SECURE full-capture node stores and shows only the marker', async ({ page }) => {
  const problems = collectPageProblems(page);
  const runId = await runCaptured(
    page,
    '#605 secure capture',
    { secureInput: true, secureOutput: true },
    // The reasoning trace too: the model's text about a secret input is secret.
    { prompt: PROMPT, system: SYSTEM, ...TRACE },
  );

  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  const raw = await eventsRes.text();
  for (const secret of [PROMPT, SYSTEM, ANSWER, THINKING]) expect(raw).not.toContain(secret);
  /* Non-vacuous: the trace WAS captured and withheld, not simply never asked for. */
  const events = JSON.parse(raw) as { type: string; payload: Record<string, unknown> }[];
  expect(events.find((e) => e.type === 'activity.captured')?.payload).toMatchObject({
    reasoning: { text: '[redacted: secure]' }, // SECURE_REDACTED
  });

  const panel = await openDrillIn(page, runId);
  const section = panel.getByRole('region', { name: 'Prompt & completion' });
  await expect(section.getByText(/Secure input or Secure output set/)).toBeVisible();
  await expect(section.getByText(PROMPT)).toHaveCount(0);
  await expect(section.getByText(ANSWER)).toHaveCount(0);

  await expectQuiet(page, problems);
});

test('#605 — a node that opted into its reasoning trace shows the model’s summary', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const runId = await runCaptured(page, '#605 reasoning trace', undefined, {
    prompt: PROMPT,
    system: SYSTEM,
    ...TRACE,
  });

  /* The PREMISE, on the durable log: the trace is stored beside, not inside,
     the completion. */
  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  const events = (await eventsRes.json()) as { type: string; payload: Record<string, unknown> }[];
  expect(events.find((e) => e.type === 'activity.captured')?.payload).toMatchObject({
    reasoning: { text: THINKING },
    completion: { text: ANSWER },
  });

  const panel = await openDrillIn(page, runId);
  const section = panel.getByRole('region', { name: 'Prompt & completion' });
  await expect(
    section.getByRole('heading', { name: "Reasoning (the model's summary)" }),
  ).toBeVisible();
  await expect(section.getByText(THINKING, { exact: true })).toBeVisible();
  await expect(section.getByText(ANSWER, { exact: true })).toBeVisible();

  await expectQuiet(page, problems);
});

test('#605 — a structured node that needed a repair shows BOTH exchanges', async ({ page }) => {
  const problems = collectPageProblems(page);
  const runId = await runCaptured(page, '#605 structured capture', undefined, {
    prompt: STRUCT_PROMPT,
    outputMode: 'structured',
    outputSchema: {
      type: 'object',
      properties: { category: { type: 'string', enum: ['bug', 'feature'] } },
    },
    capture: 'full',
  });

  /* The PREMISE, on the durable log: one capture per provider response, the
     repair's request carrying the critique studio sent. */
  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  const events = (await eventsRes.json()) as { type: string; payload: Record<string, unknown> }[];
  expect(events.find((e) => e.type === 'run.finished')?.payload).toMatchObject({
    outcome: 'success',
  });
  const caps = events
    .filter((e) => e.type === 'activity.captured')
    .map((e) => e.payload as { request: { messages: { text: string }[] }; completion: unknown });
  expect(caps).toHaveLength(2);
  expect(caps[0]!.completion).toMatchObject({ text: STRUCT_INVALID });
  expect(caps[1]!.completion).toMatchObject({ text: STRUCT_VALID });
  expect(caps[1]!.request.messages.at(-1)!.text).toContain('structured output schema');

  const panel = await openDrillIn(page, runId);
  const section = panel.getByRole('region', { name: 'Prompt & completion' });
  const exchange = (n: number) =>
    section.locator('details', {
      has: page.locator('summary', { hasText: new RegExp(`^Exchange ${n}\\b`) }),
    });
  // The latest exchange is the one open by default: the corrected answer.
  await expect(exchange(2).getByText(STRUCT_VALID, { exact: true })).toBeVisible();
  await expect(exchange(2).getByText(/structured output schema/)).toBeVisible();
  await exchange(1).locator('summary').click();
  await expect(exchange(1).getByText(STRUCT_PROMPT, { exact: true })).toBeVisible();
  await expect(exchange(1).getByText(STRUCT_INVALID, { exact: true })).toBeVisible();

  await expectQuiet(page, problems);
});

test('#605 — a tool-using node shows every round, with the calls and results it sent', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const runId = await runCaptured(page, '#605 tool capture', undefined, {
    prompt: TOOL_PROMPT,
    tools: [ADDER],
    capture: 'full',
  });

  /* The PREMISE, on the durable log: one capture per round, the second
     recording the call and its result as marked turns. */
  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  const events = (await eventsRes.json()) as { type: string; payload: Record<string, unknown> }[];
  expect(events.find((e) => e.type === 'run.finished')?.payload).toMatchObject({
    outcome: 'success',
  });
  const caps = events
    .filter((e) => e.type === 'activity.captured')
    .map(
      (e) =>
        e.payload as {
          request: { messages: { role: string; toolTurn?: string; text: string }[] };
          completion?: { text: string };
        },
    );
  expect(caps).toHaveLength(2);
  expect(caps[0]!.completion).toBeUndefined();
  expect(caps[1]!.request.messages).toMatchObject([
    { role: 'user', text: TOOL_PROMPT },
    {
      role: 'assistant',
      toolTurn: 'calls',
      text: JSON.stringify([{ name: 'adder', args: { a: 19, b: 23 } }]),
    },
    { role: 'user', toolTurn: 'result', text: '42' },
  ]);
  expect(caps[1]!.completion).toMatchObject({ text: TOOL_ANSWER });

  const panel = await openDrillIn(page, runId);
  const section = panel.getByRole('region', { name: 'Prompt & completion' });
  const second = section.locator('details', {
    has: page.locator('summary', { hasText: /^Exchange 2\b/ }),
  });
  await expect(second.getByRole('heading', { name: 'Tool calls' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Tool result', exact: true })).toBeVisible();
  await expect(second.getByText('42', { exact: true })).toBeVisible();
  await expect(second.getByText(TOOL_ANSWER, { exact: true })).toBeVisible();

  await expectQuiet(page, problems);
});
