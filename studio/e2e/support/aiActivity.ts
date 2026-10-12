import type { Page } from '@playwright/test';

/**
 * A stubbed `/api/monitor/ai-activity` snapshot for Monitor › AI activity.
 *
 * CI's database has no metered events, so the real endpoint can only ever
 * produce the empty page. #967's chart spec and #1594 OR40 S6r's design spec
 * both need a page with data on it, so the snapshot lives here once.
 */

/** A snapshot with one bucket of each kind the chart must tell apart. */
export function seriesSnapshot() {
  const zeroCost = {
    currency: 'USD',
    totalCostEstimate: 0,
    responseCount: 0,
    pricedResponseCount: 0,
    unpricedResponseCount: 0,
    costUnknownResponseCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    // #1025 — the per-side presence counts now arrive INSIDE `cost`, and
    // `RunCostSchema` is the live parser for this stubbed body, so a bucket
    // missing them fails the client's own parse rather than the assertion.
    inputReportedResponseCount: 0,
    outputReportedResponseCount: 0,
    complete: true,
  };
  const measured = {
    ...zeroCost,
    responseCount: 2,
    pricedResponseCount: 2,
    totalCostEstimate: 1.5,
    inputTokens: 800,
    outputTokens: 200,
    inputReportedResponseCount: 2,
    outputReportedResponseCount: 2,
  };
  return {
    generatedAt: 1_786_000_000_000,
    since: '1h',
    windowStart: 1_785_996_400_000,
    runs: { pending: 0, queued: 0, running: 1, waiting: 0 },
    models: [
      {
        provider: 'anthropic_api',
        model: 'claude-opus-4-8',
        lastAt: 1_786_000_000_000,
        cost: measured,
      },
    ],
    agentCli: { invocations: 0, completed: 0, notCompleted: 0, lastAt: null },
    /* #988 — REQUIRED on the snapshot, so a stub without it is rejected by the
       client's schema and the page renders an error instead of a chart. Present
       and empty here on purpose: the chart is about the METERED series, and
       reported external activity plots no bar (it is billed to no connection). */
    external: {
      invocations: 0,
      completed: 0,
      notCompleted: 0,
      unknown: 0,
      inFlight: 0,
      lastAt: null,
      tokens: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        measuredInvocations: 0,
      },
      truncated: false,
      reporters: [],
    },
    totals: measured,
    series: {
      bucketMs: 300_000,
      buckets: [
        // measured, and the tallest — sets the scale
        {
          bucketStart: 1_785_996_300_000,
          bucketEnd: 1_785_996_600_000,
          partial: false,
          cost: measured,
        },
        // genuinely empty: no exchanges at all, a MEASURED zero
        {
          bucketStart: 1_785_996_600_000,
          bucketEnd: 1_785_996_900_000,
          partial: false,
          cost: zeroCost,
        },
        // exchanges happened, NOBODY counted the tokens
        {
          bucketStart: 1_785_996_900_000,
          bucketEnd: 1_785_997_200_000,
          partial: false,
          cost: { ...zeroCost, responseCount: 3, unpricedResponseCount: 3 },
        },
        /*
         * ONE side counted, the other not — a stack, but a half-honest one.
         *
         * Its counted side is deliberately the FULL 1000 that sets the scale, so
         * this bucket's stack asks for the whole plot height PLUS the sliver and
         * the row gap. That is the only arrangement under which the sliver is
         * squeezed at all, and therefore the only one under which the chart
         * spec's geometry assertions can fail. At 400 they passed no matter what
         * the CSS said — checked by mutation, which is how this number got here.
         */
        {
          bucketStart: 1_785_997_200_000,
          bucketEnd: 1_785_997_500_000,
          partial: false,
          cost: { ...measured, inputTokens: 1000, outputTokens: 0, outputReportedResponseCount: 0 },
        },
        // still in progress
        {
          bucketStart: 1_785_997_500_000,
          bucketEnd: 1_785_997_600_000,
          partial: true,
          cost: { ...measured, inputTokens: 100, outputTokens: 50 },
        },
      ],
    },
  };
}

export async function stubActivity(
  page: Page,
  snapshot: unknown = seriesSnapshot(),
): Promise<void> {
  await page.route('**/api/monitor/ai-activity*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    }),
  );
}
