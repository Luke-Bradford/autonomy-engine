import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1065 — the run monitor shows the reducer's EXPLANATIONS, not just its decisions.
 *
 * #497 built the whole diagnostics channel — the `run_diagnostics` table, the
 * fold-site writer, the truncation marker, `GET /api/runs/:id/diagnostics` — and
 * nothing in the web app ever called it. This spec is the proof that the wire is
 * now joined end to end: the pure reducer emits a diagnostic, the server records
 * it, the route serves it, and the page renders it.
 *
 * EGRESS-FREE, and it needs no connection at all. `fail` is an engine-evaluated
 * control activity, so the run terminalizes with no subprocess and no network.
 *
 * WHY A CONTAINER. A bare failing node emits NO diagnostic — a failure is an
 * ordinary decision and the event log already states it. The diagnostic exists
 * for the derived consequence: `stepContainers` finds every child terminal, and
 * `containerOutcomeFailure` has to say WHICH child it blamed the container's
 * failure on, because that attribution appears nowhere in the log. Hence one
 * `fail` node inside a `stage`, which is the smallest doc that produces exactly
 * one explanation and no noise.
 *
 * The doc is fully valid: it is minted through the REAL write gate (`seedDoc`),
 * so `validateDoc` (#444) has passed it. That matters, because the OTHER family
 * of diagnostics — `docDefects` — is refused at save time and is reachable only
 * by rows written before that gate existed. This one is on the live path.
 */
test('#1065 — the run monitor explains why a container failed, and says which child it blamed', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  /* Hoisted rather than inlined: an inline literal in the `seedVersion(...)`
     call trips excess-property checking against `SeedDoc`. */
  const doc: SeedDoc = {
    nodes: [
      {
        id: 'stop',
        type: 'fail',
        config: { message: 'planned failure' },
        position: { x: 0, y: 0 },
      },
    ],
    containers: [{ id: 'stg', kind: 'stage', children: ['stop'] }],
  };
  const { pipelineVersionId } = await seedVersion(page, '#1065 explained failure', doc);
  const runId = await fireAndSettle(page, pipelineVersionId, '#1065 diagnostics');

  /* THE PREMISE, asserted before the UI: the reducer really did emit an
     explanation and it really did reach the durable table. Without this the
     assertions below could pass against a section rendering its empty case, which
     would prove nothing about the feature. */
  const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/diagnostics`);
  expect(res.status()).toBe(200);
  const rows = (await res.json()) as { seq: number; phase: string; message: string }[];
  expect(rows.map((r) => r.message)).toEqual(["container 'stg' failed: child 'stop' failed"]);
  /* No cap marker on a run with one diagnostic — the warning path is a unit-test
     concern (seeding 500 of these over HTTP would be absurd), so this spec must
     at least prove the marker is ABSENT when it should be, or the "not rendered
     as a row" assertion below could pass vacuously. */
  expect(rows.some((r) => r.phase === 'cap')).toBe(false);
  const seq = rows[0]!.seq;

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* Addressed by its landmark rather than by position. */
  const section = page.getByRole('region', { name: 'Why this run behaved as it did' });
  await expect(
    section.getByRole('heading', { name: 'Why this run behaved as it did', level: 3 }),
  ).toBeVisible();

  // The explanation itself, verbatim — the whole point of the section.
  await expect(section.getByText("container 'stg' failed: child 'stop' failed")).toBeVisible();

  /* The seq is the cross-reference into the Events table below, so it has to be
     the SAME number the reducer derived the diagnostic at — not a row index. */
  await expect(section.getByRole('cell', { name: String(seq), exact: true })).toBeVisible();

  /* A run WITH an explanation must not also claim it has none. */
  await expect(section.getByText(/neutralized nothing on this run/i)).toHaveCount(0);
  // A settled run carries no snapshot caveat.
  await expect(section.getByText(/has not finished, so this is a snapshot/i)).toHaveCount(0);
  // And no cap warning, matching the premise asserted above.
  await expect(section.getByText(/Some explanations were dropped/)).toHaveCount(0);

  /* The section is a READER, so a refresh must leave the same answer standing —
     this is the manual re-read path, and a broken one would blank the list. */
  await section.getByRole('button', { name: 'Refresh diagnostics' }).click();
  await expect(section.getByText("container 'stg' failed: child 'stop' failed")).toBeVisible();

  await expectQuiet(page, problems);
});

/**
 * The other half of the contract, and the one a healthy run walks: the section is
 * rendered UNCONDITIONALLY and states that there was nothing to explain.
 *
 * A section that appeared only when diagnostics existed would be indistinguishable
 * from an app with no diagnostics surface — the operator could never learn that
 * "no explanation" is itself an answer, rather than a feature they had not found.
 */
test('#1065 — a run the reducer had nothing to explain says so, rather than hiding the section', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const doc: SeedDoc = {
    nodes: [
      {
        id: 'stop',
        type: 'fail',
        config: { message: 'planned failure' },
        position: { x: 0, y: 0 },
      },
    ],
  };
  const { pipelineVersionId } = await seedVersion(page, '#1065 unexplained failure', doc);
  const runId = await fireAndSettle(page, pipelineVersionId, '#1065 quiet');

  /* PREMISE: the same failing node OUTSIDE a container emits no diagnostic at
     all. This is what makes the pair meaningful — the two runs differ only by
     the container, so the section's two states are shown to track the reducer
     rather than the page's mood. */
  const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/diagnostics`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual([]);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  const section = page.getByRole('region', { name: 'Why this run behaved as it did' });
  await expect(section.getByText(/neutralized nothing on this run/i)).toBeVisible();
  await expect(section.getByRole('table')).toHaveCount(0);

  await expectQuiet(page, problems);
});
