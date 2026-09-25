import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas, seedVersion } from './support/seedDoc';

/**
 * #425 — authoring a `call_pipeline` node on the canvas.
 *
 * The last of #425's four gaps. `execute_pipeline` was catalogued but
 * deliberately unreachable from the canvas: the palette hid it, the drop path
 * refused it, `addNode` refused it, and the inspector showed a read-only stub —
 * because its settings live in `Node.call`, which the generic `node.config`
 * form cannot author. So "this pipeline runs that pipeline", the engine's only
 * composition primitive, could be built through the API and nowhere else.
 *
 * What no unit test can reach, and this spec is here for:
 *
 *  - the panel's target list is fetched from the LIVE server, so the pipeline
 *    and version an operator picks are real rows rather than a stub's fixture;
 *  - the child's DECLARED params drive the form, which means the two pipelines
 *    have to actually exist together in one workspace;
 *  - and the round trip through Save proves `node.call` reached an immutable
 *    version — `toVersionBody` carrying it, the write gate accepting it, and
 *    the reload rendering it back into the same picker.
 */

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

/**
 * One argument row's input. By ROLE, not `getByLabel`: since #1012 each row has
 * an "Insert reference into parameter <name>" toggle, and a label lookup
 * matches that aria-label too.
 */
function arg(page: Page, name: string) {
  return panel(page).getByRole('textbox', { name: new RegExp(`^${name}`) });
}

async function validationIssues(page: Page): Promise<string[]> {
  const list = page.locator('.badge-list li');
  return (await list.count()) === 0 ? [] : list.allTextContents();
}

const CHILD = 'e2e 425 child';

test.describe('#425 — call-node authoring', () => {
  test('a call node is authored on the canvas and SURVIVES a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);

    // The child, minted through the API so it exists as a real version with a
    // real declared contract before the parent's canvas ever opens.
    await seedVersion(page, CHILD, {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [
        { name: 'query', type: 'string', required: true },
        { name: 'limit', type: 'number', required: false },
      ],
    });

    const parentId = await openSeededCanvas(page, 'e2e 425 parent', { nodes: [] });

    // The palette OFFERS it now — this click is the whole retired exclusion.
    await addActivity(page, 'Execute Pipeline');
    await expect(canvasNodes(page)).toHaveCount(1);

    // Added with no `call`, which is a doc the save gate refuses — deliberately,
    // because there is no honest default target. The diagnostic says what to do
    // rather than naming a Zod path, and Save stays dead until it is satisfied.
    expect((await validationIssues(page)).join('\n')).toContain('needs a call config');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await canvasNodes(page).first().click();
    await expect(panel(page).getByRole('heading', { name: 'Call target' })).toBeVisible();

    // The child's params are UNKNOWN until a version is chosen — they are a
    // property of the target, not of the node — and the panel says so rather
    // than offering an empty form or a raw JSON box.
    await expect(arg(page, 'query')).toHaveCount(0);
    await expect(
      panel(page).getByText('Choose a version to see the parameters it declares.'),
    ).toBeVisible();

    await panel(page).getByRole('combobox', { name: 'Pipeline' }).selectOption({ label: CHILD });
    await panel(page).getByRole('combobox', { name: 'Version' }).selectOption({ label: 'v1' });

    // Now they are on screen, straight from the version the picker resolved.
    await expect(arg(page, 'query')).toBeVisible();
    await arg(page, 'query').fill('ships');
    await arg(page, 'limit').fill('25');
    // #796 item 2 — a new call WAITS, because that is what the engine does with
    // an absent `wait`; the box used to read unchecked while the node waited.
    // Unticking it is the one choice that gets written.
    const wait = panel(page).getByLabel('Wait for the child run');
    await expect(wait).toBeChecked();
    await expect(panel(page).getByText('succeeds as soon as the child run starts')).toHaveCount(0);
    await wait.uncheck();
    await expect(panel(page).getByText('succeeds as soon as the child run starts')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Apply call' }).click();

    expect(await validationIssues(page), 'the authored call left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the LATEST version from the server, so
    // what renders here is what was PERSISTED — not what the store still held.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(parentId)}`);
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();

    // Resolved back to the pipeline AND the version, from the stored id alone —
    // the picker is showing what the doc says, not a remembered selection.
    await expect(panel(page).getByRole('combobox', { name: 'Pipeline' })).toHaveValue(/.+/);
    await expect(panel(page).getByRole('combobox', { name: 'Pipeline' })).toContainText(CHILD);
    await expect(arg(page, 'query')).toHaveValue('ships');
    await expect(arg(page, 'limit')).toHaveValue('25');
    await expect(panel(page).getByLabel('Wait for the child run')).not.toBeChecked();

    // The contract that would otherwise be destroyed silently: a call node's
    // outputs come from the CHILD projection, so `config.outputs` must be ABSENT
    // (store every child output), never the catalog's `[]` (store none). Read
    // from the persisted version, because the flip is invisible on screen.
    const persisted = await page.request.get(`/api/pipelines/${parentId}/versions`);
    const versions = (await persisted.json()) as {
      version: number;
      nodes: { type: string; config: Record<string, unknown>; call?: unknown }[];
    }[];
    const saved = versions.find((v) => v.version === 2)!;
    const node = saved.nodes.find((n) => n.type === 'execute_pipeline')!;
    expect(node.config['outputs'], 'a catalog outputs:[] was baked in').toBeUndefined();
    expect(node.call).toMatchObject({ params: { query: 'ships', limit: 25 }, wait: false });

    await expectQuiet(page, problems);
  });

  test('an EXPRESSION target is authorable, and says which guards actually run', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const parentId = await openSeededCanvas(page, 'e2e 425 expression', {
      nodes: [],
      params: [{ name: 'target', type: 'string', required: true }],
    });

    await addActivity(page, 'Execute Pipeline');
    await canvasNodes(page).first().click();
    await panel(page).getByRole('radio', { name: 'Expression' }).check();

    /* The honesty the panel owes the operator, asserted in all three of its
       claims because the failure this guards is the hint drifting out of step
       with the engine in EITHER direction — it has now done so TWICE, first
       claiming no save-time checking at all (fixed by #952) and then claiming
       run time was unbounded for the whole of #796 (fixed by #1011):
         - refs in a `${}` target ARE checked at save (`validateRefs` walks
           `node.call`);
         - the SAVE-time self-call/depth guards still see literal targets only,
           which is permanent — the value is unknowable until dispatch;
         - RUN time bounds the chain (`child.ts` walks `parentRunId` against
           `MAX_CALL_DEPTH`), and reaching that bound is a refusal, not a cap —
           stated as "only at run time" because the nested runs up to the bound
           DO execute, side effects included, before the next one is refused. */
    await expect(panel(page).getByText(/references are checked when you save/)).toBeVisible();
    await expect(panel(page).getByText(/only see literal targets/)).toBeVisible();
    await expect(panel(page).getByText(/nested runs\s+deep/)).toBeVisible();
    await expect(panel(page).getByText(/the next call is refused/)).toBeVisible();
    await expect(panel(page).getByText(/not checked when you save/)).toHaveCount(0);

    await panel(page).getByLabel('Version id or expression').fill('${params.target}');
    // The target is not a listable version, so its declared params are unknown —
    // the arguments are entered directly rather than guessed at.
    await panel(page).getByLabel('Parameters (JSON object)').fill('{"query":"ships"}');
    await panel(page).getByRole('button', { name: 'Apply call' }).click();

    expect(await validationIssues(page)).toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // Reloaded, the expression comes back as ITSELF — the hazard this arm
    // guards is a target the picker cannot resolve being presented as "nothing
    // chosen" and then lost on the next Apply.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(parentId)}`);
    await canvasNodes(page).first().click();
    await expect(panel(page).getByLabel('Version id or expression')).toHaveValue(
      '${params.target}',
    );
    await expect(panel(page).getByLabel('Parameters (JSON object)')).toHaveValue(
      '{\n  "query": "ships"\n}',
    );

    await expectQuiet(page, problems);
  });

  /**
   * #953 — the LEGACY call node, which the canvas cannot author and so had to be
   * seeded. `Node.call` is an optional discriminant valid on a node of any type,
   * and the literal `type: 'call_pipeline'` stays valid at save for back-compat
   * (`engine/params.ts`), so a doc from an import or an API seed can carry one.
   *
   * The inspector used to route on the TYPE alone, so such a node landed on the
   * generic `node.config` form — which, since that type is not catalogued, derived
   * no fields. The call blob was neither visible nor editable, while `toVersionBody`
   * carried it through every save: a one-way door rather than a data loss.
   *
   * Seeded rather than authored is the point, not a shortcut: this is exactly the
   * path such a doc takes into a real workspace, and no click sequence can reach it.
   */
  test('a legacy call_pipeline-typed node gets a working call editor, not a dead config form', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);

    const { pipelineVersionId } = await seedVersion(page, 'e2e 953 child', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [{ name: 'query', type: 'string', required: true }],
    });

    const parentId = await openSeededCanvas(page, 'e2e 953 legacy parent', {
      nodes: [
        {
          id: 'legacy',
          type: 'call_pipeline',
          call: { pipelineVersionId, params: { query: 'seeded' } },
          position: { x: 0, y: 0 },
        },
      ],
    });

    await canvasNodes(page).first().click();

    // The routing fix: the call editor, resolved from the stored id — not the
    // generic config box, which is what this node used to get.
    await expect(panel(page).getByRole('heading', { name: 'Call target' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Apply config' })).toHaveCount(0);
    await expect(panel(page).getByRole('combobox', { name: 'Pipeline' })).toContainText(
      'e2e 953 child',
    );
    await expect(arg(page, 'query')).toHaveValue('seeded');

    // EDITABLE is the actual ticket — a panel that renders read-only would pass
    // every assertion above. The write goes through `updateNodeCall`, whose guard
    // was keyed on the same type check, so this arm is the one that proves both
    // halves moved together.
    await arg(page, 'query').fill('edited');
    await panel(page).getByRole('button', { name: 'Apply call' }).click();
    expect(await validationIssues(page)).toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // Read from the PERSISTED version: the edit reached an immutable version, and
    // the node kept its legacy type rather than being silently normalised.
    const persisted = await page.request.get(`/api/pipelines/${parentId}/versions`);
    const versions = (await persisted.json()) as {
      version: number;
      nodes: { type: string; call?: { params?: Record<string, unknown> } }[];
    }[];
    const saved = versions.find((v) => v.version === 2)!;
    const node = saved.nodes.find((n) => n.type === 'call_pipeline')!;
    expect(node.call?.params).toMatchObject({ query: 'edited' });

    await expectQuiet(page, problems);
  });

  /**
   * #1012 — the U8a flyout on the call editor. A reference goes into a string
   * argument by SPLICING (at the end, since no caret was placed) and into a
   * number argument by REPLACING, because Apply coerces anything but a whole
   * `${}` against the declared type and would refuse `25${…}`. Read back from
   * the persisted version, so it proves the choice reached the doc.
   */
  test('the expression picker fills call arguments, and they persist', async ({ page }) => {
    const problems = collectPageProblems(page);

    const { pipelineVersionId } = await seedVersion(page, 'e2e 1012 child', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [
        { name: 'query', type: 'string', required: true },
        { name: 'limit', type: 'number', required: false },
      ],
    });
    const parentId = await openSeededCanvas(page, 'e2e 1012 parent', {
      params: [{ name: 'topic', type: 'string', required: true }],
      nodes: [
        {
          id: 'caller',
          type: 'execute_pipeline',
          call: { pipelineVersionId, params: { query: 'about ', limit: 25 } },
          position: { x: 0, y: 0 },
        },
      ],
    });

    await canvasNodes(page).first().click();
    await expect(arg(page, 'query')).toHaveValue('about ');

    await panel(page)
      .getByRole('button', { name: 'Insert reference into parameter query' })
      .click();
    await panel(page)
      .getByRole('button', { name: /^topic/ })
      .click();
    await expect(arg(page, 'query')).toHaveValue('about ${params.topic}');

    await panel(page)
      .getByRole('button', { name: 'Insert reference into parameter limit' })
      .click();
    await panel(page)
      .getByRole('button', { name: /^topic/ })
      .click();
    await expect(arg(page, 'limit')).toHaveValue('${params.topic}');

    await panel(page).getByRole('button', { name: 'Apply call' }).click();
    expect(await validationIssues(page)).toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const persisted = await page.request.get(`/api/pipelines/${parentId}/versions`);
    const versions = (await persisted.json()) as {
      version: number;
      nodes: { id: string; call?: { params?: Record<string, unknown> } }[];
    }[];
    const node = versions.find((v) => v.version === 2)!.nodes.find((n) => n.id === 'caller')!;
    expect(node.call?.params).toEqual({ query: 'about ${params.topic}', limit: '${params.topic}' });

    await expectQuiet(page, problems);
  });
});
