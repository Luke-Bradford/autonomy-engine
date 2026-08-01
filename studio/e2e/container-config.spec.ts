import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas } from './support/seedDoc';

/**
 * U23 (#839) — editing an EXISTING container's config.
 *
 * U6d could CREATE a container and move activities in and out of it, but its
 * config was write-once: only the fields a valid doc requires were captured at
 * create time, and `timeout`/`join`/`batchCount` were never authorable at all.
 * The only escape from a typo'd `exitWhen` was `deleteContainer`, which also
 * takes the container's incident edges with it.
 *
 * These are the properties no unit test can reach. The panel is opened by a
 * button drawn INSIDE a derived box that jsdom cannot lay out (a container's
 * rect comes from measured child sizes, which jsdom reports as 0×0), the
 * pane-click that closes it is a real pointer event against React Flow's own
 * gesture filter, and the round-trip through Save proves the edit reached an
 * immutable version rather than only the store.
 */

const AT = { x: 40, y: 40 };
const AT2 = { x: 40, y: 200 };

/** Open the config panel for one container, by the ⚙ on its box. */
async function configure(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: `Configure ${label}` }).click();
  await expect(page.getByRole('heading', { name: label })).toBeVisible();
}

/**
 * Run `act`, capturing the text of the confirm it may raise.
 *
 * `null` means nothing was raised, which is assertable in its own right: an
 * edit that costs the doc nothing must not interrupt the operator.
 */
async function captureConfirm(page: Page, act: () => Promise<void>): Promise<string | null> {
  let seen: string | null = null;
  const handler = async (dialog: { message: () => string; accept: () => Promise<void> }) => {
    seen = dialog.message();
    await dialog.accept();
  };
  page.on('dialog', handler);
  try {
    await act();
  } finally {
    page.off('dialog', handler);
  }
  return seen;
}

/** The container docs the server holds for `pipelineId`, latest version first. */
async function savedContainers(page: Page, pipelineId: string): Promise<unknown[]> {
  return page.evaluate(async (id: string) => {
    const res = await fetch(`/api/pipelines/${id}/versions`, { credentials: 'same-origin' });
    const versions = (await res.json()) as { version: number; containers: unknown[] }[];
    const latest = versions.reduce((a, b) => (a.version >= b.version ? a : b));
    return latest.containers;
  }, pipelineId);
}

test.describe('U23 — container config editing', () => {
  test('an exitWhen typo is fixed in place, and reaches the saved version', async ({ page }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'u23 fix in place', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [{ id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 2)}' }],
    });

    await configure(page, 'loop 1');
    const field = page.getByLabel(/^exitWhen/);
    await expect(field).toHaveValue('${equals(1, 2)}');
    await field.fill('${equals(1, 1)}');
    await page.getByRole('button', { name: 'Apply container settings' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    expect(await savedContainers(page, pipelineId)).toEqual([
      { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' },
    ]);
    await expectQuiet(page, problems);
  });

  /**
   * The fields U6d could never author at all. `timeout` and `join` have no
   * create-time control, so before this ticket the only way a container carried
   * either was the API.
   */
  test('authors a field the create form never offered', async ({ page }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'u23 new fields', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [{ id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' }],
    });

    await configure(page, 'loop 1');
    await page.getByLabel(/^timeout/).fill('45');
    await page.getByLabel(/^join/).selectOption('any');
    await page.getByRole('button', { name: 'Apply container settings' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    expect(await savedContainers(page, pipelineId)).toEqual([
      {
        id: 'loop_1',
        kind: 'loop',
        children: ['n_a'],
        exitWhen: '${equals(1, 1)}',
        timeout: 45,
        join: 'any',
      },
    ]);
    await expectQuiet(page, problems);
  });

  /**
   * A blank control is an ABSENT field, never a zero.
   *
   * `Number('')` is 0, and a `maxRounds: 0` is a different, legal-looking
   * pipeline — a round cap of none. Clearing the box must DELETE the key, which
   * is only observable in the saved doc: a stored `0` and an absent key render
   * as the same empty control.
   */
  test('clearing a numeric field removes the key rather than storing 0', async ({ page }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'u23 clear', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [
        {
          id: 'loop_1',
          kind: 'loop',
          children: ['n_a'],
          exitWhen: '${equals(1, 1)}',
          maxRounds: 7,
        },
      ],
    });

    await configure(page, 'loop 1');
    await expect(page.getByLabel(/^maxRounds/)).toHaveValue('7');
    await page.getByLabel(/^maxRounds/).fill('');
    await page.getByRole('button', { name: 'Apply container settings' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const [saved] = await savedContainers(page, pipelineId);
    expect(saved).toEqual({
      id: 'loop_1',
      kind: 'loop',
      children: ['n_a'],
      exitWhen: '${equals(1, 1)}',
    });
    expect(Object.keys(saved as object)).not.toContain('maxRounds');
    await expectQuiet(page, problems);
  });

  /**
   * The pre-check is a UX courtesy, but it must KEEP what was typed. Reverting
   * to the stored value on a refusal loses the edit and says nothing.
   */
  test('a refused value keeps the typed text and says why', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u23 refuse', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [{ id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' }],
    });

    await configure(page, 'loop 1');
    await page.getByLabel(/^timeout/).fill('1.5');
    await page.getByRole('button', { name: 'Apply container settings' }).click();

    await expect(page.getByRole('alert')).toContainText('timeout');
    await expect(page.getByLabel(/^timeout/)).toHaveValue('1.5');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();
    await expectQuiet(page, problems);
  });

  /**
   * The consequence gate, on a CONFIG edit rather than a membership one. An
   * `exitWhen` naming a node outside the container is refused by `validateDoc`,
   * and the operator is told before the edit lands — not after, by a badge.
   */
  test('warns before an exitWhen edit that makes the doc unsavable', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u23 consequence', {
      nodes: [
        { id: 'n_a', position: AT },
        { id: 'n_b', position: AT2 },
      ],
      containers: [{ id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' }],
    });

    await configure(page, 'loop 1');
    await page.getByLabel(/^exitWhen/).fill('${nodes.n_b.status == "success"}');
    const message = await captureConfirm(page, async () => {
      await page.getByRole('button', { name: 'Apply container settings' }).click();
    });

    expect(message).not.toBeNull();
    expect(message).toContain('unsavable');
    // The recovery sentence names the PREVIOUS value, not a generic instruction.
    expect(message).toContain('${equals(1, 1)}');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();
    await expectQuiet(page, problems);
  });

  /** An edit that costs the doc nothing must not interrupt the operator. */
  test('does not confirm a harmless edit', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u23 harmless', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [{ id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' }],
    });

    await configure(page, 'loop 1');
    const message = await captureConfirm(page, async () => {
      await page.getByLabel(/^timeout/).fill('30');
      await page.getByRole('button', { name: 'Apply container settings' }).click();
    });

    expect(message).toBeNull();
    await expectQuiet(page, problems);
  });

  /**
   * The selection half, which only exists because a container is NOT in React
   * Flow's selection: RF can never emit the deselect that closes every other
   * panel, so `onPaneClick` is the only way out.
   */
  test('the panel opens on the right box and closes on a pane click', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u23 selection', {
      nodes: [
        { id: 'n_a', position: AT },
        { id: 'n_b', position: AT2 },
      ],
      containers: [
        { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' },
        { id: 'loop_2', kind: 'loop', children: ['n_b'], exitWhen: '${equals(2, 2)}' },
      ],
    });

    // Two loops, so the ordinal is what tells the two ⚙ buttons apart at all.
    await configure(page, 'loop 2');
    await expect(page.getByLabel(/^exitWhen/)).toHaveValue('${equals(2, 2)}');
    await expect(page.locator('.react-flow__node[data-id="loop_2"] .flow-container')).toHaveClass(
      /flow-container--selected/,
    );
    await expect(
      page.locator('.react-flow__node[data-id="loop_1"] .flow-container'),
    ).not.toHaveClass(/flow-container--selected/);

    // Switching subjects must carry no draft across — the panel is keyed per
    // container for exactly this.
    await page.getByLabel(/^exitWhen/).fill('${equals(9, 9)}');
    await configure(page, 'loop 1');
    await expect(page.getByLabel(/^exitWhen/)).toHaveValue('${equals(1, 1)}');

    await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: 'loop 1' })).toHaveCount(0);
    await expect(
      page.locator('.react-flow__node[data-id="loop_1"] .flow-container'),
    ).not.toHaveClass(/flow-container--selected/);
    await expectQuiet(page, problems);
  });

  /**
   * The repair path for a field that is DEAD on this container's kind.
   *
   * The seeded doc is `stage` + `maxRounds`, and the choice is forced: every
   * other illegal combination is refused by the server's own write gate, so it
   * cannot be minted at all. `maxRounds` on a `stage` is the ONE that gets
   * through, because `validateDoc` refuses it on a `foreach` and forgets to on a
   * `stage` — the hole this work found and filed as #859. `CONTAINER_CONFIG_FIELDS`
   * declares it unpinnable for exactly that reason, and this spec is where the
   * consequence of the hole is visible to an operator.
   *
   * Before U23 there was nothing to do about it: `kind` is not editable, and no
   * panel showed the field. Rendering it makes the existing "blank an optional
   * control to drop the key" rule the repair, with no new mechanism.
   */
  test('offers a repair for a field that is dead on this kind', async ({ page }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'u23 dead field', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['n_a'], maxRounds: 3 }],
    });

    await configure(page, 'stage 1');
    await expect(page.locator('.contract-advisory')).toContainText('maxRounds');
    await expect(page.getByLabel(/^maxRounds/)).toHaveValue('3');
    await page.getByLabel(/^maxRounds/).fill('');
    await page.getByRole('button', { name: 'Apply container settings' }).click();

    // Gone from the panel too: the field was only rendered because the doc
    // carried it, so the repair removes the control along with the key.
    await expect(page.locator('.contract-advisory')).toHaveCount(0);
    await expect(page.getByLabel(/^maxRounds/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect(await savedContainers(page, pipelineId)).toEqual([
      { id: 'stage_1', kind: 'stage', children: ['n_a'] },
    ]);
    await expectQuiet(page, problems);
  });
});
