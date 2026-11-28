# ADF parity

<!-- Generated from packages/server/src/conformance/adf-parity.ts. Do not edit by hand. -->

Each Azure Data Factory pipeline activity, with its properties as Microsoft Learn documents them, against studio.
A supported row links to the conformance matrix cells, or the suites, that prove it. CI runs them all.

To regenerate after changing the table:

```sh
UPDATE_ADF_PARITY=1 pnpm -C studio/packages/server exec vitest run src/conformance/__tests__/adf-parity.test.ts
```

## Copy

Studio: Copy data (copy).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| source (delimited text, Excel, JSON, Parquet files) | Supported | Source dataset on a File system connection |  | [`copy/fs:delimited→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:excel→postgres:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:json→fs:parquet`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:jsonl→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:parquet→fs:delimited`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| source (database table, query) | Supported | Source dataset on a SQLite or PostgreSQL connection |  | [`copy/sqlite:table→postgres:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/sqlite:query→fs:json`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/postgres:table→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/postgres:query→fs:delimited`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| sink (delimited text, JSON, Parquet files; database table) | Supported | Sink dataset |  | [`copy/postgres:table→fs:delimited`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/sqlite:table→fs:jsonl`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:delimited→fs:parquet`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:excel→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:delimited→postgres:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| Excel: a source only | Supported | Excel datasets read; no Excel sink, as in ADF |  | [`copy/fs:excel→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:excel→fs:delimited`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| source: an empty JSON file | Different |  | Studio names JSON columns from the first record, so a file with no records is refused, saying why. ADF copies nothing. | [`copy/fs:json→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:jsonl→fs:delimited`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| translator (mapping and type conversion) | Supported | Mapping, with a declared type per column |  | [`copy/fs:delimited→postgres:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/fs:excel→fs:json`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| type conversion from SQLite booleans and dates | Different |  | SQLite has no boolean or date type. Studio converts the text true/false, never a bare 0/1, and a text date only with a dataset date format, which a table dataset has no field for. | [`copy/sqlite:table→postgres:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| sink writeBehavior: insert | Supported | Write behaviour: Append |  | [`copy/fs:delimited→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/sqlite:table→postgres:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| sink: replace the data (truncate, or a pre-copy delete) | Supported | Write behaviour: Overwrite |  | [`copy/postgres:table→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/sqlite:table→fs:delimited`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| file sink: append to an existing file | Different |  | Append writes a new file and refuses to replace one; Overwrite replaces it. | [`copy/sqlite:table→fs:delimited`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| sink writeBehavior: upsert | Supported | Write behaviour: Upsert, with key columns |  | [sqlite-sink-upsert.test.ts](../packages/server/src/connectors/__tests__/sqlite-sink-upsert.test.ts) |
| sink tableOption: autoCreate | Supported | Table option: Auto create |  | [sqlite-sink-auto-create.test.ts](../packages/server/src/connectors/__tests__/sqlite-sink-auto-create.test.ts) |
| sink preCopyScript | Supported | Pre-copy script |  | [sqlite-sink-pre-copy.test.ts](../packages/server/src/connectors/__tests__/sqlite-sink-pre-copy.test.ts) |
| enableSkipIncompatibleRow | Supported | Skip incompatible rows |  | [`copy/fs:delimited→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/postgres:table→fs:json`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| redirectIncompatibleRowSettings | Not yet |  | Skipped rows are counted, not written to a side file. |  |
| logSettings | Supported | Logging, to the run or to a folder on a log connection |  | [`fs/log:copy`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts) |
| parallelCopies, source partitionOption | Supported | Degree of copy parallelism, Partition option: Dynamic range |  | [postgres-partitions.test.ts](../packages/server/src/connectors/__tests__/postgres-partitions.test.ts) |
| incremental load (watermark pattern) | Supported | Load: Incremental, with a watermark column |  | [postgres-incremental.test.ts](../packages/server/src/connectors/__tests__/postgres-incremental.test.ts) |
| parallel runs into one store | Supported | Copies in a parallel ForEach |  | [`copy/parallel→sqlite:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/parallel→postgres:table`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts)<br>[`copy/parallel→fs:delimited`](../packages/server/src/conformance/__tests__/copy-matrix.test.ts) |
| dataIntegrationUnits, enableStaging, preserve | Not yet |  | Studio runs on one machine and has no staging store or ACL copy. |  |

## Copy (binary files)

Studio: Copy data, Files as-is (copy_files).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| source and sink file paths, wildcard, recursive | Supported | Source path, Wildcard, Recursive, Sink folder |  | [`fs/activity:copy_files`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`fs/sink:copy_files`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`dynamic/copy_files.wildcard`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts) |
| deleteFilesAfterCompletion | Supported | After copy: Delete or Move |  | [`dynamic/copy_files.afterCopy`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts) |
| logSettings | Supported | Logging to a folder on a log connection |  | [`fs/log:copy_files`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts) |

## Lookup

Studio: Lookup (lookup).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| source dataset (file, table, query) | Supported |  |  | [`fs/activity:lookup`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`sqlite/activity:lookup`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`postgres/activity:lookup`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts) |
| firstRowOnly | Supported | First row only |  | [lookup-activity.test.ts](../packages/server/src/connectors/__tests__/lookup-activity.test.ts) |

## Get Metadata

Studio: Get metadata (get_metadata).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| dataset, fieldList | Supported | Path or dataset, Field list |  | [`fs/activity:get_metadata`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`sqlite/activity:get_metadata`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`postgres/activity:get_metadata`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts) |
| storeSettings: modifiedDatetimeStart, modifiedDatetimeEnd | Supported | Modified start, Modified end |  | [`dynamic/get_metadata.modifiedStart`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts)<br>[`dynamic/get_metadata.modifiedEnd`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts) |

## Validation

Studio: Get metadata, Wait until.

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| dataset, timeout, sleep, minimumSize, childItems | Different |  | Studio folds Validation into Get metadata: Wait until, Check every, Give up after. | [`dynamic/get_metadata.waitUntil`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts)<br>[fs-metadata-wait-until.test.ts](../packages/server/src/connectors/__tests__/fs-metadata-wait-until.test.ts) |

## Delete

Studio: Delete (delete).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| dataset, recursive, wildcard | Supported | Path type, Path, Wildcard, Recursive |  | [`fs/activity:delete`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`dynamic/delete.wildcard`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts) |
| enableLogging, logStorageSettings | Supported | Logging, to the run or to a folder |  | [`dynamic/delete.logTo`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts)<br>[`dynamic/delete.logFolder`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts) |
| maxConcurrentConnections | Supported | Max concurrent connections |  | [fs-delete.test.ts](../packages/server/src/connectors/__tests__/fs-delete.test.ts) |

## Script

Studio: Script (script).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| scripts: type (Query, NonQuery), text, parameters | Supported | Blocks: Type, SQL, Parameters |  | [`sqlite/activity:script`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`postgres/activity:script`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts) |
| scriptBlockExecutionTimeout | Supported | Block timeout |  | [script-activity.test.ts](../packages/server/src/connectors/__tests__/script-activity.test.ts) |
| logSettings (ActivityOutput, ExternalStore) | Different |  | Studio captures result sets and messages into the output; it has no external log store for Script. | [`dynamic/script.captureResultSets`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts) |

## Stored Procedure

Studio: none.

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| storedProcedureName, storedProcedureParameters | Not yet |  | Use Script with a CALL statement. |  |

## Web

Studio: Web (web).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| url, method, headers, body | Supported | URL, Method, Headers, Body |  | [`http/activity:web`](../packages/server/src/conformance/__tests__/connector-matrix.test.ts)<br>[`dynamic/web.url`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts)<br>[`dynamic/web.method`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts)<br>[`dynamic/web.body`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts) |
| authentication | Different |  | Studio sends credentials as secret headers or the connection secret, not ADF auth types. | [http-web.test.ts](../packages/server/src/connectors/__tests__/http-web.test.ts) |
| httpRequestTimeout | Supported | Request timeout |  | [http-web.test.ts](../packages/server/src/connectors/__tests__/http-web.test.ts) |
| callback (Webhook-style wait on Web) | Supported | Wait for callback |  | [web-wait-for-callback.test.ts](../packages/server/src/run/__tests__/web-wait-for-callback.test.ts) |

## Webhook

Studio: Webhook (webhook).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| timeout, callBackUri | Supported | Timeout; the run gives a callback URL |  | [`control/webhook`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |

## Wait

Studio: Wait (wait).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| waitTimeInSeconds | Supported | Seconds |  | [`control/wait`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |

## Set Variable

Studio: Set variable (set_variable).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| variableName, value | Supported |  |  | [`control/set-variable`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| setSystemVariable (pipeline return value) | Supported | Operation: Return |  | [pipeline-return-value.test.ts](../packages/shared/src/engine/__tests__/pipeline-return-value.test.ts) |

## Append Variable

Studio: Append variable (append_variable).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| variableName, value | Supported |  |  | [`control/append-variable`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |

## If Condition

Studio: If condition (if).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| expression, ifTrueActivities, ifFalseActivities | Different |  | Branches are edges from the If node, not nested activity lists. | [`control/if-true`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/if-false`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/foreach>if`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |

## Switch

Studio: Switch (switch).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| on, cases, defaultActivities | Different |  | Cases are branch edges; the default case is the default branch. | [`control/switch`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/switch-default`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/until>switch`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |

## ForEach

Studio: ForEach (foreach container).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| items, activities | Supported |  |  | [`control/foreach-sequential`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| isSequential, batchCount | Different |  | One field: Batch count. Absent or 1 is sequential. | [`control/foreach-parallel`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/foreach-parallel>execute-pipeline`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |

## Until

Studio: Until (loop container).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| expression, activities | Supported | Exit when |  | [`control/until`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/until>switch`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| timeout | Supported | Timeout |  | [container-timeout-alarm.test.ts](../packages/server/src/scheduler/__tests__/container-timeout-alarm.test.ts) |

## Filter

Studio: Filter (filter).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| items, condition | Supported | Items, Predicate |  | [`control/filter`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |

## Execute Pipeline

Studio: Execute pipeline (execute_pipeline).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| pipeline, parameters | Different |  | Studio calls a pinned pipeline version, not the latest pipeline by name. | [`control/execute-pipeline-wait`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/if>execute-pipeline>foreach`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| waitOnCompletion | Supported | Wait on completion |  | [`control/execute-pipeline-wait`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/execute-pipeline-no-wait`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |

## Fail

Studio: Fail (fail).

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| message | Supported |  |  | [`control/fail`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts)<br>[`control/foreach>fail`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| errorCode | Not yet |  | Studio fails with a message only. |  |

## Activity policy and dependencies (every activity)

Studio: General tab, edges.

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| policy.retry, retryIntervalInSeconds | Supported | Retry, Retry interval |  | [`control/retry`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| policy.timeout | Supported | Timeout |  | [`control/timeout`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| policy.secureInput, secureOutput | Supported | Secure input, Secure output |  | [secure-redaction.test.ts](../packages/server/src/run/__tests__/secure-redaction.test.ts) |
| dependsOn: Succeeded, Failed, Completed, Skipped | Supported | Edges: success, failure, completion, skipped |  | [`control/skip-propagation`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| state: Inactive, onInactiveMarkAs | Supported | Deactivate, Mark as |  | [`control/inactive`](../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts) |
| userProperties | Supported | User properties |  | [user-properties-c0d.test.ts](../packages/shared/src/engine/__tests__/user-properties-c0d.test.ts) |
| dynamic content (@{...}) in activity settings | Different |  | Studio writes ${...}. Text and choice fields take it today; typed fields and a few rule-bound ones stay literal. | [`dynamic/http_request.url`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts)<br>[`dynamic/copy.mode`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts)<br>[`dynamic/copy_files.load`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts)<br>[`dynamic/llm_call.outputMode`](../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts) |

## Data Flow, Power Query

Studio: none.

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| dataflow | Not yet |  | Studio transforms with SQL (Script, a query source) instead. |  |

## Azure Function, Custom, Databricks, HDInsight, Synapse, Machine Learning, U-SQL

Studio: none.

| ADF property | Status | Studio | Note | Proved by |
| --- | --- | --- | --- | --- |
| linked compute | Not yet |  | These run on Azure services. Studio runs local commands through an agent CLI connection. |  |
