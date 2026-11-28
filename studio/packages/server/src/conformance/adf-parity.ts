import { allCellIds } from './cell-ids.js';

/**
 * #1574 OR39 — the ADF parity table: each Azure Data Factory pipeline activity
 * and its properties, as Microsoft Learn documents them, against studio.
 *
 * `studio/docs/adf-parity.md` is RENDERED from this file and never edited by
 * hand. `adf-parity.test.ts` fails when the doc is stale, when a supported row
 * names no proof, and when a named cell or suite does not exist. To regenerate:
 *
 *   UPDATE_ADF_PARITY=1 pnpm -C studio/packages/server exec vitest run src/conformance/__tests__/adf-parity.test.ts
 */

export type ParityStatus = 'supported' | 'different' | 'not yet';

export interface ParityRow {
  /** The ADF property, as `typeProperties` (or the activity) names it. */
  readonly property: string;
  readonly status: ParityStatus;
  /** What studio calls it, where it has it. */
  readonly studio?: string;
  /** Why it differs, or what is missing. Required for `different` and `not yet`. */
  readonly note?: string;
  /** Matrix cell ids that prove the row (`cell-ids.ts`). */
  readonly cells?: readonly string[];
  /** Other suites that prove it, as paths from `studio/docs/`. */
  readonly tests?: readonly string[];
}

export interface ParityActivity {
  /** The ADF activity, as Microsoft Learn titles it. */
  readonly adf: string;
  /** The studio activity, or none. */
  readonly studio: string | null;
  readonly rows: readonly ParityRow[];
}

const SERVER = '../packages/server/src';
const ENGINE = '../packages/shared/src/engine/__tests__';

export const ADF_PARITY: readonly ParityActivity[] = [
  {
    adf: 'Copy',
    studio: 'Copy data (copy)',
    rows: [
      {
        property: 'source (delimited text, Excel, JSON, Parquet files)',
        status: 'supported',
        studio: 'Source dataset on a File system connection',
        cells: [
          'copy/fs:delimited→sqlite:table',
          'copy/fs:excel→postgres:table',
          'copy/fs:json→fs:parquet',
          'copy/fs:jsonl→sqlite:table',
          'copy/fs:parquet→fs:delimited',
        ],
      },
      {
        property: 'source (database table, query)',
        status: 'supported',
        studio: 'Source dataset on a SQLite or PostgreSQL connection',
        cells: [
          'copy/sqlite:table→postgres:table',
          'copy/sqlite:query→fs:json',
          'copy/postgres:table→sqlite:table',
          'copy/postgres:query→fs:delimited',
        ],
      },
      {
        property: 'sink (delimited text, JSON, Parquet files; database table)',
        status: 'supported',
        studio: 'Sink dataset',
        cells: [
          'copy/postgres:table→fs:delimited',
          'copy/sqlite:table→fs:jsonl',
          'copy/fs:delimited→fs:parquet',
          'copy/fs:excel→sqlite:table',
          'copy/fs:delimited→postgres:table',
        ],
      },
      {
        property: 'Excel: a source only',
        status: 'supported',
        studio: 'Excel datasets read; no Excel sink, as in ADF',
        cells: ['copy/fs:excel→sqlite:table', 'copy/fs:excel→fs:delimited'],
      },
      {
        property: 'source: an empty JSON file',
        status: 'different',
        note: 'Studio names JSON columns from the first record, so a file with no records is refused, saying why. ADF copies nothing.',
        cells: ['copy/fs:json→sqlite:table', 'copy/fs:jsonl→fs:delimited'],
      },
      {
        property: 'translator (mapping and type conversion)',
        status: 'supported',
        studio: 'Mapping, with a declared type per column',
        cells: ['copy/fs:delimited→postgres:table', 'copy/fs:excel→fs:json'],
      },
      {
        property: 'type conversion from SQLite booleans and dates',
        status: 'different',
        note: 'SQLite has no boolean or date type. Studio converts the text true/false, never a bare 0/1, and a text date only with a dataset date format, which a table dataset has no field for.',
        cells: ['copy/sqlite:table→postgres:table'],
      },
      {
        property: 'sink writeBehavior: insert',
        status: 'supported',
        studio: 'Write behaviour: Append',
        cells: ['copy/fs:delimited→sqlite:table', 'copy/sqlite:table→postgres:table'],
      },
      {
        property: 'sink: replace the data (truncate, or a pre-copy delete)',
        status: 'supported',
        studio: 'Write behaviour: Overwrite',
        cells: ['copy/postgres:table→sqlite:table', 'copy/sqlite:table→fs:delimited'],
      },
      {
        property: 'file sink: append to an existing file',
        status: 'different',
        note: 'Append writes a new file and refuses to replace one; Overwrite replaces it.',
        cells: ['copy/sqlite:table→fs:delimited'],
      },
      {
        property: 'sink writeBehavior: upsert',
        status: 'supported',
        studio: 'Write behaviour: Upsert, with key columns',
        tests: [`${SERVER}/connectors/__tests__/sqlite-sink-upsert.test.ts`],
      },
      {
        property: 'sink tableOption: autoCreate',
        status: 'supported',
        studio: 'Table option: Auto create',
        tests: [`${SERVER}/connectors/__tests__/sqlite-sink-auto-create.test.ts`],
      },
      {
        property: 'sink preCopyScript',
        status: 'supported',
        studio: 'Pre-copy script',
        tests: [`${SERVER}/connectors/__tests__/sqlite-sink-pre-copy.test.ts`],
      },
      {
        property: 'enableSkipIncompatibleRow',
        status: 'supported',
        studio: 'Skip incompatible rows',
        cells: ['copy/fs:delimited→sqlite:table', 'copy/postgres:table→fs:json'],
      },
      {
        property: 'redirectIncompatibleRowSettings',
        status: 'not yet',
        note: 'Skipped rows are counted, not written to a side file.',
      },
      {
        property: 'logSettings',
        status: 'supported',
        studio: 'Logging, to the run or to a folder on a log connection',
        cells: ['fs/log:copy'],
      },
      {
        property: 'parallelCopies, source partitionOption',
        status: 'supported',
        studio: 'Degree of copy parallelism, Partition option: Dynamic range',
        tests: [`${SERVER}/connectors/__tests__/postgres-partitions.test.ts`],
      },
      {
        property: 'incremental load (watermark pattern)',
        status: 'supported',
        studio: 'Load: Incremental, with a watermark column',
        tests: [`${SERVER}/connectors/__tests__/postgres-incremental.test.ts`],
      },
      {
        property: 'parallel runs into one store',
        status: 'supported',
        studio: 'Copies in a parallel ForEach',
        cells: [
          'copy/parallel→sqlite:table',
          'copy/parallel→postgres:table',
          'copy/parallel→fs:delimited',
        ],
      },
      {
        property: 'dataIntegrationUnits, enableStaging, preserve',
        status: 'not yet',
        note: 'Studio runs on one machine and has no staging store or ACL copy.',
      },
    ],
  },
  {
    adf: 'Copy (binary files)',
    studio: 'Copy data, Files as-is (copy_files)',
    rows: [
      {
        property: 'source and sink file paths, wildcard, recursive',
        status: 'supported',
        studio: 'Source path, Wildcard, Recursive, Sink folder',
        cells: ['fs/activity:copy_files', 'fs/sink:copy_files', 'dynamic/copy_files.wildcard'],
      },
      {
        property: 'deleteFilesAfterCompletion',
        status: 'supported',
        studio: 'After copy: Delete or Move',
        cells: ['dynamic/copy_files.afterCopy'],
      },
      {
        property: 'logSettings',
        status: 'supported',
        studio: 'Logging to a folder on a log connection',
        cells: ['fs/log:copy_files'],
      },
    ],
  },
  {
    adf: 'Lookup',
    studio: 'Lookup (lookup)',
    rows: [
      {
        property: 'source dataset (file, table, query)',
        status: 'supported',
        cells: ['fs/activity:lookup', 'sqlite/activity:lookup', 'postgres/activity:lookup'],
      },
      {
        property: 'firstRowOnly',
        status: 'supported',
        studio: 'First row only',
        tests: [`${SERVER}/connectors/__tests__/lookup-activity.test.ts`],
      },
    ],
  },
  {
    adf: 'Get Metadata',
    studio: 'Get metadata (get_metadata)',
    rows: [
      {
        property: 'dataset, fieldList',
        status: 'supported',
        studio: 'Path or dataset, Field list',
        cells: [
          'fs/activity:get_metadata',
          'sqlite/activity:get_metadata',
          'postgres/activity:get_metadata',
        ],
      },
      {
        property: 'storeSettings: modifiedDatetimeStart, modifiedDatetimeEnd',
        status: 'supported',
        studio: 'Modified start, Modified end',
        cells: ['dynamic/get_metadata.modifiedStart', 'dynamic/get_metadata.modifiedEnd'],
      },
    ],
  },
  {
    adf: 'Validation',
    studio: 'Get metadata, Wait until',
    rows: [
      {
        property: 'dataset, timeout, sleep, minimumSize, childItems',
        status: 'different',
        note: 'Studio folds Validation into Get metadata: Wait until, Check every, Give up after.',
        cells: ['dynamic/get_metadata.waitUntil'],
        tests: [`${SERVER}/connectors/__tests__/fs-metadata-wait-until.test.ts`],
      },
    ],
  },
  {
    adf: 'Delete',
    studio: 'Delete (delete)',
    rows: [
      {
        property: 'dataset, recursive, wildcard',
        status: 'supported',
        studio: 'Path type, Path, Wildcard, Recursive',
        cells: ['fs/activity:delete', 'dynamic/delete.wildcard'],
      },
      {
        property: 'enableLogging, logStorageSettings',
        status: 'supported',
        studio: 'Logging, to the run or to a folder',
        cells: ['dynamic/delete.logTo', 'dynamic/delete.logFolder'],
      },
      {
        property: 'maxConcurrentConnections',
        status: 'supported',
        studio: 'Max concurrent connections',
        tests: [`${SERVER}/connectors/__tests__/fs-delete.test.ts`],
      },
    ],
  },
  {
    adf: 'Script',
    studio: 'Script (script)',
    rows: [
      {
        property: 'scripts: type (Query, NonQuery), text, parameters',
        status: 'supported',
        studio: 'Blocks: Type, SQL, Parameters',
        cells: ['sqlite/activity:script', 'postgres/activity:script'],
      },
      {
        property: 'scriptBlockExecutionTimeout',
        status: 'supported',
        studio: 'Block timeout',
        tests: [`${SERVER}/connectors/__tests__/script-activity.test.ts`],
      },
      {
        property: 'logSettings (ActivityOutput, ExternalStore)',
        status: 'different',
        note: 'Studio captures result sets and messages into the output; it has no external log store for Script.',
        cells: ['dynamic/script.captureResultSets'],
      },
    ],
  },
  {
    adf: 'Stored Procedure',
    studio: null,
    rows: [
      {
        property: 'storedProcedureName, storedProcedureParameters',
        status: 'not yet',
        note: 'Use Script with a CALL statement.',
      },
    ],
  },
  {
    adf: 'Web',
    studio: 'Web (web)',
    rows: [
      {
        property: 'url, method, headers, body',
        status: 'supported',
        studio: 'URL, Method, Headers, Body',
        cells: ['http/activity:web', 'dynamic/web.url', 'dynamic/web.method', 'dynamic/web.body'],
      },
      {
        property: 'authentication',
        status: 'different',
        note: 'Studio sends credentials as secret headers or the connection secret, not ADF auth types.',
        tests: [`${SERVER}/connectors/__tests__/http-web.test.ts`],
      },
      {
        property: 'httpRequestTimeout',
        status: 'supported',
        studio: 'Request timeout',
        tests: [`${SERVER}/connectors/__tests__/http-web.test.ts`],
      },
      {
        property: 'callback (Webhook-style wait on Web)',
        status: 'supported',
        studio: 'Wait for callback',
        tests: [`${SERVER}/run/__tests__/web-wait-for-callback.test.ts`],
      },
    ],
  },
  {
    adf: 'Webhook',
    studio: 'Webhook (webhook)',
    rows: [
      {
        property: 'timeout, callBackUri',
        status: 'supported',
        studio: 'Timeout; the run gives a callback URL',
        cells: ['control/webhook'],
      },
    ],
  },
  {
    adf: 'Wait',
    studio: 'Wait (wait)',
    rows: [
      {
        property: 'waitTimeInSeconds',
        status: 'supported',
        studio: 'Seconds',
        cells: ['control/wait'],
      },
    ],
  },
  {
    adf: 'Set Variable',
    studio: 'Set variable (set_variable)',
    rows: [
      { property: 'variableName, value', status: 'supported', cells: ['control/set-variable'] },
      {
        property: 'setSystemVariable (pipeline return value)',
        status: 'supported',
        studio: 'Operation: Return',
        tests: [`${ENGINE}/pipeline-return-value.test.ts`],
      },
    ],
  },
  {
    adf: 'Append Variable',
    studio: 'Append variable (append_variable)',
    rows: [
      { property: 'variableName, value', status: 'supported', cells: ['control/append-variable'] },
    ],
  },
  {
    adf: 'If Condition',
    studio: 'If condition (if)',
    rows: [
      {
        property: 'expression, ifTrueActivities, ifFalseActivities',
        status: 'different',
        note: 'Branches are edges from the If node, not nested activity lists.',
        cells: ['control/if-true', 'control/if-false', 'control/foreach>if'],
      },
    ],
  },
  {
    adf: 'Switch',
    studio: 'Switch (switch)',
    rows: [
      {
        property: 'on, cases, defaultActivities',
        status: 'different',
        note: 'Cases are branch edges; the default case is the default branch.',
        cells: ['control/switch', 'control/switch-default', 'control/until>switch'],
      },
    ],
  },
  {
    adf: 'ForEach',
    studio: 'ForEach (foreach container)',
    rows: [
      { property: 'items, activities', status: 'supported', cells: ['control/foreach-sequential'] },
      {
        property: 'isSequential, batchCount',
        status: 'different',
        note: 'One field: Batch count. Absent or 1 is sequential.',
        cells: ['control/foreach-parallel', 'control/foreach-parallel>execute-pipeline'],
      },
    ],
  },
  {
    adf: 'Until',
    studio: 'Until (loop container)',
    rows: [
      {
        property: 'expression, activities',
        status: 'supported',
        studio: 'Exit when',
        cells: ['control/until', 'control/until>switch'],
      },
      {
        property: 'timeout',
        status: 'supported',
        studio: 'Timeout',
        tests: [`${SERVER}/scheduler/__tests__/container-timeout-alarm.test.ts`],
      },
    ],
  },
  {
    adf: 'Filter',
    studio: 'Filter (filter)',
    rows: [
      {
        property: 'items, condition',
        status: 'supported',
        studio: 'Items, Predicate',
        cells: ['control/filter'],
      },
    ],
  },
  {
    adf: 'Execute Pipeline',
    studio: 'Execute pipeline (execute_pipeline)',
    rows: [
      {
        property: 'pipeline, parameters',
        status: 'different',
        note: 'Studio calls a pinned pipeline version, not the latest pipeline by name.',
        cells: ['control/execute-pipeline-wait', 'control/if>execute-pipeline>foreach'],
      },
      {
        property: 'waitOnCompletion',
        status: 'supported',
        studio: 'Wait on completion',
        cells: ['control/execute-pipeline-wait', 'control/execute-pipeline-no-wait'],
      },
    ],
  },
  {
    adf: 'Fail',
    studio: 'Fail (fail)',
    rows: [
      { property: 'message', status: 'supported', cells: ['control/fail', 'control/foreach>fail'] },
      { property: 'errorCode', status: 'not yet', note: 'Studio fails with a message only.' },
    ],
  },
  {
    adf: 'Activity policy and dependencies (every activity)',
    studio: 'General tab, edges',
    rows: [
      {
        property: 'policy.retry, retryIntervalInSeconds',
        status: 'supported',
        studio: 'Retry, Retry interval',
        cells: ['control/retry'],
      },
      {
        property: 'policy.timeout',
        status: 'supported',
        studio: 'Timeout',
        cells: ['control/timeout'],
      },
      {
        property: 'policy.secureInput, secureOutput',
        status: 'supported',
        studio: 'Secure input, Secure output',
        tests: [`${SERVER}/run/__tests__/secure-redaction.test.ts`],
      },
      {
        property: 'dependsOn: Succeeded, Failed, Completed, Skipped',
        status: 'supported',
        studio: 'Edges: success, failure, completion, skipped',
        cells: ['control/skip-propagation'],
      },
      {
        property: 'state: Inactive, onInactiveMarkAs',
        status: 'supported',
        studio: 'Deactivate, Mark as',
        cells: ['control/inactive'],
      },
      {
        property: 'userProperties',
        status: 'supported',
        studio: 'User properties',
        tests: [`${ENGINE}/user-properties-c0d.test.ts`],
      },
      {
        property: 'dynamic content (@{...}) in activity settings',
        status: 'different',
        note: 'Studio writes ${...}. Text and choice fields take it today; typed fields and a few rule-bound ones stay literal.',
        cells: [
          'dynamic/http_request.url',
          'dynamic/copy.mode',
          'dynamic/copy_files.load',
          'dynamic/llm_call.outputMode',
        ],
      },
    ],
  },
  {
    adf: 'Data Flow, Power Query',
    studio: null,
    rows: [
      {
        property: 'dataflow',
        status: 'not yet',
        note: 'Studio transforms with SQL (Script, a query source) instead.',
      },
    ],
  },
  {
    adf: 'Azure Function, Custom, Databricks, HDInsight, Synapse, Machine Learning, U-SQL',
    studio: null,
    rows: [
      {
        property: 'linked compute',
        status: 'not yet',
        note: 'These run on Azure services. Studio runs local commands through an agent CLI connection.',
      },
    ],
  },
];

const STATUS_TEXT: Record<ParityStatus, string> = {
  supported: 'Supported',
  different: 'Different',
  'not yet': 'Not yet',
};

const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** Render the doc. Pure: the same table always renders the same text. */
export function renderAdfParity(): string {
  const files = allCellIds();
  const proof = (row: ParityRow): string => {
    const links = [
      ...(row.cells ?? []).map((id) => `[\`${id}\`](${files.get(id) ?? 'MISSING'})`),
      ...(row.tests ?? []).map((path) => `[${path.split('/').pop()}](${path})`),
    ];
    return links.join('<br>');
  };
  const lines = [
    '# ADF parity',
    '',
    '<!-- Generated from packages/server/src/conformance/adf-parity.ts. Do not edit by hand. -->',
    '',
    'Each Azure Data Factory pipeline activity, with its properties as Microsoft Learn documents them, against studio.',
    'A supported row links to the conformance matrix cells, or the suites, that prove it. CI runs them all.',
    '',
    'To regenerate after changing the table:',
    '',
    '```sh',
    'UPDATE_ADF_PARITY=1 pnpm -C studio/packages/server exec vitest run src/conformance/__tests__/adf-parity.test.ts',
    '```',
    '',
  ];
  for (const activity of ADF_PARITY) {
    lines.push(`## ${activity.adf}`, '');
    lines.push(`Studio: ${activity.studio ?? 'none'}.`, '');
    lines.push(
      '| ADF property | Status | Studio | Note | Proved by |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const row of activity.rows) {
      lines.push(
        `| ${cell(row.property)} | ${STATUS_TEXT[row.status]} | ${cell(row.studio ?? '')} | ${cell(row.note ?? '')} | ${proof(row)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
