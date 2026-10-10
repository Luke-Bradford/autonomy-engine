import { existsSync, mkdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { inArray } from 'drizzle-orm';
import { TERMINAL_RUN_ROW_STATUS } from '@autonomy-studio/shared';
import type {
  DemoRemoveResponse,
  DemoSeedPipeline,
  DemoSeedResponse,
  DemoStatus,
  NewConnection,
  NewDataset,
  NewPipelineVersion,
  NewTrigger,
} from '@autonomy-studio/shared';
import type { Db } from '../repo/types.js';
import { pipelineVersions, runs } from '../db/schema.js';
import { pipelineDependents } from '../repo/pipeline-dependents.js';
import { regateTriggersForConnection } from '../run/connection-readiness.js';
import { ConflictError } from '../errors.js';
import {
  createConnection,
  createDataset,
  createPipeline,
  createPipelineVersion,
  createTrigger,
  deleteConnection,
  deleteDataset,
  deletePipeline,
  deleteTrigger,
  getConnectionByResourceId,
  getDatasetByResourceId,
  getHeadVersionRef,
  getPipelineByResourceId,
  getTriggerByResourceId,
  listConnections,
  listDatasets,
  listPipelines,
  listTriggers,
} from '../repo/index.js';
import { DEMO_LANDING_FILES } from './demo-data.js';

/**
 * #1481 OR32 — the demo ETL pack: messy order CSVs → SQLite staging →
 * clean / aggregate / rejects → an orchestrator, plus one pipeline that fails on
 * purpose. Ported from the operator's hand-run seed of 2026-10-02, which proved
 * every pipeline against a live instance through the public API.
 *
 * WHY NOT EXPORT ENVELOPES (the ticket's suggested format): an export nulls every
 * literal `connectionIds`/`datasetIds` and carries one resource per file
 * (`portability/export.ts`), so an imported demo would arrive unbound and
 * unrunnable. This module is the format instead — the definitions bind to the
 * ids this seed creates.
 *
 * THE TAG IS THE `resourceId`. Every resource the demo manages carries a fixed
 * `demo-etl-…` resourceId, which the `(owner_id, resource_id)` unique index
 * already makes an owner-scoped, index-backed lookup. A second seed finds each
 * one and REUSES it untouched: CREATE-IF-MISSING ONLY, so a re-seed never mints
 * over an edit the operator made to a demo pipeline or re-points their trigger.
 * Starting over is Remove + Load, not a re-seed.
 *
 * SYNCHRONOUS ON PURPOSE. Every read and write here — the DB and the files — is
 * sync, so there is no `await` for a second seed to interleave at, and two
 * concurrent seeds cannot both see "missing" and create twice.
 */

/** Every demo resource's `resourceId` starts with this; nothing else's does. */
export const DEMO_RESOURCE_ID_PREFIX = 'demo-etl-';
const rid = (suffix: string): string => DEMO_RESOURCE_ID_PREFIX + suffix;

export const DEMO_FOLDER = 'Demo';
const P = 'Demo — ';

/**
 * #1481 OR32 — the demo root, resolved once at boot: the call-time option, then
 * `AUTONOMY_DEMO_ROOT`, then `<AUTONOMY_DATA_DIR>/demo` (the data dir Docker
 * mounts), then `demo/` beside the database. Always absolute — the demo's
 * connections are rooted there, and connector roots must be absolute. An empty
 * env value counts as unset, as in `secrets.ts`'s data-dir resolution.
 */
export function resolveDemoRoot(
  option: string | undefined,
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const set = (v: string | undefined): string | undefined => (v === '' ? undefined : v);
  const explicit = set(option) ?? set(env.AUTONOMY_DEMO_ROOT);
  if (explicit !== undefined) return resolve(explicit);
  const dataDir = set(env.AUTONOMY_DATA_DIR);
  if (dataDir !== undefined) return resolve(dataDir, 'demo');
  return resolve(dirname(resolve(dbPath)), 'demo');
}

/**
 * Where one owner's demo lives: `<demoRoot>/<ownerId>`. Per owner so two owners
 * never share a warehouse or read each other's reports through a connection
 * rooted there. Containment-asserted like `checkoutDirFor` (`git/checkout.ts`):
 * a hostile ownerId must not resolve outside the root. Unlike a checkout dir,
 * the root itself is refused too: an owner's demo is never the whole root.
 * String-level; `seedDemo` re-checks the canonical path once the dir exists.
 */
export function demoDirFor(demoRoot: string, ownerId: string): string {
  const root = resolve(demoRoot);
  const dir = resolve(root, ownerId);
  if (dir === root || !dir.startsWith(root + sep)) {
    throw new Error(`demo path for owner "${ownerId}" escapes the demo root`);
  }
  return dir;
}

/**
 * The owner's demo directory, canonical (macOS `/tmp` → `/private/tmp`, which is
 * what the connectors compare `roots` against). Refused unless it is EXACTLY
 * `<canonical root>/<owner>`: a symlink anywhere on that path — out of the root,
 * or across to another owner's directory inside it — would carry the demo's
 * grants, or its delete, somewhere that is not this owner's demo.
 */
function canonicalOwnerDir(demoRoot: string, ownerId: string): string {
  const root = resolve(demoRoot);
  const ownerDir = demoDirFor(root, ownerId);
  const dir = realpathSync(ownerDir);
  if (dir !== join(realpathSync(root), relative(root, ownerDir))) {
    throw new Error(`demo path for owner "${ownerId}" escapes the demo root`);
  }
  return dir;
}

const ORDER_COLS = [
  'order_id',
  'order_date',
  'customer',
  'country',
  'product',
  'qty',
  'unit_price',
  'status',
] as const;

type ColType = 'string' | 'integer' | 'number';
interface Col {
  name: string;
  type: ColType;
  nullable: boolean;
}
const col = (name: string, type: ColType = 'string', nullable = true): Col => ({
  name,
  type,
  nullable,
});

const STAGING_COLS: Col[] = [...ORDER_COLS.map((c) => col(c)), col('source_file')];
const CLEAN_COLS: Col[] = [
  col('order_id'),
  col('order_date'),
  col('customer'),
  col('country'),
  col('product'),
  col('qty', 'integer'),
  col('unit_price', 'number'),
  col('line_total', 'number'),
];
const SALES_COLS: Col[] = [
  col('country'),
  col('orders', 'integer'),
  col('units', 'integer'),
  col('revenue', 'number'),
];
const REJECT_COLS: Col[] = [col('order_id'), col('reason')];

const WAREHOUSE_DDL = `
CREATE TABLE IF NOT EXISTS stg_orders (
  order_id TEXT, order_date TEXT, customer TEXT, country TEXT, product TEXT,
  qty TEXT, unit_price TEXT, status TEXT, source_file TEXT);
CREATE TABLE IF NOT EXISTS orders_clean (
  order_id TEXT, order_date TEXT, customer TEXT, country TEXT, product TEXT,
  qty INTEGER, unit_price REAL, line_total REAL);
CREATE TABLE IF NOT EXISTS sales_by_country (
  country TEXT, orders INTEGER, units INTEGER, revenue REAL);
CREATE TABLE IF NOT EXISTS rejects (order_id TEXT, reason TEXT);
`;

/** Trim, normalise dd/mm/yyyy dates, strip `£` and thousands commas — shared by the clean and rejects queries. */
const STAGED = `WITH s AS (
  SELECT TRIM(order_id) AS order_id,
         CASE WHEN TRIM(order_date) GLOB '[0-9][0-9]/[0-9][0-9]/[0-9][0-9][0-9][0-9]'
              THEN substr(TRIM(order_date), 7, 4) || '-' || substr(TRIM(order_date), 4, 2) || '-' || substr(TRIM(order_date), 1, 2)
              ELSE TRIM(order_date) END AS order_date,
         TRIM(COALESCE(customer, '')) AS customer,
         UPPER(TRIM(country)) AS country,
         TRIM(product) AS product,
         TRIM(COALESCE(qty, '')) AS qty_raw,
         REPLACE(REPLACE(TRIM(unit_price), '£', ''), ',', '') AS price_raw,
         UPPER(TRIM(status)) AS status
  FROM stg_orders
)`;

const SQL_CLEAN = `${STAGED}
SELECT DISTINCT order_id, order_date, customer, country, product,
       CAST(qty_raw AS INTEGER) AS qty,
       CAST(price_raw AS REAL) AS unit_price,
       ROUND(CAST(qty_raw AS INTEGER) * CAST(price_raw AS REAL), 2) AS line_total
FROM s
WHERE customer <> ''
  AND status <> 'CANCELLED'
  AND qty_raw <> '' AND qty_raw NOT GLOB '*[^0-9]*' AND CAST(qty_raw AS INTEGER) > 0
  AND CAST(price_raw AS REAL) > 0
ORDER BY order_id`;

const SQL_REJECTS = `${STAGED}
SELECT order_id, reason FROM (
  SELECT DISTINCT order_id,
         CASE WHEN customer = '' THEN 'missing customer'
              WHEN status = 'CANCELLED' THEN 'cancelled order'
              WHEN qty_raw = '' OR qty_raw GLOB '*[^0-9-]*' THEN 'qty is not a number: ''' || qty_raw || ''''
              WHEN CAST(qty_raw AS INTEGER) <= 0 THEN 'qty is not positive: ' || qty_raw
              WHEN CAST(price_raw AS REAL) <= 0 THEN 'unreadable unit price: ' || price_raw
         END AS reason
  FROM s
) WHERE reason IS NOT NULL
ORDER BY order_id`;

const SQL_SALES = `SELECT country, COUNT(*) AS orders, SUM(qty) AS units, ROUND(SUM(line_total), 2) AS revenue
FROM orders_clean
GROUP BY country
ORDER BY revenue DESC`;

const SQL_REJECT_COUNT = 'SELECT COUNT(*) AS n FROM rejects';

/** Zero rows in staging's shape: an `overwrite` copy of it empties the table. */
const SQL_EMPTY_STAGING =
  'SELECT NULL AS order_id, NULL AS order_date, NULL AS customer, NULL AS country, ' +
  'NULL AS product, NULL AS qty, NULL AS unit_price, NULL AS status, ' +
  'NULL AS source_file WHERE 0';

/** The demo directory's own entries — written by the seed, deleted by Remove. */
const LANDING_DIR = 'landing';
const REPORTS_DIR = 'reports';
const WAREHOUSE_FILE = 'warehouse.db';

interface Paths {
  dir: string;
  landing: string;
  reports: string;
  warehouse: string;
}

const CONN_KEYS = ['fs', 'warehouse'] as const;
type ConnKey = (typeof CONN_KEYS)[number];
const DS_KEYS = [
  'csv',
  'stg',
  'clean',
  'sales',
  'rejects',
  'q_clean',
  'q_sales',
  'q_rejects',
  'q_count',
  'q_empty',
] as const;
type DsKey = (typeof DS_KEYS)[number];
type PipelineKey = DemoSeedPipeline['key'];

type ConnectionDef = Omit<NewConnection, 'ownerId'>;
type DatasetDef = Omit<NewDataset, 'ownerId' | 'connectionId'> & { connection: ConnKey };

function connectionDefs(p: Paths): Record<ConnKey, ConnectionDef> {
  return {
    fs: { name: `${P}landing folder`, kind: 'fs', config: { roots: [p.dir] }, secretRef: null },
    warehouse: {
      name: `${P}warehouse`,
      kind: 'sqlite',
      config: { roots: [p.dir], path: p.warehouse, writable: true },
      secretRef: null,
    },
  };
}

function datasetDefs(p: Paths): Record<DsKey, DatasetDef> {
  const table = (name: string, t: string, columns: Col[]): DatasetDef => ({
    name: `${P}${name}`,
    kind: 'table',
    connection: 'warehouse',
    config: { table: t },
    columns,
  });
  const query = (name: string, sql: string, columns: Col[]): DatasetDef => ({
    name: `${P}query: ${name}`,
    kind: 'query',
    connection: 'warehouse',
    config: { sql },
    columns,
  });
  return {
    csv: {
      name: `${P}orders CSV (any file)`,
      kind: 'delimited',
      connection: 'fs',
      config: { path: `${p.landing}/orders_2026-09.csv`, header: true },
      parameters: ['path'],
      columns: [col('order_id', 'string', false), ...ORDER_COLS.slice(1).map((c) => col(c))],
    },
    stg: table('stg_orders table', 'stg_orders', STAGING_COLS),
    clean: table('orders_clean table', 'orders_clean', CLEAN_COLS),
    sales: table('sales_by_country table', 'sales_by_country', SALES_COLS),
    rejects: table('rejects table', 'rejects', REJECT_COLS),
    q_clean: query('clean orders', SQL_CLEAN, CLEAN_COLS),
    q_sales: query('sales by country', SQL_SALES, SALES_COLS),
    q_rejects: query('rejected orders', SQL_REJECTS, REJECT_COLS),
    q_count: query('reject count', SQL_REJECT_COUNT, [col('n', 'integer')]),
    q_empty: query('empty staging (reset)', SQL_EMPTY_STAGING, STAGING_COLS),
  };
}

export const DEMO_PIPELINE_NAMES: Readonly<Record<PipelineKey, string>> = {
  '1': `${P}1 Load one CSV to staging`,
  '2': `${P}2 Ingest landing folder`,
  '3': `${P}3 Clean and aggregate`,
  '4': `${P}4 Nightly orchestrator`,
  '5': `${P}5 Broken on purpose`,
};
/** Where every refusal that only Remove can clear sends the operator. */
const REMOVE_THEN_LOAD = 'remove the demo (Author → Pipelines → Remove demo), then load it again';
const PIPELINE_KEYS: readonly PipelineKey[] = ['1', '2', '3', '4', '5'];
const runTriggerName = (k: PipelineKey): string =>
  `${P}run ${DEMO_PIPELINE_NAMES[k].slice(P.length)}`;
const HOURLY_TRIGGER_NAME = `${P}hourly 4 Nightly orchestrator`;

type Doc = Omit<NewPipelineVersion, 'pipelineId'>;

interface DocContext {
  p: Paths;
  conn: Record<ConnKey, string>;
  ds: Record<DsKey, string>;
  /** The head version of each pipeline already resolved, for pipeline 4's calls. */
  head: Partial<Record<PipelineKey, string>>;
}

function pipelineDoc(key: PipelineKey, c: DocContext): Doc {
  const { p, conn, ds } = c;
  const staging = (sourceFile: string): Record<string, string>[] => [
    ...ORDER_COLS.map((n) => ({ source: n, sink: n, type: 'string' })),
    { expression: sourceFile, sink: 'source_file', type: 'string' },
  ];
  const same = (cols: Col[]): Record<string, string>[] =>
    cols.map((k) => ({ source: k.name, sink: k.name, type: k.type }));
  const copy = (
    id: string,
    x: number,
    src: DsKey,
    sink: DsKey,
    mapping: Record<string, string>[],
    mode: 'overwrite' | 'append',
    srcConn: ConnKey,
    params?: Record<string, string>,
  ): Record<string, unknown> => ({
    id,
    type: 'copy',
    position: { x, y: 0 },
    connectionIds: { source: conn[srcConn], sink: conn.warehouse },
    datasetIds: { source: ds[src], sink: ds[sink] },
    config: { mapping, mode },
    ...(params ? { datasetParams: { source: params } } : {}),
  });
  const edge = (from: string, to: string, branch?: string): Record<string, string> => ({
    id: `e_${from}_${to}_${branch === undefined ? 'success' : `branch_${branch}`}`,
    from,
    to,
    on: branch === undefined ? 'success' : 'branch',
    ...(branch === undefined ? {} : { branch }),
  });
  const doc = (
    description: string,
    nodes: Record<string, unknown>[],
    edges: Record<string, string>[] = [],
    extra: Partial<Doc> = {},
  ): Doc =>
    ({ params: [], outputs: [], nodes, edges, containers: [], description, ...extra }) as Doc;

  switch (key) {
    case '1':
      return doc(
        'Copy data: one messy CSV (orders_2026-09.csv) into stg_orders, every column as text. ' +
          'Overwrite mode, so staging holds exactly this file afterwards.',
        [copy('load_csv', 0, 'csv', 'stg', staging('orders_2026-09.csv'), 'overwrite', 'fs')],
      );
    case '2':
      return doc(
        'Empty stg_orders, list the landing folder, keep *.csv files, then ForEach file ' +
          '(sequential) copy it into stg_orders through ONE CSV dataset whose path is a parameter.',
        [
          copy('reset_staging', 0, 'q_empty', 'stg', same(STAGING_COLS), 'overwrite', 'warehouse'),
          {
            id: 'list',
            type: 'file_list',
            position: { x: 260, y: 0 },
            connectionId: conn.fs,
            config: { path: p.landing },
          },
          {
            id: 'files',
            type: 'filter',
            position: { x: 520, y: 0 },
            config: {
              items: '${nodes.list.output.entries}',
              predicate: "${and(equals(item.type, 'file'), endsWith(item.name, '.csv'))}",
            },
          },
          copy('load', 820, 'csv', 'stg', staging('${item.name}'), 'append', 'fs', {
            path: "${concat(nodes.list.output.path, '/', item.name)}",
          }),
        ],
        [edge('reset_staging', 'list'), edge('list', 'files'), edge('files', 'each')],
        {
          containers: [
            {
              id: 'each',
              kind: 'foreach',
              children: ['load'],
              items: '${nodes.files.output.result}',
            },
          ],
        } as Partial<Doc>,
      );
    case '3': {
      const n = '${nodes.count_rejects.output.rows[0].n}';
      return doc(
        'ELT via query-as-source: a cleaning SELECT into orders_clean, then an aggregate into ' +
          'sales_by_country, then a validation SELECT into rejects, counted by Lookup rows and ' +
          'branched on by If condition. Serial, because parallel copies into one SQLite file lock.',
        [
          copy('clean', 0, 'q_clean', 'clean', same(CLEAN_COLS), 'overwrite', 'warehouse'),
          copy('aggregate', 300, 'q_sales', 'sales', same(SALES_COLS), 'overwrite', 'warehouse'),
          copy('rejects', 600, 'q_rejects', 'rejects', same(REJECT_COLS), 'overwrite', 'warehouse'),
          {
            id: 'count_rejects',
            type: 'lookup',
            position: { x: 900, y: 0 },
            connectionId: conn.warehouse,
            datasetIds: { source: ds.q_count },
            config: {},
          },
          {
            id: 'has_rejects',
            type: 'if',
            position: { x: 1200, y: 0 },
            config: { condition: `\${greater(nodes.count_rejects.output.rows[0].n, 0)}` },
          },
          {
            id: 'note_rejects',
            type: 'set_variable',
            position: { x: 1500, y: -100 },
            config: {
              variable: 'outcome',
              value: `\${concat(string(nodes.count_rejects.output.rows[0].n), ' rows rejected')}`,
            },
          },
          {
            id: 'write_rejects_summary',
            type: 'file_write',
            position: { x: 1800, y: -100 },
            connectionId: conn.fs,
            config: {
              path: `${p.reports}/rejects-summary.txt`,
              content:
                `${P}3 Clean and aggregate\nrun: \${run.runId}\nrejected rows: ${n}\n` +
                'outcome: ${vars.outcome}\nsee the rejects table in warehouse.db for reasons\n',
            },
          },
          {
            id: 'mark_clean',
            type: 'set_variable',
            position: { x: 1500, y: 100 },
            config: { variable: 'outcome', value: 'clean' },
          },
        ],
        [
          edge('clean', 'aggregate'),
          edge('aggregate', 'rejects'),
          edge('rejects', 'count_rejects'),
          edge('count_rejects', 'has_rejects'),
          edge('has_rejects', 'note_rejects', 'true'),
          edge('note_rejects', 'write_rejects_summary'),
          edge('has_rejects', 'mark_clean', 'false'),
        ],
        {
          variables: [
            {
              name: 'outcome',
              type: 'string',
              default: 'pending',
              description: 'clean, or how many rows were rejected',
            },
          ],
        } as Partial<Doc>,
      );
    }
    case '4': {
      const call = (k: PipelineKey): Record<string, unknown> => {
        const versionId = c.head[k];
        if (versionId === undefined) throw new Error(`demo pipeline ${k} resolved before 4`);
        return { pipelineVersionId: versionId, params: {}, wait: true };
      };
      return doc(
        `Runs ${DEMO_PIPELINE_NAMES['2']} then ${DEMO_PIPELINE_NAMES['3']}, waiting for each, ` +
          'then writes a summary file.',
        [
          {
            id: 'run_ingest',
            type: 'execute_pipeline',
            position: { x: 0, y: 0 },
            config: {},
            call: call('2'),
          },
          {
            id: 'run_clean',
            type: 'execute_pipeline',
            position: { x: 300, y: 0 },
            config: {},
            call: call('3'),
          },
          {
            id: 'write_summary',
            type: 'file_write',
            position: { x: 600, y: 0 },
            connectionId: conn.fs,
            config: {
              path: `${p.reports}/nightly-summary.txt`,
              content:
                `${P}4 Nightly orchestrator\nrun: \${run.runId}\n` +
                'trigger: ${run.triggerId}\nstarted: ${run.startedAt}\n' +
                'ingest (Demo — 2) and clean (Demo — 3) both succeeded\n',
            },
          },
        ],
        [edge('run_ingest', 'run_clean'), edge('run_clean', 'write_summary')],
      );
    }
    case '5':
      return doc(
        'Fails on purpose: reads a CSV that does not exist, so monitoring shows a failed run.',
        [
          copy(
            'load_missing_file',
            0,
            'csv',
            'stg',
            staging('orders_2026-13.csv'),
            'append',
            'fs',
            { path: `${p.landing}/orders_2026-13.csv` },
          ),
        ],
      );
  }
}

/** Hourly at :17 UTC — created DISABLED; the operator turns it on. */
const HOURLY_RECURRENCE = {
  frequency: 'hour',
  interval: 1,
  schedule: { minutes: [17] },
  timeZone: 'UTC',
} as const;

function triggerBody(
  name: string,
  pipelineVersionId: string,
  scheduled: boolean,
): Omit<NewTrigger, 'ownerId'> {
  return {
    name,
    pipelineVersionId,
    params: {},
    mode: scheduled ? 'schedule' : 'manual',
    schedule: null,
    recurrence: scheduled ? HOURLY_RECURRENCE : null,
    webhook: null,
    runWindows: null,
    concurrency: { policy: 'skip_if_running' },
    enabled: !scheduled,
  } as Omit<NewTrigger, 'ownerId'>;
}

/**
 * Writes any MISSING landing file and makes sure the warehouse and its four
 * tables exist. Create-if-missing like the resources: a re-seed never rewrites a
 * file the operator edited, nor one a running demo pipeline is reading.
 */
function writeDemoFiles(p: Paths): void {
  mkdirSync(p.landing, { recursive: true });
  mkdirSync(p.reports, { recursive: true });
  for (const [name, content] of Object.entries(DEMO_LANDING_FILES)) {
    const file = join(p.landing, name);
    if (!existsSync(file)) writeFileSync(file, content, 'utf8');
  }
  const wh = new Database(p.warehouse);
  try {
    // A demo run may hold the file when the operator re-seeds. Short: this wait
    // is synchronous, so it holds the event loop.
    wh.pragma('busy_timeout = 1000');
    wh.exec(WAREHOUSE_DDL);
  } finally {
    wh.close();
  }
}

export interface SeedDemoInput {
  db: Db;
  ownerId: string;
  /** The configured demo root; this owner's demo lives in `<demoRoot>/<ownerId>`. */
  demoRoot: string;
}

/**
 * Loads the demo for one owner — idempotent, create-if-missing. Refuses with a
 * {@link ConflictError}, BEFORE writing anything, when a non-demo resource
 * already holds one of the demo's names (the operator's own resource must never
 * be mistaken for, or shadowed by, the demo's) or a demo pipeline is archived.
 *
 * The caller syncs the scheduler afterwards (the hourly trigger is disabled, but
 * a re-seed may have recreated a deleted manual trigger).
 */
export function seedDemo({ db, ownerId, demoRoot }: SeedDemoInput): DemoSeedResponse {
  mkdirSync(demoDirFor(demoRoot, ownerId), { recursive: true });
  const dir = canonicalOwnerDir(demoRoot, ownerId);
  const p: Paths = {
    dir,
    landing: join(dir, LANDING_DIR),
    reports: join(dir, REPORTS_DIR),
    warehouse: join(dir, WAREHOUSE_FILE),
  };
  const connDefs = connectionDefs(p);
  const dsDefs = datasetDefs(p);

  // ---- refuse first, before any file or row is written ----------------------
  const clash = (
    kind: string,
    existing: { name: string; resourceId: string }[],
    want: { name: string; resourceId: string }[],
  ): void => {
    for (const w of want) {
      const holder = existing.find((e) => e.name === w.name && e.resourceId !== w.resourceId);
      if (holder !== undefined) {
        throw new ConflictError(
          `a ${kind} named "${w.name}" already exists and is not part of the demo — rename it, then load the demo`,
        );
      }
    }
  };
  clash(
    'connection',
    listConnections(db, ownerId),
    CONN_KEYS.map((k) => ({
      name: connDefs[k].name,
      resourceId: rid(`conn-${k}`),
    })),
  );
  clash(
    'dataset',
    listDatasets(db, ownerId),
    DS_KEYS.map((k) => ({
      name: dsDefs[k].name,
      resourceId: rid(`ds-${k}`),
    })),
  );
  clash(
    'pipeline',
    listPipelines(db, ownerId),
    PIPELINE_KEYS.map((k) => ({ name: DEMO_PIPELINE_NAMES[k], resourceId: rid(`pl-${k}`) })),
  );
  clash('trigger', listTriggers(db, { ownerId }), [
    ...PIPELINE_KEYS.map((k) => ({ name: runTriggerName(k), resourceId: rid(`trig-${k}`) })),
    { name: HOURLY_TRIGGER_NAME, resourceId: rid('trig-hourly') },
  ]);
  for (const k of PIPELINE_KEYS) {
    const existing = getPipelineByResourceId(db, ownerId, rid(`pl-${k}`));
    if (existing?.archived) {
      throw new ConflictError(
        `the demo pipeline "${existing.name}" is archived — restore it, or ${REMOVE_THEN_LOAD}`,
      );
    }
  }

  // A demo connection or dataset that is gone while the rest of the demo
  // remains cannot be quietly re-made: the datasets and the immutable pipeline
  // versions that survive still pin the OLD ids, so a recreated one would leave
  // a demo that loads "fine" and fails at run time.
  const conns = CONN_KEYS.map((k) => ({
    k,
    found: getConnectionByResourceId(db, ownerId, rid(`conn-${k}`)),
  }));
  const dss = DS_KEYS.map((k) => ({
    k,
    found: getDatasetByResourceId(db, ownerId, rid(`ds-${k}`)),
  }));
  const anyDemo =
    conns.some((c) => c.found !== null) ||
    dss.some((d) => d.found !== null) ||
    PIPELINE_KEYS.some((k) => getPipelineByResourceId(db, ownerId, rid(`pl-${k}`)) !== null);
  if (anyDemo) {
    const gone = [
      ...conns.filter((c) => c.found === null).map((c) => connDefs[c.k].name),
      ...dss.filter((d) => d.found === null).map((d) => dsDefs[d.k].name),
    ][0];
    if (gone !== undefined) {
      throw new ConflictError(
        `the demo is partly removed ("${gone}" is gone) — ${REMOVE_THEN_LOAD}`,
      );
    }
  }
  // Loaded before under another demo root (or re-pointed by hand): the reused
  // connections would read and write a directory this seed is not writing.
  for (const { found } of conns) {
    const roots = (found?.config as { roots?: unknown } | undefined)?.roots;
    if (found !== null && JSON.stringify(roots) !== JSON.stringify([dir])) {
      throw new ConflictError(
        `the demo connection "${found.name}" is not rooted at this server's demo directory — ${REMOVE_THEN_LOAD}`,
      );
    }
  }

  // ---- create what is missing, in one transaction ----------------------------
  const result = db.transaction(() => {
    let created = 0;
    let reused = 0;
    const ensure = <T extends { id: string }>(found: T | null, make: () => T): T => {
      if (found !== null) {
        reused += 1;
        return found;
      }
      created += 1;
      return make();
    };

    const conn = {} as Record<ConnKey, string>;
    for (const k of CONN_KEYS) {
      const resourceId = rid(`conn-${k}`);
      conn[k] = ensure(getConnectionByResourceId(db, ownerId, resourceId), () =>
        createConnection(db, { ...connDefs[k], ownerId }, { resourceId }),
      ).id;
    }

    const ds = {} as Record<DsKey, string>;
    for (const k of DS_KEYS) {
      const resourceId = rid(`ds-${k}`);
      const { connection, ...def } = dsDefs[k];
      ds[k] = ensure(getDatasetByResourceId(db, ownerId, resourceId), () =>
        createDataset(db, { ...def, connectionId: conn[connection], ownerId }, { resourceId }),
      ).id;
    }

    const ctx: DocContext = { p, conn, ds, head: {} };
    const pipelines: DemoSeedPipeline[] = [];
    for (const k of PIPELINE_KEYS) {
      const resourceId = rid(`pl-${k}`);
      const pipeline = ensure(getPipelineByResourceId(db, ownerId, resourceId), () =>
        createPipeline(
          db,
          { ownerId, name: DEMO_PIPELINE_NAMES[k], folder: DEMO_FOLDER },
          { resourceId },
        ),
      );
      // A demo pipeline whose versions were all removed out from under it gets
      // one again; one with a head keeps it, edited or not.
      let head = getHeadVersionRef(db, pipeline.id)?.id;
      if (head === undefined) {
        created += 1;
        head = createPipelineVersion(db, { ...pipelineDoc(k, ctx), pipelineId: pipeline.id }).id;
      }
      ctx.head[k] = head;

      const triggerRid = rid(`trig-${k}`);
      const trigger = ensure(getTriggerByResourceId(db, ownerId, triggerRid), () =>
        createTrigger(
          db,
          { ...triggerBody(runTriggerName(k), head, false), ownerId },
          { resourceId: triggerRid },
        ),
      );
      pipelines.push({
        key: k,
        name: pipeline.name,
        pipelineId: pipeline.id,
        versionId: head,
        triggerId: trigger.id,
      });
    }

    const orchestrator = ctx.head['4'];
    if (orchestrator === undefined) throw new Error('demo pipeline 4 has no version');
    const hourlyRid = rid('trig-hourly');
    const hourly = ensure(getTriggerByResourceId(db, ownerId, hourlyRid), () =>
      createTrigger(
        db,
        {
          ...triggerBody(HOURLY_TRIGGER_NAME, orchestrator, true),
          ownerId,
        },
        { resourceId: hourlyRid },
      ),
    );

    return { demoDir: dir, created, reused, pipelines, scheduleTriggerId: hourly.id };
  });
  // Files AFTER the commit: a seed the save gate rolls back leaves nothing on
  // disk, and a file write that fails here heals on the next seed (every file
  // is create-if-missing, every row is reused).
  writeDemoFiles(p);
  return result;
}

/**
 * Every entry the demo makes in its directory: the two folders and the
 * warehouse with the journal files SQLite may leave beside it.
 */
const DEMO_MADE: readonly string[] = [
  LANDING_DIR,
  REPORTS_DIR,
  WAREHOUSE_FILE,
  ...['-journal', '-wal', '-shm'].map((suffix) => WAREHOUSE_FILE + suffix),
];

/** Every trigger the demo makes: one manual trigger per pipeline, and the hourly. */
const TRIGGER_RIDS: readonly string[] = [
  ...PIPELINE_KEYS.map((k) => rid(`trig-${k}`)),
  rid('trig-hourly'),
];

/** The demo's resources this owner holds, found by their fixed resourceIds. */
function findDemo(db: Db, ownerId: string) {
  const present = <T>(rows: (T | null)[]): T[] => rows.filter((r): r is T => r !== null);
  return {
    connections: present(
      CONN_KEYS.map((k) => getConnectionByResourceId(db, ownerId, rid(`conn-${k}`))),
    ),
    datasets: present(DS_KEYS.map((k) => getDatasetByResourceId(db, ownerId, rid(`ds-${k}`)))),
    // Archived ones included: an archived demo pipeline is what makes a load
    // refuse, so Remove must be able to see and take it.
    pipelines: present(
      PIPELINE_KEYS.map((k) => getPipelineByResourceId(db, ownerId, rid(`pl-${k}`))),
    ),
    triggers: present(TRIGGER_RIDS.map((r) => getTriggerByResourceId(db, ownerId, r))),
  };
}

/**
 * `GET /api/demo` — whether ANY demo resource exists for this owner. True for a
 * part-removed or archived demo too, which a load refuses; that is the case
 * the web must offer Remove for.
 */
export function demoStatus(db: Db, ownerId: string): DemoStatus {
  const found = findDemo(db, ownerId);
  return {
    loaded:
      found.connections.length +
        found.datasets.length +
        found.pipelines.length +
        found.triggers.length >
      0,
  };
}

/**
 * Removes the demo for one owner: its pipelines WITH their run history (every
 * version, debug versions included), its triggers, datasets and connections,
 * then its files. Only resources carrying one of the demo's fixed resourceIds
 * are touched — matched exactly, never by prefix, because a git import can
 * bring in a resourceId of the operator's choosing.
 *
 * DELETING RUNS. Runs are audit history and a pipeline that has them cannot be
 * deleted (`PipelineHasRunsError`); debug runs were the one sanctioned
 * deletion. This is the second, and it is narrow: an operator-initiated,
 * confirmed act that #1481 asked for ("delete everything tagged demo"), over
 * runs of the demo's own sample pipelines only. See `docs/settled-decisions.md`.
 *
 * Refuses with a {@link ConflictError}, deleting nothing, when
 *  - a demo run has not finished: deleting it would pull the rows out from
 *    under the driver writing them; or
 *  - one of the operator's OWN pipelines calls a demo pipeline, or one of
 *    their own triggers is bound to one: the cascade would delete that trigger
 *    or leave that call dangling, and Remove must never touch their work.
 * A pipeline of theirs that merely uses a demo connection is handled as
 * `DELETE /api/connections/:id` handles it: its enabled triggers are switched
 * off ({@link regateTriggersForConnection}) rather than left to fail.
 *
 * The caller syncs the scheduler afterwards, as `DELETE /api/pipelines/:id`
 * does (#1485): the cascades took triggers whose schedule rows are now stale.
 */
export function removeDemo({ db, ownerId, demoRoot }: SeedDemoInput): DemoRemoveResponse {
  const result = db.transaction((tx) => {
    const found = findDemo(tx, ownerId);
    const demoPipelines = new Set(found.pipelines.map((p) => p.id));
    const demoTriggers = new Set(found.triggers.map((t) => t.id));
    for (const p of found.pipelines) {
      const deps = pipelineDependents(tx, ownerId, p.id);
      const caller = deps.callers.find((c) => !demoPipelines.has(c.pipelineId));
      if (caller !== undefined) {
        throw new ConflictError(
          `your pipeline "${caller.pipelineName}" calls the demo pipeline "${p.name}" — change it, then remove the demo`,
        );
      }
      const trigger = deps.triggers.find((t) => !demoTriggers.has(t.id));
      if (trigger !== undefined) {
        throw new ConflictError(
          `your trigger "${trigger.name}" runs the demo pipeline "${p.name}" — delete or re-bind it, then remove the demo`,
        );
      }
    }

    const versionIds =
      demoPipelines.size === 0
        ? []
        : tx
            .select({ id: pipelineVersions.id })
            .from(pipelineVersions)
            .where(inArray(pipelineVersions.pipelineId, [...demoPipelines]))
            .all()
            .map((v) => v.id);
    const runRows =
      versionIds.length === 0
        ? []
        : tx
            .select({ status: runs.status })
            .from(runs)
            .where(inArray(runs.pipelineVersionId, versionIds))
            .all();
    if (runRows.some((r) => !TERMINAL_RUN_ROW_STATUS.has(r.status))) {
      throw new ConflictError(
        'a demo run has not finished (it is queued, running or waiting) — let it finish or cancel it, then remove the demo',
      );
    }

    // `pruneDebugVersions`' shape: the runs (their events, diagnostics and
    // waits cascade), then the pipelines, which cascade their versions and
    // the triggers bound to them. The demo's runs are few — its hourly
    // schedule is created disabled — so one transaction stays small.
    if (versionIds.length > 0)
      tx.delete(runs).where(inArray(runs.pipelineVersionId, versionIds)).run();
    for (const id of demoPipelines) deletePipeline(tx, id);
    // A demo trigger re-bound to another pipeline's version did not cascade.
    for (const id of demoTriggers) deleteTrigger(tx, id);
    for (const d of found.datasets) deleteDataset(tx, d.id);
    for (const c of found.connections) {
      // The connection route's order: the row, then the re-gate scan, which
      // reads it as gone. Demo connections carry no secret.
      deleteConnection(tx, c.id);
      regateTriggersForConnection(tx, c.id);
    }
    return {
      runsRemoved: runRows.length,
      removed:
        found.connections.length + found.datasets.length + demoPipelines.size + demoTriggers.size,
    };
  });

  // Files AFTER the commit, so a rolled-back remove leaves the demo whole. A
  // file delete that fails here reaches the caller, and Remove can simply be
  // repeated: with no rows left it only retries the files. Only what the demo
  // makes is deleted — never the directory wholesale — so a demo root pointed
  // at a populated folder loses nothing of the operator's.
  if (existsSync(demoDirFor(demoRoot, ownerId))) {
    const dir = canonicalOwnerDir(demoRoot, ownerId);
    for (const made of DEMO_MADE) rmSync(join(dir, made), { recursive: true, force: true });
    try {
      rmdirSync(dir);
    } catch (err) {
      // Something that is not the demo's is still in there: leave it be.
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
    }
  }
  return result;
}
