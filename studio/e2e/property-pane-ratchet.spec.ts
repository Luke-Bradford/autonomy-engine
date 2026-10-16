import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, toolbox } from './support/canvasGraph';
import {
  nodeById,
  openSeededCanvas,
  seedVersion,
  type SeedContainer,
  type SeedDoc,
  type SeedNode,
} from './support/seedDoc';
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
 *
 * The walk runs twice: once on each type fresh from the toolbox, and once on
 * each type minted with its config FILLED (`seeds`), so what only renders once
 * a value is set (override rows, table rows, Mark as while inactive) is held
 * too. A toolbox entry with no filled seed fails the second walk.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/**
 * Toolbox name → the most `?`s its pane may show. Lower only. Prose has no
 * budget: none, in any pane (item 4). Where slice 8 turned a paragraph into a
 * `?` (a container's palette sentence, the call's Wait note), the count rose by
 * that one, once. Since the per-field audit (#1694 OR42 item 4), a config field
 * has a `?` only where the catalog wrote it a note, so each count is the pane's
 * `About` `?`, its General policy fields and the fields whose value is not
 * obvious from the label, measured.
 */
const HELP_LIMITS: Record<string, number> = {
  'Copy data': 9,
  'Delete file': 7,
  // #1600 OR41 C8a — List directory's 7 (retired from the palette by C8b) and
  // the Field list's, which says the unticked outputs are null and what Exists
  // does for a missing path.
  'Get metadata': 8,
  'HTTP request': 9,
  // +3 for C7a's Settings, each `?` a fact its label lacks: First row only names
  // the output it writes, Max rows its ceiling, When over the limit both bounds.
  // +1 for C7b's Read as, which says what each mode reads.
  Lookup: 10,
  'Write file': 7,
  'Agent task': 8,
  'LLM call': 15,
  'Append variable': 6,
  'Execute pipeline': 6,
  Fail: 5,
  Filter: 7,
  'If condition': 6,
  'Set variable': 5,
  Switch: 6,
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
  /** What the visible controls hold: a value, and a choice's option text too. */
  values: string[];
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
    const values: string[] = [];
    const controls = panel.querySelectorAll<HTMLElement>(
      'select, textarea, input:not([type="checkbox"], [type="radio"], [type="hidden"]), .connection-picker__combobox',
    );
    for (const control of controls) {
      if (!visible(control)) continue;
      if (control instanceof HTMLSelectElement) {
        values.push(control.value, control.selectedOptions[0]?.text ?? '');
      } else if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        values.push(control.value);
      }
      if (control.closest('.row-table, [role="tablist"]') !== null) continue;
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
      values,
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
  const values = new Set<string>();
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
    for (const value of read.values) values.add(value);
    help += read.tabHelp;
    if (i === 0) {
      prose.push(...read.panelProse.map((line) => `panel: ${line}`));
      help += read.panelHelp;
    }
  }
  return { prose, help, values };
}

type Measured = Record<string, { prose: number; help: number; lines: string[] }>;

/** Prose fails outright; a `?` count over its limit, or with no limit, fails. */
function judge(measured: Measured, limits: Record<string, number>, misses: string[]) {
  for (const [name, got] of Object.entries(measured)) {
    if (got.prose > 0) misses.push(`${name}: prose: ${got.lines.join(' | ')}`);
    const limit = limits[name];
    if (limit === undefined) {
      misses.push(`${name}: no ? limit — ? ${got.help}`);
      continue;
    }
    if (got.help > limit) misses.push(`${name}: ? ${got.help} > ${limit}`);
  }
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
  const measured: Measured = {};
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

  judge(measured, HELP_LIMITS, misses);
  expect(misses).toEqual([]);
  await expectQuiet(page, problems);
});

/**
 * The seeded walk's limits: the same `?` ratchet, read on a pane whose config
 * is FILLED — every override row, table row and choice-gated field showing, so
 * a field that only renders once its neighbour is set is measured too. Each is
 * this walk's own measured count; lower only. A key with a ` (…)` suffix is a second state
 * of that toolbox entry (the files-as-is copy, structured output, inactive).
 */
const INLINE_SQL = 'SELECT id FROM orders WHERE region = :region AND load <> :load';

const SEEDED_HELP_LIMITS: Record<string, number> = {
  'Copy data': 9,
  'Copy data (files as-is)': 19,
  'Copy data (files from a folder)': 16,
  // +1 for C1q-c's Query timeout, a new field whose `?` says blank means no limit.
  'Copy data (inline query)': 13,
  'Delete file': 7,
  // #1600 OR41 C8a — the 8 above and Child items' four settings: Filter's
  // wildcard syntax, Child entries' All, and the window's UTC and folders.
  'Get metadata': 12,
  'HTTP request': 9,
  // +3 for C7a's Settings, each `?` a fact its label lacks: First row only names
  // the output it writes, Max rows its ceiling, When over the limit both bounds.
  // +1 on each Lookup for C7b's Read as, whose `?` says what each mode reads;
  // Read file became Lookup's Whole file as text, and gained that one.
  Lookup: 10,
  'Lookup (inline table)': 13,
  // +1 for C7c's When over the limit, whose `?` names the limit and the default.
  'Lookup (whole file as text)': 9,
  'Write file': 7,
  'Agent task': 8,
  'LLM call': 15,
  'LLM call (structured)': 15,
  'Append variable': 6,
  'Execute pipeline': 6,
  Fail: 5,
  Filter: 7,
  'If condition': 6,
  'Set variable': 5,
  Switch: 6,
  Wait: 6,
  'Wait (inactive)': 7,
  'Webhook (external wait)': 6,
  ForEach: 5,
  Until: 5,
  Stage: 2,
  'Stage (inactive)': 3,
};

/**
 * Per seed, values its pane must hold in some control once it renders, so a
 * seed whose fields never draw (a gate, a dropped key, the wrong state) fails
 * rather than quietly shrinking what is measured.
 */
const SHOWS: Record<string, string[]> = {
  'Copy data': ['orders_2026.csv', '${run.runId}', 'customer_name', 'E2E-1'],
  'Copy data (files as-is)': ['files.txt', '/tmp/e2e/done', 'merged.txt', 'E2E-1'],
  'Copy data (files from a folder)': ['*.csv', '/tmp/e2e/in'],
  'Copy data (inline query)': [INLINE_SQL, 'region', 'EU', '${run.runId}'],
  'Lookup (inline table)': ['main', 'orders'],
  'Delete file': ['/tmp/e2e/old.txt', '2048', 'E2E-1'],
  'Get metadata': ['/tmp/e2e', '*.csv', '2026-10-01T00:00:00Z', '2048', 'E2E-1'],
  'Lookup (whole file as text)': ['/tmp/e2e/in.txt', '2048', 'E2E-1'],
  'Write file': ['/tmp/e2e/out.txt', '2048', 'E2E-1'],
  'HTTP request': ['/v1/orders', 'X-Trace', '15000', 'E2E-1'],
  Lookup: ['orders_2026.csv', '4096', 'E2E-1'],
  'Agent task': ['Summarise the repo', '/tmp/e2e', 'E2E-1'],
  'LLM call': ['Price of SKU-1?', 'lookup_price', 'claude-haiku-4-5', 'E2E-1'],
  'LLM call (structured)': ['Classify'],
  'Append variable': ['rows', 'x'],
  'Set variable': ['count', '5'],
  'Execute pipeline': ['eu'],
  Fail: ['Stopped: ${run.runId}'],
  Filter: ['${greater(item, 1)}'],
  'If condition': ['${equals(1, 1)}'],
  Switch: ['gold\nsilver'],
  Wait: ['${30}'],
  'Wait (inactive)': ['failure'],
  'Webhook (external wait)': ['${600}'],
  ForEach: ["${createArray('a.csv', 'b.csv')}"],
  Until: ['${equals(1, 1)}'],
  Stage: ['any'],
  'Stage (inactive)': ['skipped'],
};

type NodeSeed = Omit<SeedNode, 'id' | 'position'>;
type Seed =
  { node: NodeSeed } | { container: Omit<SeedContainer, 'id' | 'children'>; child: NodeSeed };

interface SeedIds {
  fs: string;
  http: string;
  llm: string;
  agent: string;
  sql: string;
  source: string;
  sink: string;
  child: string;
}

/** Every toolbox entry with its config filled, plus the second states above. */
function seeds(ids: SeedIds): Record<string, Seed> {
  const description = 'Seeded so every field renders.';
  // Timeout and user properties are refused on control and call nodes, and the
  // secure flags on the branch, variable and call nodes.
  const exec = {
    description,
    policy: {
      timeoutSeconds: 120,
      retry: 2,
      retryIntervalSeconds: 60,
      secureInput: true,
      secureOutput: true,
    },
    userProperties: [
      { name: 'team', value: 'data' },
      { name: 'ticket', value: 'E2E-1' },
    ],
  };
  const control = {
    description,
    policy: { retry: 2, retryIntervalSeconds: 60, secureInput: true, secureOutput: true },
  };
  const retryOnly = { description, policy: { retry: 2, retryIntervalSeconds: 60 } };
  const fsNode = (type: string, config: Record<string, unknown>): Seed => ({
    node: { ...exec, type, config, connectionId: ids.fs, connectionParams: { maxBytes: 2048 } },
  });
  const body: NodeSeed = { type: 'wait', config: { seconds: '${0}' } };
  return {
    'Copy data': {
      node: {
        ...exec,
        type: 'copy',
        connectionIds: { source: ids.fs, sink: ids.sql },
        datasetIds: { source: ids.source, sink: ids.sink },
        datasetParams: { source: { path: 'orders_2026.csv' } },
        config: {
          mode: 'overwrite',
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'name', sink: 'customer_name', type: 'string', onError: 'null' },
            { expression: '${run.runId}', sink: 'load_id', type: 'string' },
          ],
        },
      },
    },
    'Copy data (files as-is)': {
      node: {
        ...exec,
        type: 'copy_files',
        connectionIds: { source: ids.fs, sink: ids.fs },
        config: {
          pathType: 'list',
          sourcePath: '/tmp/e2e/in',
          fileListPath: 'files.txt',
          modifiedStart: '2026-10-01T00:00:00Z',
          modifiedEnd: '2026-10-13T00:00:00Z',
          afterCopy: 'move',
          moveTo: '/tmp/e2e/done',
          sinkFolder: '/tmp/e2e/out',
          sinkFileName: 'merged.txt',
          copyBehavior: 'merge',
          ifExists: 'skip',
        },
      },
    },
    'Copy data (files from a folder)': {
      node: {
        ...exec,
        type: 'copy_files',
        connectionIds: { source: ids.fs, sink: ids.fs },
        config: {
          pathType: 'folder',
          sourcePath: '/tmp/e2e/in',
          wildcard: '*.csv',
          recursive: true,
          sinkFolder: '/tmp/e2e/out',
        },
      },
    },
    // #1600 C1q-b — a database source read inline: Use, the statement and its
    // bind values on Copy, and the schema and table on Lookup.
    'Copy data (inline query)': {
      node: {
        ...exec,
        type: 'copy',
        connectionIds: { source: ids.sql, sink: ids.sql },
        datasetIds: { sink: ids.sink },
        inlineDatasets: {
          source: {
            kind: 'query',
            config: { sql: INLINE_SQL, parameters: { region: 'EU', load: '${run.runId}' } },
          },
        },
        config: { mode: 'append', mapping: [{ source: 'id', sink: 'id', type: 'integer' }] },
      },
    },
    'Lookup (inline table)': {
      node: {
        ...exec,
        type: 'lookup',
        connectionId: ids.sql,
        inlineDatasets: { source: { kind: 'table', config: { schema: 'main', table: 'orders' } } },
        config: {},
      },
    },
    'Delete file': fsNode('file_delete', { path: '/tmp/e2e/old.txt' }),
    // #1600 OR41 C8a — Child items ticked, so its settings draw too.
    'Get metadata': fsNode('get_metadata', {
      path: '/tmp/e2e',
      fieldList: ['exists', 'childItems'],
      childFilter: '*.csv',
      childType: 'files',
      modifiedStart: '2026-10-01T00:00:00Z',
    }),
    'Lookup (whole file as text)': fsNode('file_read', { path: '/tmp/e2e/in.txt' }),
    'Write file': fsNode('file_write', { path: '/tmp/e2e/out.txt', content: 'one\ntwo' }),
    'HTTP request': {
      node: {
        ...exec,
        type: 'http_request',
        connectionId: ids.http,
        connectionParams: { timeoutMs: 15000 },
        config: {
          url: '/v1/orders',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Trace': 'e2e' },
          body: '{"hello":"world"}',
          secretHeaders: { Authorization: { $secret: 'api_token' } },
        },
      },
    },
    Lookup: {
      node: {
        ...exec,
        type: 'lookup',
        connectionId: ids.fs,
        connectionParams: { maxBytes: 4096 },
        datasetIds: { source: ids.source },
        datasetParams: { source: { path: 'orders_2026.csv' } },
        config: {},
      },
    },
    'Agent task': {
      node: {
        ...exec,
        type: 'agent_task',
        connectionId: ids.agent,
        connectionParams: { cwd: '/tmp' },
        config: {
          task: 'Summarise the repo',
          cwd: '/tmp/e2e',
          outputSchema: {
            type: 'object',
            required: ['summary'],
            properties: { summary: { type: 'string' }, score: { type: 'number' } },
          },
        },
      },
    },
    'LLM call': {
      node: {
        ...exec,
        type: 'llm_call',
        connectionId: ids.llm,
        connectionParams: { model: 'claude-haiku-4-5' },
        config: {
          model: 'claude-sonnet-4-5',
          maxTokens: 1024,
          temperature: 0.2,
          topP: 0.9,
          stop: ['END', 'STOP'],
          seed: 42,
          reasoningEffort: 'medium',
          system: 'You are terse.',
          messages: [
            { role: 'system', content: 'Answer in English.' },
            { role: 'user', content: 'Price of SKU-1?' },
          ],
          history: '${params.history}',
          tools: [
            {
              name: 'lookup_price',
              description: 'Look up a price',
              parameters: {
                type: 'object',
                properties: { sku: { type: 'string' } },
                required: ['sku'],
              },
              expression: '${tool.args.sku}',
            },
          ],
          toolChoice: 'auto',
          maxToolIterations: 3,
          outputMode: 'text',
          emitMessages: true,
          capture: 'full',
          captureReasoning: true,
        },
      },
    },
    'LLM call (structured)': {
      node: {
        ...exec,
        type: 'llm_call',
        connectionId: ids.llm,
        config: {
          prompt: 'Classify',
          outputMode: 'structured',
          outputSchema: {
            type: 'object',
            properties: { label: { type: 'string', enum: ['a', 'b'] } },
          },
        },
      },
    },
    'Append variable': {
      node: { ...retryOnly, type: 'append_variable', config: { variable: 'rows', value: 'x' } },
    },
    'Set variable': {
      node: { ...retryOnly, type: 'set_variable', config: { variable: 'count', value: '5' } },
    },
    'Execute pipeline': {
      node: {
        ...retryOnly,
        type: 'execute_pipeline',
        config: {},
        call: { pipelineVersionId: ids.child, params: { region: 'eu', limit: 5 }, wait: true },
      },
    },
    Fail: { node: { ...control, type: 'fail', config: { message: 'Stopped: ${run.runId}' } } },
    Filter: {
      node: {
        ...control,
        type: 'filter',
        config: { items: '${createArray(1, 2, 3)}', predicate: '${greater(item, 1)}' },
      },
    },
    'If condition': {
      node: { ...retryOnly, type: 'if', config: { condition: '${equals(1, 1)}' } },
    },
    Switch: {
      node: {
        ...retryOnly,
        type: 'switch',
        config: { on: "${toLower('Gold')}", cases: ['gold', 'silver'] },
      },
    },
    Wait: { node: { ...control, type: 'wait', config: { seconds: '${30}' } } },
    'Wait (inactive)': {
      node: {
        ...control,
        type: 'wait',
        config: { seconds: '${30}' },
        state: 'inactive',
        onInactiveMarkAs: 'failure',
      },
    },
    'Webhook (external wait)': {
      node: { ...control, type: 'webhook', config: { timeoutSeconds: '${600}' } },
    },
    ForEach: {
      container: {
        kind: 'foreach',
        items: "${createArray('a.csv', 'b.csv')}",
        batchCount: 4,
        allowNondeterministicVars: true,
        join: 'any',
        description,
      },
      child: body,
    },
    Until: {
      container: {
        kind: 'loop',
        exitWhen: '${equals(1, 1)}',
        maxRounds: 5,
        timeout: 600,
        join: 'any',
        description,
      },
      child: body,
    },
    Stage: { container: { kind: 'stage', join: 'any', description }, child: body },
    'Stage (inactive)': {
      container: { kind: 'stage', description, state: 'inactive', onInactiveMarkAs: 'skipped' },
      child: body,
    },
  };
}

test('every catalog activity and container, its config FILLED: the same four holds, `?`s held', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const problems = collectPageProblems(page);
  const fs = await seedConnection(page, {
    name: 'e2e or42 seeded files',
    kind: 'fs',
    config: { roots: ['/tmp'], maxBytes: 1048576, writable: true },
    parameters: ['maxBytes'],
  });
  // Copy's sink is a table, on a database connection.
  const sql = await seedConnection(page, {
    name: 'e2e or42 seeded db',
    kind: 'sqlite',
    config: { roots: ['/tmp'], path: '/tmp/e2e-or42-panes.db', writable: true },
  });
  const columns = (names: string[]) =>
    names.map((name, i) => ({ name, type: i === 0 ? 'integer' : 'string', nullable: i > 0 }));
  const ids: SeedIds = {
    fs,
    http: await seedConnection(page, {
      name: 'e2e or42 seeded http',
      kind: 'http',
      config: { baseUrl: 'https://example.test', timeoutMs: 10000 },
      parameters: ['timeoutMs'],
    }),
    llm: await seedConnection(page, {
      name: 'e2e or42 seeded llm',
      kind: 'anthropic_api',
      config: { model: 'claude-sonnet-4-5', timeoutMs: 60000 },
      parameters: ['model'],
    }),
    agent: await seedConnection(page, {
      name: 'e2e or42 seeded agent',
      kind: 'agent_cli',
      config: { command: '/bin/echo', args: ['hi'], cwd: '/tmp', timeoutMs: 60000 },
      parameters: ['cwd'],
    }),
    source: await seedDataset(page, {
      name: 'e2e or42 seeded orders',
      kind: 'delimited',
      connectionId: fs,
      config: { path: 'orders.csv' },
      columns: columns(['id', 'name']),
      parameters: ['path'],
    }),
    sql,
    sink: await seedDataset(page, {
      name: 'e2e or42 seeded orders table',
      kind: 'table',
      connectionId: sql,
      config: { table: 'orders' },
      columns: columns(['id', 'customer_name', 'load_id', 'note']),
    }),
    child: (
      await seedVersion(page, 'or42 seeded child', {
        params: [
          { name: 'region', type: 'string', required: true },
          { name: 'limit', type: 'number', required: false, default: 10 },
        ],
        nodes: [{ id: 'c1', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
      })
    ).pipelineVersionId,
  };
  const all = seeds(ids);

  // Every toolbox entry has a seed under its own name, so one added to the
  // catalog fails here until it is given a filled config.
  await openSeededCanvas(page, 'or42 seeded toolbox', { nodes: [] });
  const names = await toolbox(page).locator('.activity-toolbox__item').allTextContents();
  const misses: string[] = names
    .filter((name) => all[name] === undefined)
    .map((name) => `${name}: no seeded config`);
  expect(names.length).toBeGreaterThan(10);

  const measured: Measured = {};
  for (const [i, [key, seed]] of Object.entries(all).entries()) {
    const entry = names.includes(key) ? key : key.replace(/ \(.*\)$/, '');
    if (!names.includes(entry)) {
      misses.push(`${key}: seeds no toolbox entry`);
      continue;
    }
    // Ids new to each canvas, so its readiness waits cannot be met by the last
    // seed's nodes before the route has switched.
    const id = `n${i}`;
    const doc: SeedDoc = {
      variables: [
        { name: 'count', type: 'number', default: 0 },
        { name: 'rows', type: 'array', default: [] },
      ],
      params: [{ name: 'history', type: 'json', required: false, default: [] }],
      nodes: [{ ...('node' in seed ? seed.node : seed.child), id, position: { x: 0, y: 0 } }],
      containers: 'container' in seed ? [{ ...seed.container, id: `box${i}`, children: [id] }] : [],
    };
    await openSeededCanvas(page, `or42 seeded ${key}`, doc);
    let tablist: string;
    if ('node' in seed) {
      await nodeById(page, id).click();
      tablist = 'Activity properties';
    } else {
      await page.getByRole('button', { name: /^Configure / }).click();
      tablist = 'Container properties';
    }
    // The pane is the seed's toolbox entry, not some other type's.
    await expect(
      properties(page)
        .locator('.property-panel__header')
        .getByLabel(`About ${entry}`, { exact: true }),
    ).toBeAttached();
    const { prose, help, values } = await readPane(page, tablist, key, misses);
    measured[key] = { prose: prose.length, help, lines: prose };
    const shows = SHOWS[key];
    if (shows === undefined) misses.push(`${key}: no SHOWS entry`);
    for (const value of shows ?? []) {
      if (!values.has(value)) misses.push(`${key}: no control holds ${JSON.stringify(value)}`);
    }
  }
  judge(measured, SEEDED_HELP_LIMITS, misses);
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
  await addActivity(page, 'Lookup');
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
