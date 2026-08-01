import { expect, test, type Page } from '@playwright/test';
import { expectQuiet } from './support/console-guard';
import { openSeededCanvas, seedVersion } from './support/seedDoc';

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
    const body = (await res.json()) as { data: { version: number; containers: unknown[] }[] };
    const latest = body.data.reduce((a, b) => (a.version >= b.version ? a : b));
    return latest.containers;
  }, pipelineId);
}

test.describe('U23 — container config editing', () => {
  test('an exitWhen typo is fixed in place, and reaches the saved version', async ({ page }) => {
    const problems = expectQuiet(page);
    const pipelineId = await openSeededCanvas(page, 'u23 exitwhen', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [
        { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 2)}' },
      ],
    });

    await configure(page, 'loop 1');
    const field = page.getByLabel('exitWhen', { exact: false });
    await expect(field).toHaveValue('${equals(1, 2)}');
    await field.fill('${equals(1, 1)}');
    await page.getByRole('button', { name: 'Apply container settings' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    expect(await savedContainers(page, pipelineId)).toEqual([
      { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' },
    ]);
    expect(problems.messages()).toEqual([]);
  });

  /**
   * The fields U6d could never author at all. `timeout` and `join` have no
   * create-time control, so before this ticket the only way a container carried
   * either was the API.
   */
  test('authors a field the create form never offered', async ({ page }) => {
    const problems = expectQuiet(page);
    const pipelineId = await openSeededCanvas(page, 'u23 new fields', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [
        { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' },
      ],
    });

    await configure(page, 'loop 1');
    await page.getByLabel('timeout', { exact: false }).fill('45');
    await page.getByLabel('join', { exact: false }).selectOption('any');
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
    expect(problems.messages()).toEqual([]);
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
    const problems = expectQuiet(page);
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
    await expect(page.getByLabel('maxRounds', { exact: false })).toHaveValue('7');
    await page.getByLabel('maxRounds', { exact: false }).fill('');
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
    expect(problems.messages()).toEqual([]);
  });

  /**
   * The pre-check is a UX courtesy, but it must KEEP what was typed. Reverting
   * to the stored value on a refusal loses the edit and says nothing.
   */
  test('a refused value keeps the typed text and says why', async ({ page }) => {
    const problems = expectQuiet(page);
    await openSeededCanvas(page, 'u23 refuse', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [
        { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' },
      ],
    });

    await configure(page, 'loop 1');
    await page.getByLabel('timeout', { exact: false }).fill('1.5');
    await page.getByRole('button', { name: 'Apply container settings' }).click();

    await expect(page.getByRole('alert')).toContainText('timeout');
    await expect(page.getByLabel('timeout', { exact: false })).toHaveValue('1.5');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();
    expect(problems.messages()).toEqual([]);
  });

  /**
   * The consequence gate, on a CONFIG edit rather than a membership one. An
   * `exitWhen` naming a node outside the container is refused by `validateDoc`,
   * and the operator is told before the edit lands — not after, by a badge.
   */
  test('warns before an exitWhen edit that makes the doc unsavable', async ({ page }) => {
    const problems = expectQuiet(page);
    await openSeededCanvas(page, 'u23 consequence', {
      nodes: [
        { id: 'n_a', position: AT },
        { id: 'n_b', position: AT2 },
      ],
      containers: [
        { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' },
      ],
    });

    await configure(page, 'loop 1');
    await page.getByLabel('exitWhen', { exact: false }).fill('${nodes.n_b.status == "success"}');
    const message = await captureConfirm(page, async () => {
      await page.getByRole('button', { name: 'Apply container settings' }).click();
    });

    expect(message).not.toBeNull();
    expect(message).toContain('unsavable');
    // The recovery sentence names the PREVIOUS value, not a generic instruction.
    expect(message).toContain('${equals(1, 1)}');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();
    expect(problems.messages()).toEqual([]);
  });

  /** An edit that costs the doc nothing must not interrupt the operator. */
  test('does not confirm a harmless edit', async ({ page }) => {
    const problems = expectQuiet(page);
    await openSeededCanvas(page, 'u23 harmless', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [
        { id: 'loop_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' },
      ],
    });

    await configure(page, 'loop 1');
    const message = await captureConfirm(page, async () => {
      await page.getByLabel('timeout', { exact: false }).fill('30');
      await page.getByRole('button', { name: 'Apply container settings' }).click();
    });

    expect(message).toBeNull();
    expect(problems.messages()).toEqual([]);
  });

  /**
   * The selection half, which only exists because a container is NOT in React
   * Flow's selection: RF can never emit the deselect that closes every other
   * panel, so `onPaneClick` is the only way out.
   */
  test('the panel opens on the right box and closes on a pane click', async ({ page }) => {
    const problems = expectQuiet(page);
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
    await expect(page.getByLabel('exitWhen', { exact: false })).toHaveValue('${equals(2, 2)}');
    await expect(page.locator('.react-flow__node[data-id="loop_2"] .flow-container')).toHaveClass(
      /flow-container--selected/,
    );
    await expect(page.locator('.react-flow__node[data-id="loop_1"] .flow-container')).not.toHaveClass(
      /flow-container--selected/,
    );

    // Switching subjects must carry no draft across — the panel is keyed per
    // container for exactly this.
    await page.getByLabel('exitWhen', { exact: false }).fill('${equals(9, 9)}');
    await configure(page, 'loop 1');
    await expect(page.getByLabel('exitWhen', { exact: false })).toHaveValue('${equals(1, 1)}');

    await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: 'loop 1' })).toHaveCount(0);
    await expect(page.locator('.react-flow__node[data-id="loop_1"] .flow-container')).not.toHaveClass(
      /flow-container--selected/,
    );
    expect(problems.messages()).toEqual([]);
  });

  /**
   * The repair path for a doc the canvas could not have authored.
   *
   * A `stage` carrying a `timeout` is refused by `validateDoc` — reachable
   * through the API, which is how this one is seeded. Before U23 that was a
   * dead end: the badge names a field, `kind` is not editable, and the panel
   * showed nothing to fix. The field is rendered as an advisory so clearing it
   * removes the key.
   */
  test('offers a repair for a field that is illegal on this kind', async ({ page }) => {
    const problems = expectQuiet(page);
    const { pipelineId } = await seedVersion(page, 'u23 illegal', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['n_a'], timeout: 30 }],
    });
    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await page.locator('.react-flow__renderer').waitFor();

    await expect(page.locator('.badge-list li')).toContainText('timeout is only meaningful');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await configure(page, 'stage 1');
    await expect(page.locator('.contract-advisory')).toContainText('timeout');
    await page.getByLabel('timeout', { exact: false }).fill('');
    await page.getByRole('button', { name: 'Apply container settings' }).click();

    await expect(page.locator('.badge-list li')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();
    expect(problems.messages()).toEqual([]);
  });

  /**
   * #857's fix, asserted where it is reachable: the `join` picker's accessible
   * name must be the FIELD, not the field followed by every option. Before the
   * fix `getByLabel(/^join/)` matched a control named "join (optional) all any".
   */
  test('the join picker is named by its field, not by its options', async ({ page }) => {
    const problems = expectQuiet(page);
    await openSeededCanvas(page, 'u23 a11y', {
      nodes: [{ id: 'n_a', position: AT }],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['n_a'] }],
    });

    await configure(page, 'stage 1');
    const join = page.getByLabel('join (optional)', { exact: true });
    await expect(join).toBeVisible();
    await expect(join).toHaveRole('combobox');
    expect(problems.messages()).toEqual([]);
  });
});
