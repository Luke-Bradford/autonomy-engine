import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, toolbox } from './support/canvasGraph';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { nodeMenuAction, pickConnection, properties } from './support/panels';

/**
 * #1694 OR42 — the properties pane is a technical tool: fields and acts, not
 * reading. This walks EVERY catalog activity and container through the
 * Activities toolbox (so one added to the catalog is measured without this file
 * changing), opens every tab at 1440×900, and holds four things:
 *
 * - no button is wider than its own content (an add act sits in a toolbar sized
 *   to its text, never stretched across the form);
 * - no section heading carries a `?`;
 * - the pane's prose lines, and
 * - its `?`s, per type, never rise above the counts seeded below.
 *
 * The two counts are a RATCHET: seeded from what slice 3 left, they may only
 * fall. A type the map does not know fails until it is seeded, so a new
 * activity's pane is looked at once, deliberately. Prose is a visible `p`,
 * `.page-hint` or `.field-hint` of four words or more, outside a status, an
 * error, an advisory or a `?` note: an empty state ("No rows.") is not prose,
 * and a warning about the current value is not there to be read in advance.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/**
 * Toolbox name → the most prose lines and `?`s its pane may show. Lower only.
 * What is left is OR42's open slices (#1694): the config fields' visible hints
 * and the call and container panels' notes (item 4's rest), and the `?`s each
 * field still carries (the per-field `?` audit).
 */
const LIMITS: Record<string, { prose: number; help: number }> = {
  'Copy data': { prose: 1, help: 10 },
  'Copy file': { prose: 0, help: 8 },
  'Delete file': { prose: 0, help: 7 },
  'HTTP request': { prose: 1, help: 11 },
  'List directory': { prose: 0, help: 7 },
  'Lookup rows': { prose: 0, help: 6 },
  'Move file': { prose: 0, help: 8 },
  'Read file': { prose: 0, help: 7 },
  'Write file': { prose: 0, help: 8 },
  'Agent task': { prose: 1, help: 9 },
  'LLM call': { prose: 1, help: 25 },
  'Append variable': { prose: 1, help: 7 },
  'Execute pipeline': { prose: 1, help: 5 },
  Fail: { prose: 0, help: 6 },
  Filter: { prose: 0, help: 7 },
  'If condition': { prose: 0, help: 6 },
  'Set variable': { prose: 1, help: 7 },
  Switch: { prose: 0, help: 7 },
  Wait: { prose: 0, help: 6 },
  'Webhook (external wait)': { prose: 0, help: 6 },
  ForEach: { prose: 2, help: 4 },
  Until: { prose: 1, help: 4 },
  Stage: { prose: 1, help: 1 },
};

interface TabRead {
  wideButtons: string[];
  headHelp: string[];
  tabProse: string[];
  panelProse: string[];
  tabHelp: number;
  panelHelp: number;
}

/** One read of the open tab: what is measured, from the rendered page. */
function readTab(page: Page): Promise<TabRead> {
  return properties(page).evaluate((panel) => {
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    // The OPEN tab's panel: the others stay mounted, hidden.
    const tabpanel = [...panel.querySelectorAll('[role="tabpanel"]')].find(visible) ?? null;
    const inTab = (el: Element) => tabpanel !== null && tabpanel.contains(el);

    const wideButtons: string[] = [];
    for (const button of panel.querySelectorAll<HTMLButtonElement>('button')) {
      if (!visible(button) || button.closest('[role="tablist"]') !== null) continue;
      const width = button.getBoundingClientRect().width;
      const before = button.style.width;
      button.style.width = 'max-content';
      const natural = button.getBoundingClientRect().width;
      button.style.width = before;
      if (width > natural + 2 && width > 32) {
        const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
        wideButtons.push(`${name} ${Math.round(width)}px, content ${Math.round(natural)}px`);
      }
    }

    const headHelp = [...panel.querySelectorAll('.section__head')]
      .filter((head) => visible(head) && head.querySelector('summary') !== null)
      .map((head) => (head.querySelector('.section__title')?.textContent ?? '').trim());

    const quiet =
      '[role="status"], [role="alert"], [role="note"], .contract-advisory, .error, .form-error, .field-error-slot';
    const prose = [...panel.querySelectorAll('p, .page-hint, .field-hint')].filter(
      (el) =>
        visible(el) &&
        el.closest(quiet) === null &&
        (el.textContent ?? '').trim().split(/\s+/).length >= 4,
    );
    const text = (el: Element) => (el.textContent ?? '').trim().slice(0, 60);
    const help = [...panel.querySelectorAll('summary[aria-label^="About "]')].filter(visible);
    return {
      wideButtons,
      headHelp,
      tabProse: prose.filter(inTab).map(text),
      panelProse: prose.filter((el) => !inTab(el)).map(text),
      tabHelp: help.filter(inTab).length,
      panelHelp: help.filter((el) => !inTab(el)).length,
    };
  });
}

/** Every tab of the open pane, read in turn; the panel outside the tabs once. */
async function readPane(page: Page, tablist: string, name: string, misses: string[]) {
  const tabs = properties(page).getByRole('tablist', { name: tablist }).getByRole('tab');
  const count = await tabs.count();
  expect(count, `${name} has property tabs`).toBeGreaterThan(0);
  const prose: string[] = [];
  let help = 0;
  for (let i = 0; i < count; i += 1) {
    const tab = tabs.nth(i);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const label = (await tab.textContent())?.trim() ?? String(i);
    // Read until two reads agree: a panel that loads something on mount (the
    // call panel's pipeline list) is measured settled, not mid-load.
    let read = await readTab(page);
    await expect
      .poll(async () => {
        const again = await readTab(page);
        const settled = JSON.stringify(again) === JSON.stringify(read);
        read = again;
        return settled;
      })
      .toBe(true);
    for (const wide of read.wideButtons) misses.push(`${name} › ${label} › wide button: ${wide}`);
    for (const head of read.headHelp) misses.push(`${name} › ${label} › ? on heading: ${head}`);
    prose.push(...read.tabProse.map((line) => `${label}: ${line}`));
    help += read.tabHelp;
    if (i === 0) {
      prose.push(...read.panelProse.map((line) => `panel: ${line}`));
      help += read.panelHelp;
    }
  }
  return { prose, help };
}

test('every catalog activity and container: no wide button, no `?` on a heading, prose and `?`s held', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 pane ratchet', { nodes: [] });

  const item = '.activity-toolbox__item';
  const containers = await toolbox(page)
    .getByRole('list', { name: 'Containers', exact: true })
    .locator(item)
    .allTextContents();
  const activities = (await toolbox(page).locator(item).allTextContents()).filter(
    (name) => !containers.includes(name),
  );
  expect(activities.length).toBeGreaterThan(10);
  expect(containers.length).toBeGreaterThan(2);

  const misses: string[] = [];
  const measured: Record<string, { prose: number; help: number; lines: string[] }> = {};
  for (const name of activities) {
    await toolbox(page).getByRole('button', { name, exact: true }).click();
    await expect(canvasNodes(page)).toHaveCount(1);
    const id = (await canvasNodes(page).getAttribute('data-id'))!;
    await nodeById(page, id).click();
    const { prose, help } = await readPane(page, 'Activity properties', name, misses);
    measured[name] = { prose: prose.length, help, lines: prose };
    await nodeMenuAction(page, 'Delete node');
    await expect(nodeById(page, id)).toHaveCount(0);
  }
  for (const name of containers) {
    // On the same canvas, so nothing navigates away from unsaved work: added,
    // measured, then taken back off by Undo.
    await toolbox(page).getByRole('button', { name, exact: true }).click();
    const configure = page.getByRole('button', { name: /^Configure / });
    await expect(configure).toHaveCount(1);
    await configure.click();
    const { prose, help } = await readPane(page, 'Container properties', name, misses);
    measured[name] = { prose: prose.length, help, lines: prose };
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(configure).toHaveCount(0);
  }

  for (const [name, got] of Object.entries(measured)) {
    const limit = LIMITS[name];
    if (limit === undefined) {
      misses.push(`${name}: not seeded — prose ${got.prose}, ? ${got.help}`);
      continue;
    }
    if (got.prose > limit.prose) {
      misses.push(`${name}: prose ${got.prose} > ${limit.prose}: ${got.lines.join(' | ')}`);
    }
    if (got.help > limit.help) misses.push(`${name}: ? ${got.help} > ${limit.help}`);
  }
  expect(misses).toEqual([]);
  await expectQuiet(page, problems);
});

test('a picker’s Test, Edit and New are icon buttons; an override and its Add share a row', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const connId = await seedConnection(page, {
    name: 'e2e or42 files',
    kind: 'fs',
    config: { roots: ['/tmp/e2e-or42'], maxBytes: 1000 },
    parameters: ['maxBytes'],
  });
  const setId = await seedDataset(page, {
    name: 'e2e or42 people',
    kind: 'delimited',
    connectionId: connId,
    config: { path: 'people.csv' },
    columns: [{ name: 'id', type: 'integer', nullable: false }],
  });
  await openSeededCanvas(page, 'or42 picker icons', { nodes: [] });
  await addActivity(page, 'Lookup rows');
  await canvasNodes(page).first().click();
  await pickConnection(page, 'Connection', { id: connId });
  await properties(page).getByRole('combobox', { name: 'Source dataset' }).selectOption(setId);

  for (const name of ['Test selected connection', 'Edit selected connection', 'New connection']) {
    const button = properties(page).getByRole('button', { name, exact: true });
    await expect(button).toHaveAttribute('title', name);
    await expect(button).toHaveText('');
    expect((await button.boundingBox())!.width).toBeLessThanOrEqual(32);
  }

  const group = properties(page).getByRole('group', { name: 'Connection overrides' });
  const select = (await group
    .getByRole('combobox', { name: 'Add connection override' })
    .boundingBox())!;
  const add = (await group.getByRole('button', { name: 'Add override' }).boundingBox())!;
  expect(Math.abs(add.y + add.height - (select.y + select.height))).toBeLessThanOrEqual(1);
  expect(add.x).toBeGreaterThan(select.x + select.width);
  await expectQuiet(page, problems);
});

test('Copy’s Mapping: Add row and Auto-map share one toolbar above the rows, Auto-map’s note behind its ?', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 mapping toolbar', {
    nodes: [
      {
        id: 'c',
        type: 'copy',
        position: { x: 0, y: 0 },
        config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }] },
      },
    ],
  });
  await nodeById(page, 'c').click();
  await properties(page)
    .getByRole('tablist', { name: 'Activity properties' })
    .getByRole('tab', { name: 'Mapping' })
    .click();
  const add = properties(page).getByRole('button', { name: 'Add column mapping row' });
  const autoMap = properties(page).getByRole('button', { name: 'Auto-map columns' });
  const [a, m] = [(await add.boundingBox())!, (await autoMap.boundingBox())!];
  expect(Math.abs(a.y + a.height / 2 - (m.y + m.height / 2))).toBeLessThanOrEqual(1);
  expect(m.x).toBeGreaterThan(a.x + a.width);
  const table = (await properties(page).getByRole('table').first().boundingBox())!;
  expect(a.y + a.height).toBeLessThanOrEqual(table.y);
  await expect(
    properties(page).getByLabel('About Auto-map columns', { exact: true }),
  ).toBeVisible();
  await expect(properties(page).getByText(/Read from each dataset/)).toHaveCount(0);
  await expectQuiet(page, problems);
});
