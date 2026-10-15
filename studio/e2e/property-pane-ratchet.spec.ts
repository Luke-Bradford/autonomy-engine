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
 * - every control outside a table holds its size class, S, M or the row's
 *   value column, and a choice shows its longest option whole (F10);
 * - the pane shows no prose at all, and
 * - its `?`s, per type, never rise above the counts seeded below.
 *
 * The `?` count is a RATCHET: seeded from what slice 3 left, it may only fall.
 * A type the map does not know fails until it is seeded, so a new activity's
 * pane is looked at once, deliberately. Prose is a visible `p`,
 * `.page-hint` or `.field-hint` of four words or more, outside a status, an
 * error, an advisory or a `?` note: an empty state ("No rows.") is not prose,
 * and a warning about the current value is not there to be read in advance.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/**
 * Toolbox name → the most `?`s its pane may show. Lower only. What is left is
 * OR42's per-field `?` audit (#1694). Prose has no budget: none, in any pane
 * (item 4). Where slice 8 turned a paragraph into a `?` (a container's palette
 * sentence, the call's Wait note), the count rose by that one, once.
 */
const HELP_LIMITS: Record<string, number> = {
  'Copy data': 10,
  'Copy file': 8,
  'Delete file': 7,
  'HTTP request': 11,
  'List directory': 7,
  'Lookup rows': 6,
  'Move file': 8,
  'Read file': 7,
  'Write file': 8,
  'Agent task': 9,
  'LLM call': 25,
  'Append variable': 7,
  'Execute pipeline': 6,
  Fail: 6,
  Filter: 7,
  'If condition': 6,
  'Set variable': 7,
  Switch: 7,
  Wait: 6,
  'Webhook (external wait)': 6,
  ForEach: 5,
  Until: 5,
  Stage: 2,
};

interface TabRead {
  wideButtons: string[];
  headHelp: string[];
  tabProse: string[];
  panelProse: string[];
  tabHelp: number;
  panelHelp: number;
  offSize: string[];
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

    // F10 — every control outside a table holds its OWN size class: what
    // `data-size` says (`fieldSize`), and otherwise a select or a binding is an
    // M, a number an S, anything else an L, its right edge on its row's. An S
    // or an M may only be narrower where its row is (`max-width: 100%`), never
    // stretched. A table's cells are sized by their columns. A Fluent combobox
    // is measured by its box, not its inner input. A choice must also show its
    // longest option whole, beside its native arrow, where its options are
    // the schema's.
    // The classes (`--field-s`, `--field-m`) and the slack either side. Here,
    // not module scope: this function runs in the page.
    const WIDTH = { s: 120, m: 240 } as Record<string, number>;
    const SLACK = 4;
    const ARROW = 20;
    const ctx = document.createElement('canvas').getContext('2d')!;
    const offSize: string[] = [];
    const controls = panel.querySelectorAll<HTMLElement>(
      'select, textarea, input:not([type="checkbox"], [type="radio"], [type="hidden"]), .connection-picker__combobox',
    );
    for (const control of controls) {
      if (!visible(control) || control.closest('.row-table, [role="tablist"]') !== null) continue;
      if (control.matches('.connection-picker__combobox input')) continue;
      const box = control.getBoundingClientRect();
      const row = (
        control.closest('.labelled-control') ?? control.parentElement!
      ).getBoundingClientRect();
      const fills = Math.abs(box.right - row.right) <= SLACK;
      const expected =
        control.dataset.size ??
        (control.matches('select, .connection-picker__combobox')
          ? 'm'
          : control.matches('.number-input')
            ? 's'
            : 'l');
      const width = WIDTH[expected];
      const held =
        width === undefined
          ? fills
          : Math.abs(box.width - width) <= SLACK || (fills && box.width < width);
      const name =
        (control as HTMLInputElement).labels?.[0]?.textContent?.trim() ??
        control.getAttribute('aria-label') ??
        control.tagName;
      if (!held) offSize.push(`${name} ${Math.round(box.width)}px, not ${expected.toUpperCase()}`);
      // A SCHEMA choice (marked by `fieldSize`) is a closed set, so it can be
      // held whole; a binding lists the operator's own names, which an M clips.
      if (control instanceof HTMLSelectElement && control.dataset.size !== undefined) {
        const style = getComputedStyle(control);
        ctx.font = style.font;
        const longest = Math.max(
          0,
          ...Array.from(control.options, (o) => ctx.measureText(o.text).width),
        );
        const room =
          control.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          ARROW;
        if (longest > room)
          offSize.push(
            `${name} cuts its longest option: ${Math.round(longest)}px in ${Math.round(room)}px`,
          );
      }
    }
    return {
      offSize,
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
    for (const off of read.offSize) misses.push(`${name} › ${label} › off size: ${off}`);
    prose.push(...read.tabProse.map((line) => `${label}: ${line}`));
    help += read.tabHelp;
    if (i === 0) {
      prose.push(...read.panelProse.map((line) => `panel: ${line}`));
      help += read.panelHelp;
    }
  }
  return { prose, help };
}

test('every catalog activity and container: no wide button, no `?` on a heading, every field S, M or L, no prose, `?`s held', async ({
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
    if (got.prose > 0) misses.push(`${name}: prose: ${got.lines.join(' | ')}`);
    const limit = HELP_LIMITS[name];
    if (limit === undefined) {
      misses.push(`${name}: not seeded — ? ${got.help}`);
      continue;
    }
    if (got.help > limit) misses.push(`${name}: ? ${got.help} > ${limit}`);
  }
  expect(misses).toEqual([]);
  await expectQuiet(page, problems);
});

test('a picker’s Test, Edit and New are icon buttons; overrides are a name/value table, no Add', async ({
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

  // #1694 OR42 item 8 — every declared setting is a row, its name and its box
  // on one line (ADF's Dataset properties); nothing to Add.
  const group = properties(page).getByRole('group', { name: 'Connection overrides' });
  await expect(group.getByRole('button', { name: /^Add/ })).toHaveCount(0);
  // The name's TEXT, not its cell: a row header's box is the whole row's height.
  const name = await group
    .getByRole('rowheader', { name: 'Largest file read (bytes)' })
    .evaluate((th) => {
      const range = document.createRange();
      range.selectNodeContents(th);
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  const value = (await group
    .getByRole('textbox', { name: 'Largest file read (bytes)' })
    .boundingBox())!;
  expect(Math.abs(name.y + name.height / 2 - (value.y + value.height / 2))).toBeLessThanOrEqual(2);
  expect(value.x).toBeGreaterThanOrEqual(name.x + name.width);
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
