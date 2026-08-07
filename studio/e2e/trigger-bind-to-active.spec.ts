import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { mintVersion, seedVersion } from './support/seedDoc';

/**
 * #981 — binding a trigger to "the active published version", from the UI.
 *
 * The ticket reported this option as already offered without its precondition
 * stated. It was not offered at all: `bindToActive` (#3 G6c-2) had shipped
 * server-side and had ZERO web callers, so the server's publish refusal was
 * unreachable from the form. This covers the affordance and its guidance.
 *
 * The git-mode half — where a workspace with nothing published must be told to
 * publish first — lives in `workspace-git.spec.ts`, which owns the real bare
 * repo and runs serially. Connecting a repo flips the WHOLE workspace into git
 * mode, and one SQLite DB is shared by every spec file, so a second file doing
 * it would race this one.
 *
 * What only a real round trip can prove: that the body this form builds is
 * ACCEPTED. The create body's XOR keys on key PRESENCE, so a `pipelineVersionId`
 * serialized as `null` beside `bindToActive` is a 400 that no client-side test
 * of the same shared schema can see — both sides would agree on the object the
 * client built rather than on the JSON the server receives.
 */

function triggerForm(page: Page) {
  return page.getByRole('form', { name: 'Trigger form' });
}

const DOC = { nodes: [{ id: 'n1', position: { x: 0, y: 0 } }] };

test('binds a new trigger to the active version, resolved once by the server', async ({ page }) => {
  // Two versions, so "bound to the LATEST" is a distinguishable claim rather
  // than the only possible outcome.
  const { pipelineId, pipelineVersionId: first } = await seedVersion(page, 'Bind target', DOC);
  const latest = await mintVersion(page, pipelineId, DOC, first);
  expect(latest).not.toBe(first);

  const problems = collectPageProblems(page);
  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await page.getByRole('button', { name: /New trigger/i }).click();

  const form = triggerForm(page);
  await form.getByLabel('Name').fill('Follows the active version');

  /*
   * The binding fieldset is the fourth grouped sub-form in this form, and
   * `index.css` states in a comment that a new one "has to add itself to these
   * selector lists" — a bare <fieldset> otherwise inherits the browser default
   * border and reads nothing like the recurrence and window editors beside it.
   * Asserted as a COMPUTED value against the established editor, because that
   * is the claim; a screenshot could not tell the two borders apart.
   */
  const borders = await page.evaluate(() => {
    const read = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { style: s.borderTopStyle, width: s.borderTopWidth, radius: s.borderRadius };
    };
    return { binding: read('.trigger-form .binding-kind') };
  });
  expect(borders.binding, 'the binding fieldset is not on the page').not.toBeNull();
  expect(borders.binding!.style).toBe('solid');
  expect(borders.binding!.radius).toBe('6px');

  await form.getByRole('radio', { name: /active published version/i }).check();
  await form.getByLabel(/^Pipeline/).selectOption(pipelineId);

  // DB-only is the shipped default: no repo, so there is no `active` pointer and
  // the server resolves the LATEST immutable version instead. The form says so
  // rather than implying a publish step that does not exist here.
  await expect(form.getByText(/latest saved version/i)).toBeVisible();
  await expect(form.getByText(/does not follow later changes/i)).toBeVisible();

  await form.getByRole('button', { name: /Create trigger/i }).click();
  await expect(form).toBeHidden();

  const res = await page.request.get('/api/triggers');
  expect(res.status()).toBe(200);
  const list = (await res.json()) as Array<{ name: string; pipelineVersionId: string | null }>;
  const created = list.find((t) => t.name === 'Follows the active version');
  expect(created, 'the trigger was not created').toBeDefined();
  // Resolve-once: the row stores a CONCRETE id, never an "active" indirection.
  expect(created!.pipelineVersionId).toBe(latest);

  await expectQuiet(page, problems);
});

test('an enabled trigger may bind to the active version', async ({ page }) => {
  // The client mirror of `assertBindableIfEnabled` has no concrete id to look at
  // on this path; the server resolves one BEFORE running that assertion, so the
  // combination is legal and the form must not refuse it.
  const { pipelineId, pipelineVersionId } = await seedVersion(page, 'Enabled bind target', DOC);

  const problems = collectPageProblems(page);
  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await page.getByRole('button', { name: /New trigger/i }).click();

  const form = triggerForm(page);
  await form.getByLabel('Name').fill('Enabled and active-bound');
  await form.getByRole('radio', { name: /active published version/i }).check();
  await form.getByLabel(/^Pipeline/).selectOption(pipelineId);
  await form.getByLabel(/^Enabled/).check();
  await form.getByRole('button', { name: /Create trigger/i }).click();
  await expect(form).toBeHidden();

  const res = await page.request.get('/api/triggers');
  const list = (await res.json()) as Array<{
    name: string;
    enabled: boolean;
    pipelineVersionId: string | null;
  }>;
  const created = list.find((t) => t.name === 'Enabled and active-bound');
  expect(created?.enabled).toBe(true);
  expect(created?.pipelineVersionId).toBe(pipelineVersionId);

  await expectQuiet(page, problems);
});

test('editing an existing trigger offers no bind-to-active', async ({ page }) => {
  // PATCH is concrete-only by design, so a patch can never silently re-resolve a
  // pinned binding. The control must therefore not exist on the edit form.
  const { pipelineVersionId } = await seedVersion(page, 'Edit target', DOC);
  const created = await page.request.post('/api/triggers', {
    data: {
      name: 'Already bound',
      pipelineVersionId,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      runWindows: null,
      concurrency: { policy: 'skip_if_running' },
      enabled: false,
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const problems = collectPageProblems(page);
  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await page
    .getByRole('row', { name: /Already bound/ })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();

  const form = triggerForm(page);
  await expect(form.getByLabel(/^Pipeline version/)).toBeVisible();
  await expect(form.getByRole('radio', { name: /active published version/i })).toHaveCount(0);

  await expectQuiet(page, problems);
});
