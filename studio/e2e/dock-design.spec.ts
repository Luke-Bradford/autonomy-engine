import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  computedStyles as styles,
  DENSITIES,
  DESIGN_RUNS,
  expectAppearance,
  expectControlHeights,
  preferAppearance,
} from './support/appearance';
import {
  addActivity,
  canvasNodes,
  deselect,
  selectEdge,
  validationIssues,
} from './support/canvasGraph';
import { openProblems, pickConnection, properties } from './support/panels';
import { seedConnection } from './support/seedResources';
import { offRampText } from './support/typeRamp';
import { nodeById, openSeededCanvas, seedVersion } from './support/seedDoc';

/**
 * #1594 OR40 S6l — the editor's properties dock and its Problems column on the
 * design system, at 1440x900 in compact light and comfortable dark: every tab
 * of the pipeline's properties, of an activity and of a call, a lookup's
 * connection overrides, the edge panel, and Problems with an issue in it.
 *
 * Measured: all text on the type ramp; the bordered groups (an edge's outcome,
 * a call's target, a connection's overrides) on one skin; their option rows,
 * the panel's acts, the `ƒx` toggles and the dock's header buttons at
 * `--control-h`; spacing on the 4px scale at the values below.
 */

type Density = (typeof DENSITIES)[number];

const DOCK = '.property-dock';

/** The one bordered group: 8px by 12px inside a 6px radius, its legend in caption type. */
const GROUP_BOX = {
  'padding-top': '8px',
  'padding-left': '12px',
  'border-top-left-radius': '6px',
  'row-gap': '4px',
};

/** Every tab of the dock's tablist `name`, each on the ramp once shown. */
async function expectTabsOnRamp(page: Page, name: string, d: Density): Promise<number> {
  const tabs = properties(page).getByRole('tablist', { name }).getByRole('tab');
  const count = await tabs.count();
  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const title = (await tab.textContent())?.trim();
    expect(await offRampText(page, d, DOCK), `${name} › ${title}: ramp`).toEqual([]);
  }
  return count;
}

for (const { density, theme } of DESIGN_RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6l — the dock's tabs and Problems on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);

    const connId = await seedConnection(page, {
      name: `S6l files ${density} ${Date.now()}`,
      kind: 'fs',
      config: { roots: ['/tmp/e2e-s6l'], maxBytes: 1000 },
      parameters: ['maxBytes'],
    });
    const { pipelineVersionId } = await seedVersion(page, `S6l child ${density} ${Date.now()}`, {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      params: [{ name: 'query', type: 'string', required: true }],
    });
    await openSeededCanvas(page, `S6l dock ${density} ${Date.now()}`, {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 320, y: 0 } },
        {
          id: 'call',
          type: 'call_pipeline',
          call: { pipelineVersionId, params: { query: 'seeded' } },
          position: { x: 640, y: 0 },
        },
      ],
      edges: [{ from: 'a', to: 'b', on: 'success' }],
      params: [{ name: 'topic', type: 'string', required: false }],
    });
    await expectAppearance(page, theme, d);

    // An activity with nothing filled in, so Problems has an issue to list.
    await addActivity(page, 'Web');
    await expect.poll(() => validationIssues(page)).not.toEqual([]);
    await deselect(page);
    // Opened, since it never opens by itself (#1694 OR42).
    await openProblems(page);

    // The dock's shell, its header and the Problems column.
    const shell = await styles(
      page,
      [DOCK, '.badge-list', '.badge-list ul', '.count-badge'],
      [
        'row-gap',
        'padding-top',
        'padding-left',
        'margin-top',
        'border-top-left-radius',
        'font-size',
      ],
    );
    expect(shell[DOCK]?.['row-gap'], 'dock').toBe('4px');
    expect(shell['.badge-list'], 'problems list').toMatchObject({
      'padding-top': '8px',
      'padding-left': '12px',
      'margin-top': '0px',
      'border-top-left-radius': '6px',
    });
    expect(shell['.badge-list ul'], 'problems items').toMatchObject({
      'margin-top': '4px',
      'padding-left': '16px',
    });
    expect(shell['.count-badge'], 'problems count').toMatchObject({
      'padding-left': '4px',
      'font-size': '12px',
    });
    await expectControlHeights(page, '.property-dock__header button', d, 'dock header');

    // The pipeline's own properties, every tab.
    expect(await expectTabsOnRamp(page, 'Pipeline properties', d)).toBeGreaterThan(1);

    // An activity, every tab, with its acts in the header row.
    await nodeById(page, 'a').click();
    expect(await expectTabsOnRamp(page, 'Activity properties', d)).toBeGreaterThan(1);
    const activity = await styles(
      page,
      ['.property-panel__actions', '.property-panel__type', '.panel-tabs-sticky'],
      ['column-gap', 'row-gap', 'font-size'],
    );
    expect(activity['.panel-tabs-sticky']?.['row-gap'], 'header over its tabs').toBe('4px');
    expect(activity['.property-panel__actions']?.['column-gap'], 'acts').toBe('8px');
    expect(activity['.property-panel__type']?.['font-size'], 'type').toBe('12px');
    await expectControlHeights(page, '.property-panel__actions button', d, 'acts');
    await properties(page).getByRole('tab', { name: 'Request' }).click();
    await expectControlHeights(page, `${DOCK} .expression-picker-toggle`, d, 'ƒx toggles');

    // A call: its target mode is the bordered group, its options control-tall rows.
    await nodeById(page, 'call').click();
    await expectTabsOnRamp(page, 'Activity properties', d);
    await properties(page).getByRole('tab', { name: 'Settings' }).click();
    const call = await styles(
      page,
      ['.call-mode', '.call-mode > legend', '.call-mode label'],
      ['padding-top', 'padding-left', 'border-top-left-radius', 'row-gap', 'font-size'],
    );
    expect(call['.call-mode'], 'call target').toMatchObject(GROUP_BOX);
    expect(call['.call-mode > legend'], 'call target: legend').toMatchObject({
      'padding-left': '4px',
      'font-size': '12px',
    });
    expect(call['.call-mode label'], 'call target: option').toMatchObject({
      'padding-left': '8px',
      'border-top-left-radius': '4px',
    });
    await expectControlHeights(page, '.call-mode label', d, 'call target');

    // An edge: its outcome is the same group.
    await selectEdge(page);
    expect(await offRampText(page, d, DOCK), 'edge: ramp').toEqual([]);
    const edge = await styles(
      page,
      ['.edge-outcomes', '.edge-outcome-swatch'],
      ['padding-top', 'padding-left', 'border-top-left-radius', 'row-gap'],
    );
    expect(edge['.edge-outcomes'], 'edge outcome').toMatchObject(GROUP_BOX);
    expect(edge['.edge-outcome-swatch']?.['border-top-left-radius'], 'swatch').toBe('999px');
    await expectControlHeights(page, '.edge-outcome', d, 'edge outcome');

    await expectQuiet(page, problems);

    // A lookup bound to a connection that declares a parameter: its overrides
    // are the bordered group too, spaced as a group of fields. In a page of its
    // own, so leaving the edited canvas above raises no unsaved-changes block.
    const lookup = await page.context().newPage();
    const lookupProblems = collectPageProblems(lookup);
    await lookup.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(lookup, theme, d);
    await openSeededCanvas(lookup, `S6l overrides ${density} ${Date.now()}`, { nodes: [] });
    await addActivity(lookup, 'Lookup');
    await canvasNodes(lookup).first().click();
    // The dock reopens the tab last chosen (#852): this test picked Settings
    // for the call node above, and a Lookup has one since #1600 C7a.
    await properties(lookup).getByRole('tab', { name: 'Source' }).click();
    await pickConnection(lookup, 'Connection', { id: connId });
    await expect(
      properties(lookup).getByRole('group', { name: 'Connection overrides' }),
    ).toBeVisible();
    expect(await offRampText(lookup, d, DOCK), 'overrides: ramp').toEqual([]);
    const overrides = await styles(
      lookup,
      ['.param-overrides', '.param-overrides > legend'],
      ['padding-top', 'padding-left', 'border-top-left-radius', 'row-gap', 'font-size'],
    );
    expect(overrides['.param-overrides'], 'overrides').toMatchObject({
      ...GROUP_BOX,
      'row-gap': '8px',
    });
    expect(overrides['.param-overrides > legend'], 'overrides: legend').toMatchObject({
      'padding-left': '4px',
      'font-size': '12px',
    });

    await expectQuiet(lookup, lookupProblems);
  });
}
