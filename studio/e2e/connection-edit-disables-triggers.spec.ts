import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedConnection } from './support/seedResources';
import { seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1211 — the Connections page says which enabled TRIGGERS an edit would switch
 * off, before the edit happens.
 *
 * What only a real browser + a real server can prove, and no unit test reaches:
 * the whole chain is real. The unit suite mocks `listConnectionDependents`, so
 * it proves the page renders whatever that route returns; it cannot prove that
 * the route finds the trigger at all. The dependency edge lives INSIDE a bound
 * pipeline version's node JSON — the reverse walk is the entire reason this
 * needed a server route (`ConnectionDependentsResponseSchema`) — so "a trigger
 * bound to a version that references this connection is found, named in the
 * form, and then actually disabled by the save" is a claim about the server's
 * walk, the wire schema and the page agreeing. That is what this spec asserts.
 *
 * Every spec names its own rows with a per-test suffix: the suite runs
 * single-worker against one shared SQLite file and rows from earlier specs
 * persist.
 */

function form(page: Page) {
  return page.getByRole('form', { name: 'Connection form' });
}

test('names the enabled trigger a kind change would switch off, and then switches exactly it off', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const suffix = Date.now();

  // A credential-less `ollama` connection is READY (`not_required`). Changing
  // it to a secret-requiring kind with no secret is the ONE PATCH transition
  // the server's reverse gate (#3 G8b-2) fires on.
  const connectionName = `e2e 1211 conn ${suffix}`;
  const connectionId = await seedConnection(page, {
    name: connectionName,
    kind: 'ollama',
    config: {},
  });

  // A version whose node literally references that connection, and an ENABLED
  // trigger bound to it. This is the edge no client-held row carries.
  const triggerName = `e2e 1211 nightly ${suffix}`;
  const { pipelineVersionId } = await seedVersion(page, `e2e 1211 pipeline ${suffix}`, {
    nodes: [
      {
        id: 'n1',
        type: 'llm_call',
        position: { x: 0, y: 0 },
        connectionId,
        config: { prompt: 'hi' },
      },
    ],
  });
  const created = await page.request.post('/api/triggers', {
    data: {
      name: triggerName,
      pipelineVersionId,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      runWindows: null,
      concurrency: { policy: 'skip_if_running' },
      enabled: true,
    },
  });
  expect(created.status(), `seeding the trigger: ${await created.text()}`).toBe(201);
  const triggerId = ((await created.json()) as { id: string }).id;

  await page.goto('/#/manage/connections');
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  await fluentRootReady(page);

  await page.getByRole('button', { name: `Edit ${connectionName}`, exact: true }).click();
  await expect(form(page)).toBeVisible();

  // Nothing is said until the change would actually cross the readiness
  // boundary — the note is about a write the server performs, not about a
  // select being touched.
  await expect(form(page).getByText(/switches off/)).toHaveCount(0);

  await form(page).getByLabel('Kind').selectOption('anthropic_api');

  const note = form(page).getByText(/switches off 1 enabled trigger/);
  await expect(note).toBeVisible();
  await expect(note).toContainText(triggerName);
  // The disable is not undone by supplying the secret later, which is why the
  // sentence names the trigger rather than counting it.
  await expect(note).toContainText(/re-enable/i);

  // ADVISORY, never a gate: the server accepts this write, so the form must not
  // refuse it. A change that disabled Save would have to delete this line.
  await expect(form(page).getByRole('button', { name: 'Save changes' })).toBeEnabled();

  // Supplying the secret in the SAME edit keeps the connection ready, so
  // nothing would be disabled and the note must withdraw.
  await form(page).getByLabel('Secret').fill('sk-e2e');
  await expect(form(page).getByText(/switches off/)).toHaveCount(0);
  await form(page).getByLabel('Secret').fill('');
  await expect(form(page).getByText(/switches off 1 enabled trigger/)).toBeVisible();

  // Now save, and read the trigger back from the SERVER: the note was TRUE.
  await form(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(form(page)).toBeHidden();

  await expect
    .poll(async () => {
      const res = await page.request.get('/api/triggers');
      const list = (await res.json()) as Array<{ id: string; enabled: boolean }>;
      return list.find((t) => t.id === triggerId)?.enabled;
    })
    .toBe(false);

  await expectQuiet(page, problems);
});

/**
 * #1252 — the kind change that disables NOTHING. `ollama` → `fs` keeps the
 * connection ready (both credential-less), so the reverse gate never fires and
 * the trigger note above is rightly silent; the `llm_call` node bound to it
 * would fail every run with `CONNECTION_KIND_INVALID` while its trigger stays
 * enabled. What only the real chain proves: the server's candidate-version walk
 * finds a node no trigger is even bound to, and the form tests the selected
 * kind against the accepted kinds the wire carried.
 */
test('names the pipeline node a still-ready kind change breaks, where no trigger would be switched off', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const suffix = Date.now();
  const connectionName = `e2e 1252 conn ${suffix}`;
  const connectionId = await seedConnection(page, {
    name: connectionName,
    kind: 'ollama',
    config: {},
  });
  const pipelineName = `e2e 1252 pipeline ${suffix}`;
  await seedVersion(page, pipelineName, {
    nodes: [
      {
        id: 'summarise',
        type: 'llm_call',
        position: { x: 0, y: 0 },
        connectionId,
        config: { prompt: 'hi' },
      },
    ],
  });

  await page.goto('/#/manage/connections');
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  await fluentRootReady(page);
  await page.getByRole('button', { name: `Edit ${connectionName}`, exact: true }).click();
  await expect(form(page)).toBeVisible();

  // A kind the node still accepts breaks nothing, and says nothing.
  await form(page).getByLabel('Kind').selectOption('openai_api');
  await expect(form(page).getByText(/Saving this breaks/)).toHaveCount(0);

  await form(page).getByLabel('Kind').selectOption('fs');
  const note = form(page).getByText(/Saving this breaks 1 pipeline node/);
  await expect(note).toBeVisible();
  await expect(note).toContainText(`${pipelineName} › summarise`);
  await expect(note).toContainText(/stay enabled/);
  await expect(form(page).getByText(/switches off/)).toHaveCount(0);

  await expectQuiet(page, problems);
});
