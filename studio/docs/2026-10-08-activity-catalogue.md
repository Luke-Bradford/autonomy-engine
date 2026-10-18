# Activity catalogue: a short palette, complete properties (2026-10-08)

**Status:** spec. This is the design the loop builds against. The operator approves it, and changes to it go through a PR.
**Asked for by the operator (2026-10-08):**
> "we dont need a copy and copy file. The copy should accommodate the various ways of copying something, in properties, selections, toggles. Make the high level activity picking simple and general, with the detail in each step to configure all eventualities, logging properly etc."

**Reference:** Azure Data Factory (Microsoft Learn), with Fabric Data Factory where it is simpler. Each section cites the Learn page it follows. Studio differs from ADF only where this doc says so.

**Measured baseline:** origin/main `f016cd28`. The palette has 20 catalog activities plus 3 containers. File work alone is six activities (read, write, copy, move, delete, list), and copying rows is a seventh (Copy Data). There is no Script, no Get metadata, no Validation and no row upsert. Node `description`, user properties and activity state do not exist. `policy.timeoutSeconds` is stored but never enforced (enforced since C0a). The HTTP response body is uncapped, and a 4xx or 5xx response still *succeeds*.

---

## 1. Rules

1. **The palette names the verb; properties carry the how.** An activity is *what* happens (copy, look up, delete, call, branch). Where the data is comes from a **connection** (and an object on it, or a saved dataset). How it happens is a **toggle or selection** on the activity. A new variation is a new option, never a new palette item.
2. **Every activity has the same General tab** (§3). Name, description, state, timeout, retry and secure flags look and behave the same on every activity.
3. **What a connection cannot do is shown, not hidden.** Pickers and options are driven by the capability matrix (§6). An option the chosen connection does not support is disabled with the reason ("SQLite cannot be a file sink"), never silently missing.
4. **Every field is a literal or `${}`** wherever ADF allows dynamic content (UI STANDARD rule 4). Fields that must stay literal say so in their `?`.
5. **Every activity logs the same way** (§5). Its run record holds the resolved input, the outputs, typed metrics, and the error with its cause. File-moving activities can also write a session log. The secure flags redact all of it.
6. **Config over decisions.** Each toggle has a default, can be overridden per activity, and where it makes sense per workspace. Nothing in this doc is an operator question at build time.
7. **Old pipelines keep running.** Every retired activity type has a lowering into its replacement, and old output names stay readable as aliases (§8).

---

## 2. The palette: 23 items become 18

| Group | Activity | Replaces / new | ADF equivalent |
|---|---|---|---|
| **Move & transform** | **Copy** | Copy Data, Copy File, Move File, Write File | Copy (+ Binary copy, delete-after) |
| **General** | **Lookup** | Lookup Rows, Read File | Lookup |
| | **Get metadata** | List Directory; **new**: exists, size, modified, structure; plus "wait until" (= ADF Validation) | Get Metadata + Validation |
| | **Delete** | Delete File (+ folders, wildcards, date filters, log) | Delete |
| | **Script** | **new**: SQL query and non-query blocks, parameters, stored procedures | Script (+ Stored Procedure) |
| | **Web** | HTTP Request, Webhook (as "wait for callback") | Web + Webhook |
| | **Execute pipeline** | unchanged; binding from OR34 #1483 | Execute Pipeline |
| | **Set variable** | Set variable, Append variable (+ pipeline return value) | Set Variable + Append Variable |
| | **Wait** | unchanged | Wait |
| | **Fail** | + error code | Fail |
| **Iteration & conditionals** | **ForEach** | unchanged (container) | ForEach |
| | **Until** | unchanged (container) | Until |
| | **If condition** | unchanged | If Condition |
| | **Switch** | unchanged | Switch |
| | **Filter** | unchanged | Filter |
| | **Stage** | unchanged (studio grouping container) | — |
| **AI** | **LLM call** | unchanged | — |
| | **Agent task** | unchanged | — |

Retired from the palette: Copy Data, Copy File, Move File, Write File, Read File, List Directory, Delete File, Lookup Rows, HTTP Request, Webhook and Append variable (11). Added: Copy, Lookup, Get metadata, Delete, Web and Script (6). Titles are sentence case (OR40 #1594 S4).

**Still to come:** Transform (OR16 #1407, joins Move & transform); new connectors (OR13 #1404, OR15 #1406); new formats (OR14 #1405); code scripts (OR12 #1403), which become a *Language* selector on Script (SQL · Python · Node · shell). Each slots into the matrix (§6) or into an existing activity's properties, never as a new palette item.

---

## 3. Common to every activity: the General tab

Sources: [pipelines and activities](https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities), [deactivate an activity](https://learn.microsoft.com/azure/data-factory/deactivate-activity), [user properties](https://learn.microsoft.com/azure/data-factory/concepts-annotations-user-properties).

| Field | Control | Default | Notes |
|---|---|---|---|
| Name | text | type + ordinal | Max 55 characters, unique in the pipeline (ADF rule) |
| Description | text, 2 lines | — | **New** on `Node`. Shown on hover on the canvas and in the monitor |
| Activity state | Active / Inactive | Active | **New**. Not a General field (#1694 OR42, operator 2026-10-14: an activity's state is toggled only when you want to deactivate it). Switched with *Deactivate* / *Activate* from the canvas's right-click menu, the dock's `⋯` and the multi-selection panel, as ADF's right-click *Deactivate*; *Mark as* shows on General only while inactive. An inactive node is greyed and skipped by validation. It records an *Inactive* run and **Mark as** Succeeded / Failed / Skipped (default Succeeded) drives its outgoing edges |
| Timeout | duration (`D.HH:MM:SS` or seconds) | 12 h (workspace setting) | **Enforce it** (done in C0a; it was stored but unenforced, F3). Expiry fails the attempt with `timeout`, which can be retried |
| Retry | number | 0 | As today; retries only transient failures |
| Retry interval | seconds | 30 | As today |
| Secure input / Secure output | two checkboxes on one line | off | As today, and also covering every new record in §5 |
| User properties | table: name · value (ƒx) | — | **New**, up to 5. Shown as columns in the activity-runs grid, as ADF does. Copy offers *Auto-generate* (source and sink names) |

Containers (ForEach, Until, Stage) get Name, Description, State and their own settings, but no retry or secure flags (as today).

**Built (C0a, 2026-10-12):** the timeout is enforced per attempt on execution activities, entered in seconds, with no default. It is refused at save on activities that cannot honour it. Details are in the framework spec's F3 built-block.

**Built (C0b, 2026-10-12):** an activity's Description. `Node.description` is optional free text that is never evaluated, and absent rather than `''` when cleared. It is bounded on write at the pipeline description's 4,000 characters, which the canvas mirrors as a save badge. It is edited as a two-line field in the General tab's *Basics* section, above *Run policy*. A `${}` in it is prose, so the cross-pipeline paste guard does not count it as a read. On the canvas and the run graph it follows the card's name in the tooltip and is the name's accessible description. The run drawer shows the bound version's text. It counts toward the content hash because it is authored content. No `CATALOG_VERSION` bump, because the field is inert at dispatch (the ledger in `schemas/version.ts`). Still open in C0: the 12 h workspace default, the `D.HH:MM:SS` input, a container's Description (the container panel's draft-and-Apply form), Activity state with *Mark as*, and User properties.

**Built (C0c, 2026-10-12):** Activity state with *Mark as*, on activities (placement amended by #1694 OR42; see *Editor* below). `Node.state` is `'inactive'` or absent (never `'active'`, so an active doc is byte-identical to a pre-C0c one), and `Node.onInactiveMarkAs` is `success`, `failure` or `skipped`, absent meaning `success`.
- **Deliberate difference from ADF:** the stored values are the engine's terminal words, not ADF's `Succeeded`/`Failed`/`Skipped`, so the recorded outcome *is* the node's status. The form shows ADF's words.
- **Run:** when the walk reaches an inactive node, of any type, the reducer emits `inactivateNode` and the driver appends a `node.inactive{markAs}` placeholder. Nothing runs: no adapter, control evaluation or child. The fold sets the status to `markAs` with `inactive: true`, and the edges then evaluate as for any node that ended that way. A Failed mark fails the run unless a failure or completion edge handles it, exactly as a real failure would. It never retries, records no outputs and no error, and leaves no skip reason of its own. Boot recovery re-emits `inactivateNode` for a `ready` inactive node, never `dispatchNode`.
- **Downstream reads** of an inactive node's outputs still validate against its declared contract, and fail at the reader's dispatch, ADF's documented limitation; `default()` rescues them. The editor's Problems panel **warns** about them (#1669): a read that saves (the producer dominates the reader) of a node that is inactive *and marked Succeeded*, outside `default()`'s first argument. Marked Failed or Skipped, the dependent reader is skipped and never reads, so there is nothing to warn about. It also warns, once per node, about an inactive `if`/`switch` with branch edges, none of which fires. Warnings come from the shared validator's `advisories` sink, which only the editor passes. They are listed under their own count and never refuse Save, Debug or the server's write gate, because the doc runs correctly once the activity is re-activated.
- **Validation:** `validateDoc`'s per-node rules (the #1480 run-ability check included), `validateRefs`, the variable guard, the call-depth walk, the debug-callee refusal, the editor's Apply schema check and trigger connection readiness all skip an inactive node. Structure (ids, edges, containers, cycles), the parse-level `StrictNodeSchema` rules and the output contract still apply. The connection and dataset dependents lists keep it, because re-activating it needs them. Its `${}` reads are not counted (`globals.*` included), so a global deleted while it is off is refused at the save that re-activates it, the same point any new read of it would be.
- **Editor:** amended by #1694 OR42 (operator, 2026-10-14), which overrides ADF's placement. There is no *Activity state* field. The canvas's right-click menu offers *Deactivate* over the selection (every selected activity, as one undo step, #1680), or *Activate* once every selected activity is off. The dock's `⋯` has *Deactivate node* / *Activate node*, and the multi-selection panel has *Deactivate selection* / *Activate selection*. *Mark as* sits in the General tab's *Basics* and shows only while the activity is inactive. Re-activating keeps the stored mark (ADF keeps it). The code view still shows it, and the next Deactivate resumes it. The card is greyed (dashed border, faded face) and leads with an `inactive · <outcome>` badge.
- **Commit model (#1694 OR42 item 7, a default under CONFIG OVER DECISIONS):** General writes straight to the node, as before. The config tabs keep an explicit **Apply**, because it runs the `configSchema` pre-check and lands as one undo step. Applying on every valid change would put half-typed configs into the store and an undo entry per keystroke, and the JSON view needs a commit anyway. The two models are now visibly different. *Apply*, *Revert* and the JSON toggle show only on a tab that holds the draft, never on General. An unapplied edit on another tab shows as that tab's pending mark. The header's draft acts are compact, with the JSON toggle and Revert as icons and Apply as a short `Apply` named "Apply config", so the name keeps the row.
- **Monitor:** the activity-runs row carries `inactive` (and, for a Failed mark, an error saying it is inactive and marked as Failed, which the run's failure banner shows), and every status surface (grid, drawer, run graph, editor overlay) says `inactive · <outcome>` in the skipped grey. The activity-runs status filter has its own **Inactive** choice, as ADF's grid does (#1669); an inactive row is found there, not under Failed or Skipped, whatever it was marked as. A rerun-from-failed that copies an inactive node marked Succeeded keeps it inactive: `run.reseeded` carries `copiedInactive` (the frontier nodes the pinned version has inactive), so the rerun's graph, drawer and reused row say `inactive · succeeded`, and inactive takes precedence over the `reused` pill. A copied container's inactive children still read as plain reused, because a copied container carries no per-child state (the same limit the drawer's fold already states).
- `CATALOG_VERSION` 33→34: a pre-C0c build would strip `state` and run the node for real.

**Built (C0d, 2026-10-12):** User properties, on execution activities. `Node.userProperties` is up to five `{name, value}` rows, absent rather than `[]` when there are none. Bounds are on write only: a name is non-empty, at most 100 characters and unique in the activity; a value is at most 2,000 characters.
- **Resolved at dispatch, never failing the run:** the reducer resolves each value with the same `substitute` and scope as `config` (`${item}` in a ForEach body), and the executor records the result on `node.dispatched.userProperties`. A non-string result is written as an embedded `${}` would be. An empty list is treated as none. **Deliberate difference from a `config` expression:** a property that fails to resolve records its `error` instead of failing the run, because it is monitoring metadata and must not change what the run does. Values and errors are cut at 2,000 characters with `truncated`. A retry is its own dispatch, so each attempt records its own values. Recorded whatever an `llm_call`'s capture level, because the author chose each one to be shown.
- **Secure:** on either secure flag, every value and error is replaced by the marker at append time, as `input` and `params` are; names stay.
- **Validation:** each value is scanned like any other `${}` the node holds: refs and types are checked, secret refs and reads of a secure output are refused, and variable reads count toward the guard. The issue names the row by its zero-based index (`nodes.<id>.userProperties[1].value` from the ref check, `userProperties[1].name` from the bounds). They are **refused on a control activity and on a pipeline call**, which never reach the executor and so would never record them. An inactive node skips both checks, as every per-node rule does. The paste guard counts a read in one, because it is evaluated, unlike a description.
- **Editor:** a *User properties* section at the end of the General tab. **Deliberate difference from §4.1**, which gives Copy its own *User properties* tab: one place for every activity that records them, until the Copy slices add Copy's tab with *Auto-generate*. The section has a name (short) and value (with the ƒx picker) per row, Add stopping at five. It is shown on execution activities, and on any other node that already holds some, so the save's refusal names config the author can see and remove. Bound and duplicate refusals are badges routed to the General tab.
- **Monitor:** the activity runs grid adds one column per distinct name across the run's rows, after the fixed columns, in first-seen order. A cell shows the value, `Not resolved: <error>` in the error colour, or the secure marker. Group and iteration lines are padded. The grid's search matches what those cells say. An attempt that failed before dispatch (a missing connection, a secret that would not resolve, a cancel during preflight) and a row a rerun reused have no `node.dispatched` of their own, so their cells are empty.
- No `CATALOG_VERSION` bump (the ledger in `schemas/version.ts`).
- **Not built yet:** user properties on control activities, pipeline calls and containers, and on attempts that fail before dispatch (each needs a record other than `node.dispatched`), tracked in #1673; Copy's own tab and *Auto-generate*, which belong with the Copy slices.

**Built (C0e, 2026-10-13):** a container's Description and State. `Container.description`, `Container.state` and `Container.onInactiveMarkAs` mean what they mean on a node, are absent when default, and are edited on a new **General** tab that leads the container panel. They are written through like an activity's, not via the config tabs' draft-and-Apply. The description is bounded at save by `StrictContainerSchema`.
- **Run:** an inactive container never enters. No `items` or `exitWhen` is read, no alarm is armed and nothing inside it runs. The walk records its Mark as with `inactive: true` and no outputs, and its children stay `pending`, as a skipped container's do. This is pure in the reducer (no event), because the outcome is a function of the pinned doc. Marked Failed, its reason is `inactive`, and an unhandled one fails the run. A rerun-from-failed that copies it keeps the mark only if the pinned version has it inactive.
- **Validation:** the run-only rules (a loop's `exitWhen` and body, a ForEach's `items` and body, and their `${}` scans) are left out, so it can stand in for an unfinished loop. Its shape rules still apply. Every site that leaves an inactive node out (per-node rules, refs, the variable guard, the call-depth and cycle walk, the debug-callee refusal, the editor's Apply schema check, trigger connection readiness) also leaves out each child of an inactive container, through `switchedOffNodeIds`. The call walk reads a callee's containers too. The Problems panel's #1669 warning covers a read of an inactive container marked Succeeded (a ForEach's `results`), which records no outputs.
- **Editor and monitor:** the panel's General tab is the activity's (*Mark as* only while inactive, #1694 OR42), with the `?` help in container wording. A container is switched by the panel's *Deactivate container* / *Activate container*, beside *Copy* and *Duplicate*. Right-clicking a box opens the canvas menu, as before. The canvas box is greyed and its label says `inactive · <outcome>`, with the description as its tooltip. The run graph, the activity-runs group row (`inactive`) and the failure banner say the same. The body has no rows and is left out of the runs list's Activities counts. The status filter's *Inactive* choice matches rows, not group lines, so it does not find the container itself.
- `CATALOG_VERSION` 34→35, because a pre-C0e build would strip `state` and run the body.

Still open in C0 after C0e: the 12 h workspace default, the `D.HH:MM:SS` input, the canvas's multi-select *Deactivate* (built by #1694 OR42), and user properties on activities that do not reach the executor.

**Built (C0f, 2026-10-13):** the 12 h workspace default timeout, done as ADF does it: the default is **written into a new activity**, not applied at run time.

- **Where it lives:** a new owner-scoped `workspace_settings` table (migration 0047, one row per owner, keyed by `owner_id`) behind `GET/PUT /api/workspace/settings`. It is the first workspace setting, so later ones (alert targets, retention) add columns here. A workspace that never saved reads `DEFAULT_WORKSPACE_SETTINGS` (`defaultActivityTimeoutSeconds: 43200`) with `stored: false`. `null` turns the default off. The PUT takes the node policy's one-year write ceiling.
- **How it applies:** the canvas reads the setting beside the doc and re-reads it on focus. `addNode` (the toolbox, by click or drop) writes it into a new execution activity's `policy.timeoutSeconds`, only where `timeoutApplies`. A duplicate or paste copies its source's policy, and a starter template inserts the policy it was authored with. Until the read answers, or if it fails, a new activity gets no timeout, as before C0f. The canvas still opens, because the read is not load-bearing.
- **Why not a run-time default:** applying it at dispatch would put a 12 h limit on every existing activity on upgrade, against §8's rule that a new default never changes a running pipeline's result. It would also be invisible in the JSON (UI standard rule 3). Written into the doc, the value shows in the dock and the code view, and the author can change or clear it. An activity saved with no timeout still runs with none, so there is no reducer, event or `CATALOG_VERSION` change.
- **Deliberate differences from ADF** ([activity policy](https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities#activity-policy): "Default time-out is 12 hours, minimum 10 minutes"). ADF applies 12 h when the JSON omits `timeout`; studio reads an omitted timeout as none, so a pre-C0f doc keeps its behaviour (§8), and writes the default into new activities instead. Studio has no 10-minute minimum: a short budget is a legitimate test of a slow endpoint, and the one-year ceiling already catches a typo.
- **Settings page:** a *Run defaults* section with *Activity timeout (seconds)*, saved when the field is left. Blank turns the default off.
- **Not built (deliberate):** the setting does not sync to git or travel in an export, because it is workspace configuration rather than a resource. Changing it never rewrites existing activities. An author who wants no timeout on one activity clears its Timeout field, as before.

Still open in C0: the `D.HH:MM:SS` input (polish, #1680; its multi-select *Deactivate* half was built by #1694 OR42), and user properties on activities that do not reach the executor (#1673).

---

## 4. Each activity

Tabs follow ADF. ⓕ marks fields that accept `${}`.

### 4.1 Copy

Sources: [copy activity](https://learn.microsoft.com/azure/data-factory/copy-activity-overview), [schema and type mapping](https://learn.microsoft.com/azure/data-factory/copy-activity-schema-and-type-mapping), [fault tolerance](https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance), [session log](https://learn.microsoft.com/azure/data-factory/copy-activity-log), [binary format](https://learn.microsoft.com/azure/data-factory/format-binary), [incremental copy](https://learn.microsoft.com/azure/data-factory/tutorial-incremental-copy-overview).

**Tabs:** General · Source · Sink · Mapping (rows only) · Settings · User properties.

Three toggles decide the shape: *Copy mode* first on **General** (#1694 OR42 item 8), the other two at the top of **Source**. Everything below them follows from these three:

| Toggle | Options | Default | Effect |
|---|---|---|---|
| **Copy** | **Rows** (read, map and convert) · **Files as-is** (bytes, no parsing) | Rows | Files as-is hides Mapping and the format options, and shows the copy-behaviour options. The ADF equivalent is a Binary dataset. Built (C1a) as two catalog types, `copy` and `copy_files`, under one palette item; the dock labels the toggle *Copy mode* and shows it first on General, as an activity-level choice (#1694 OR42 item 8), because a bare *Copy* label would be a substring of *After copy* and *Copy behaviour* on the same panel |
| **Load** | **Full** · **Incremental** | Full | Incremental adds a watermark (below) |
| **After copy** | **Keep source** · **Delete source** · **Move source to…** (folder ⓕ) | Keep | Delete or Move = the old Move File. Files only, applied per file after it is written (non-atomic, as in ADF). Under *If file exists* = Skip, a target that already holds exactly its source's bytes is reported skipped and its source is still removed, so a retry finishes a source an earlier attempt copied but did not remove (not for Merge, which has no one source to compare); a Move an earlier attempt linked but did not finish is finished in every mode (#1685) |

**Built (#1686, 2026-10-14):** the dock draws only the Files as-is fields that apply. A catalog entry's `appliesWhen` names, per field, the control values under which it applies: *Wildcard* and *Include subfolders* need Folder, *File list path* needs File list, *Move to* needs Move source to, and *File name* needs File or Merge. It is a view rule only: the schema's cross-field checks still refuse a field set where it cannot apply, a control holding a `${}` draws its fields, and a field holding a value is drawn wherever it sits, so nothing in the JSON is unreachable from the form (UI standard rule 3).

**Source**, by what the chosen connection is:

| Source is | Fields |
|---|---|
| Any | **Connection** `[▾ grouped by type]` then *Test*, *Edit*, *＋ New* as icon buttons with tooltips (#1694 OR42; gallery and test-before-create, per #1477), **or** *Use saved dataset* `[▾]` with its parameters ⓕ |
| Database (SQLite, Postgres, later OR15) | **Use** Saved dataset · Table · Query. Table: schema and table, literal `[▾ from the connection]` (built in C1q-c as *List tables*), and *Preview data* under either (built in C1q-c for the inline form; a saved dataset's is OR10 #1401's). Query: the SQL statement, literal, with ⤢, and a `:name` bind values table (Name · Type · Value, *Import from statement*, built in C1q-c) whose values take ⓕ (which also covers a stored procedure call). Query timeout (built in C1q-c; a new inline Query starts at 2 h, one stored without it has none) |
| Files (fs, later S3/Blob/SFTP OR13) | **Path type** File · Folder + wildcard · File list. Path ⓕ. Wildcard `*.csv` ⓕ. *Include subfolders* (default on). *Modified between* start ⓕ / end ⓕ (UTC; start inclusive, end exclusive). In Rows mode only: **Format** `[Delimited ▾]` plus its options inline (delimiter, header, encoding, quote, escape, null value, skip lines, sheet for Excel), which are the dataset's options without creating a dataset |
| Inline | **Content** ⓕ, either rows as a JSON array or text. This replaces Write File, e.g. writing an expression's value to a file |
| Any (rows) | **Additional columns** table: name · value, where value is `$$FILEPATH`, `$$COLUMN:<src>`, a literal or ⓕ (ADF `additionalColumns`) |

**Built (C1q-a, #1600):** an inline Table or Query is `Node.inlineDatasets.source`, a node-level field beside `datasetIds` (whose `source` became optional so a Copy can bind a saved sink beside it). It dispatches as the same resolved dataset a saved one becomes, so every reader runs unchanged. The SQL text, table and schema stay literal by construction: the reducer resolves `${}` only in the parameter **values**, and save refuses a `${` in the SQL, so a value can never become SQL and a name never comes from an expression (§8). At dispatch the node's source connection must be a store the kind can live in (sqlite or postgres). A Lookup's first row is read as `${nodes.<lookup>.output.firstRow.<column>}` (C7a; `rows[0]` still works); studio has no `activity('Name')` function, so the ticket's ADF spelling does not apply.

**Built (C1q-b, #1600):** the Source tab's *Use* Saved dataset · Table · Query edits `Node.inlineDatasets.source` for Copy and Lookup, writing through on each keystroke with one undo step per field. It shows when the source connection is a store an inline kind can live in, or when an inline source is already stored; a stored one under a connection that cannot hold it says so. The fields, titles and `?` notes come from the `table` and `query` dataset schemas, so the inline form and the saved dataset form cannot drift. This row's original ⓕ on the table and the SQL editor contradicted §8's literal rule, so they are literal here: only a bind value takes ⓕ, and the statement's ⤢ editor has no reference flyout. The issue list counts every inline-source problem on the Source tab. Left to **C1q-c**, and all built there (below): Table `[▾ from the connection]`, *Preview*, *Query timeout*, bind-value rows derived from the statement's `:name`s, and a type for a new literal bind value.

**Built (C1q-c Preview, #1600):** *Preview data* on the Source tab, under an inline Table or Query, answered by `POST /api/datasets/preview`. It is not a second reader: the server dispatches the source store's own `lookup` arm on a synthetic context, so Preview shows what the run would read, through the same read-only reader (sqlite opened read-only, postgres inside `BEGIN READ ONLY`), its row and byte caps and its JSON-safe values, and keeps the first 100 rows. It applies the run's checks (store kind, secret marker, config, shared with the executor as `resolveInlineSource`) and save's literal-SQL rule, so it never shows rows for a source that would be refused. A bind value written as `${}` has no value until a run resolves it, so Preview asks for one in its place (*Preview value for :name*), as ADF asks for parameter values before a preview; a value that reads back as the same number binds as a number, as a resolved `${}` keeps its type. The connection is read as saved: a node's `connectionParams` are not applied, and the form says so. Its concurrency has Test connection's shape in a pool of its own (a slot is held until the real read ends; the caller is answered at 60s). The request is a union on `source.from` so OR10 #1401's saved-dataset preview joins as a second variant.

**Built (C1q-c table list, #1600):** Table `[▾ from the connection]` is a *List tables* button under the Schema and Table boxes, answered by `POST /api/datasets/tables`. It lists on request, as *List sheets* does, never per keystroke, and the boxes stay, so a name the list does not hold can still be typed. Choosing a table writes its schema and name together as one undo step; a list belongs to the connection it was read for and is dropped when that changes. The listing is Preview's read, not a second one: the store's catalogue query runs as an inline Query through the same Lookup arm, gate, caps, pool and backstop. sqlite lists the main database's tables and views from `sqlite_master` without sqlite's own `sqlite_` tables (an FTS or R-tree index's shadow tables are listed; sqlite reads them). postgres reads `pg_class`, as the sink's own catalogue reads do, not `information_schema`, which omits materialized views and lists relations the role cannot SELECT: tables, partitioned tables without their partitions, views, materialized views and foreign tables the role can SELECT, outside the `pg_` and `information_schema` schemas. A list over Lookup's row or byte cap says it is a prefix.

**Built (C1q-c query timeout, #1600):** *Query timeout* is the `query` dataset config's `queryTimeoutSeconds`, ADF's copy-source `queryTimeout` ([PostgreSQL V2 source](https://learn.microsoft.com/azure/data-factory/connector-postgresql#postgresql-as-source): "default is 120 minutes"). It is in whole seconds, the unit of the activity timeout beside it, where ADF takes a timespan. A new inline Query is written with 7200 (`NEW_QUERY_TIMEOUT_SECONDS`), and a query stored without one runs with no limit: applying 2 h at dispatch would limit pipelines that already run, which is the C0f decision's reasoning and §8's rule. The saved dataset form shows the field blank and its `?` says blank means no limit, because ADF's default belongs to the copy source, which is the inline form. Inline it is literal, as the statement is. On a saved dataset it is overridable per node like any key the dataset declares. The clock is wall time from the statement's start to its last row, so it includes the time a copy spends writing between batches, because the cursor is open for all of it. Both readers check it before pulling each batch after the first, so no pull starts past the limit (a read whose rows run out exactly at a batch boundary needs one more, empty pull, which is refused like any other). What bounds the pull in flight differs by store. postgres, in the final stretch (less time left than the connection's statement timeout), runs `SET LOCAL statement_timeout` to the time left, so the server cancels the fetch in flight at the limit, and that cancel is reported as the query timeout (measured against postgres 17, inside `BEGIN READ ONLY`). sqlite steps synchronously and cannot be interrupted, so a batch already being pulled finishes, its last batch included, and a one-batch read such as an aggregate is never cut short. The failure is `transient` with no code, the adapter-timeout convention; `FAILURE_CODES.TIMEOUT` stays the activity timeout's. **Deliberate differences from ADF:** a `table` source has no query timeout here (ADF's applies to any source read), and a stored query with no value has no limit rather than 2 h. `CATALOG_VERSION` 39.

**Built (C1q-c bind values, #1600):** the bind values table is Name · Type · Value, and C1q is complete. *Import from statement* adds a blank text row for each `:name` the statement uses that has no value yet, in statement order and as one undo step, and a status beside it lists the names still unbound (or says every one is bound, or that the statement has none, since a disabled button's hover is not shown in every browser). It is ADF's *Import parameter* (the stored procedure source's), and like *List tables* it runs on request, never per keystroke: rows that appeared as the statement was typed would churn the config (`:w`, then `:wm`). A stored row whose name the statement does not use says *Not in the statement, so it is not bound*, which is what the run does (sqlite ignores an extra value; the postgres reader drops it), and Preview no longer asks a value for one. The names come from the store's own lexical rules: the scanner the postgres reader rewrites through moved to shared (`datamove/sql-placeholders.ts`, `scanSqlPlaceholders`), so the table and the reader cannot disagree, and it gained a sqlite dialect, measured on better-sqlite3 and pinned by a test that binds through the driver: `:a`, `@a`, `$a` and `#a` all bind the key `a`, `?1` binds the key `1`, a digit may start a name, `[..]` and `` `..` `` are identifiers, block comments do not nest, and only LF ends a line comment. On postgres an array slice bound such as `[1:hi]` reads as `:hi`, as it does for the reader, so the field's `?` says so. **Type** is Text · Number · Null, one choice per member of the stored union, so every stored value shows its type and every choice stores one: Text stores the box as typed, Number stores a plain decimal (the literal a `number` pipeline parameter accepts, `NUMERIC_TEXT`) or a stored number's own text such as `1e-7`, and holds other text, or an integer past 2^53 that would be stored rounded, with a *Not saved* note while the row keeps its stored value, and Null stores `null` with no value box. A value written as `${}` is stored as text whatever the type, because a run keeps the type it resolves to, so the type shows *Expression* and is not editable while it is one. The earlier rule (a stored number stayed a number while its text read as one) is gone: with the type explicit, typing `7` into a Text row stores `"7"`.

**Incremental** (Load = Incremental) uses a watermark column: Watermark column `[▾ source columns]`, one of:
- **Watermark from** *Automatic*: studio stores the highest value the last *successful* run copied, per activity. This is the default.
- **Watermark from** *Expression*: the old watermark ⓕ, for example from a Lookup on a control table.

The run reads `col > old AND col <= new`, and outputs `watermark.old` and `watermark.new`. For files, Incremental = *Modified since last successful run* (Automatic) or the explicit *Modified between* window.

**Sink:**

| Sink is | Fields |
|---|---|
| Database | **Connection** as above. **Table** `[▾ existing]` ⓕ, or **Table option** *Auto-create from mapping*, which generates DDL with quoted identifiers and types from the mapping. **Write behaviour** Append · Overwrite (delete then insert, one transaction) · Truncate then insert · Upsert (Key columns `[▾ multi]`, default the primary key). **Pre-copy script** (SQL ⓕ, runs once). Batch size (default 1000) |
| Files | **Folder** ⓕ, **File name** ⓕ (or prefix plus *Max rows per file*, Rows mode). **Copy behaviour** Preserve hierarchy · Flatten · Merge into one file (Files as-is plus folder sources). **If file exists** Overwrite · Skip · Fail (default Overwrite). In Rows mode only: **Format** (Delimited, later JSON / Parquet OR14) with its write options |

**Mapping** (Rows mode only; the design discussed with the operator 2026-10-08):

```text
Mapping   [Import schemas] [+ New mapping] [Clear] [Reset]                       ƒx
 ✓  Source column    Type     →  Sink column        Type      If it won't convert
 ✓  order_id         string   →  [order_id     ▾]   integer   [Fail row    ▾]   ✕
 ☐  _ingest_ts       string   →  not copied
▸ Type conversion settings   allow truncation · date format · datetime format · culture
```

- **One row per pair.** Source column `[▾ from the imported schema | ƒx expression]`, then →, then Sink column `[▾ from the sink schema]`.
- **Types** are read-only from the schemas. Only the conversion rule is editable: *If it won't convert* = Fail row / Write null / Skip row (Skip row works with fault tolerance).
- **Import schemas** maps by name (auto-map exists today). An unticked row is not copied.
- **ƒx** makes the whole mapping a parameter, as ADF's parameterised translator does.
- **Default mapping:** with no rows, columns are mapped by name, case-sensitive, as in ADF. That is offered as *Map by name* (the default for a new Copy). An explicit table is optional.

**Settings:**

| Group | Fields | Default |
|---|---|---|
| Fault tolerance | *Skip incompatible rows* (Rows; not with Upsert). *Skip missing files* (on), *Skip forbidden files* (off) (files) | off / as listed |
| Data consistency | *Verify after copy*: row counts (Rows) or size + modified time (Files as-is) | off |
| Performance | Degree of parallelism (files and partitioned reads), Batch size | auto / 1000 |
| Session log | **Logging** Off · Warnings (skipped rows and files) · Everything (every file and row batch). **Mode** Best effort · Reliable. **Write to** connection + folder ⓕ, or *Run log* (kept with the run, capped). | Warnings to the run log |

**Outputs:** `rowsRead`, `rowsWritten`, `rowsSkipped`, `filesRead`, `filesWritten`, `filesSkipped`, `filesDeleted`, `filesMoved`, `bytesRead`, `bytesWritten`, `durationMs`, `throughput` (bytes/s), `watermark` {old, new}, `logPath`, `consistency` {verified, result}. Files as-is (C1a) yields the file and byte counters only, never the row outputs: a `rowsWritten` of 0 would read as "wrote nothing" in the run's rows total. A file list may be merged too, in the list's order. Files as-is also yields `source` and `dest` (C1b), the canonical source file or folder and the file written (one file or a merge) or the sink folder. They are the retired Copy file / Move file outputs, so a lowered node's refs still resolve (§8).

### 4.2 Lookup
Source: [Lookup](https://learn.microsoft.com/azure/data-factory/control-flow-lookup-activity).

- **Tabs:** General · Source · Settings.
- **Source** is the same Source block as Copy (connection or dataset, table, query or file, format, inline), plus **Read as** Rows · *Whole file as text* (= the old Read File).
- **Settings:**
  - **First row only** (default **on**, as ADF).
  - **Max rows**: default 1000, workspace ceiling, so today's cap becomes configurable.
  - **When over the limit**: Truncate and warn · Fail (default Truncate and warn, as today). *Whole file as text* has it too, defaulting to Fail (C7c below).
- **Outputs:**
  - `firstRow` (first row only), or `rows` + `count`;
  - `content` + `path` (whole-file text);
  - `truncated`, `bytes`.
- **Monitor:** `count` maps to the rows column, which is not mapped today.

**Built (C7a):** First row only, Max rows and When over the limit, on a Settings tab after Source.
- **Defaults.** The schema's defaults are today's behaviour: off, 1000, Truncate and warn. A stored `lookup` (`config: {}`) is therefore already "Lookup · not first row only" (§8), with no lowering. A new Lookup is written `firstRowOnly: true` by the catalog entry's `newNodeConfig`, so ADF's default is in the JSON.
- **Max rows** could only lower the 1000-row cap (`LOOKUP_ROW_CAP`, now in `shared`). The 1 MiB byte cap is not configurable. C7d made the row ceiling a workspace setting (below).
- **When over the limit** applies to either bound, rows or bytes. Fail fails the activity `permanent` with the truncation reason.
- **First row only** reads one row. A source with more rows is not a truncation. Its one row can still be over the byte cap, which is truncated (or fails).
- **Outputs.** All six are always present, because every declared output is required: `rows`, `rowCount`, `count`, `firstRow`, `bytes`, `truncated`. That is a deliberate departure from "firstRow, or rows + count".
  - `firstRow` is `null` when no row was kept. `truncated` tells an empty source from a first row too large to keep.
  - `rowCount` stays as the old name for `count`.
- **Stored contracts.** A node saved before C7a still declares the four old outputs in `config.outputs`, so its runs would drop `count` and `firstRow`. The editor re-seeds a node whose contract is exactly that former default when it loads it (`formerOutputs`, `refreshFormerOutputs`), and the next Save writes it. It runs on the editor's load only, for the reason C1b's lowering does (below). Any other contract is left alone.
- **Two dock changes it needed.** The tab vocabulary puts Settings after Mapping (ADF's Copy order), so a Lookup opens on its Source. The dock's remembered tab starts unset rather than Settings, so an activity opens on its first tab until the author picks one.
- **A stored config.** A stored `lookup` is now parsed at dispatch. A version that carries one of these keys with a value the schema refuses fails `permanent` where it used to ignore it. M12 offered no such key, so only a hand-written doc can hold one.
- **Not built in C7a:** the rest of C7, below.

**Built (C7b):** *Read as* Rows · Whole file as text, and the title *Lookup*.
- **Whole file as text is `file_read`.** Its shape (an `fs` connection and a `path`, giving `content` and `path`) is already that mode, so a new type would be a second dispatch arm doing the same read. `copy_files` needed a new type only because its config differs from `file_copy`'s. So the §8 row `file_read → Lookup · Whole file as text` needs no lowering: the type is unchanged, a stored version runs through the same arm, and `output.content` resolves as before. `file_read` is not a retired type and has no entry in `RETIRED_LOWERINGS`.
- **One palette item, two types,** as C1a's Copy: `LOOKUP_TYPES` = `lookup`, `file_read`; both are titled *Lookup*, `file_read` is `inPalette: false`, and both draw Lookup's glyph. `ACTIVITY_MODE_GROUPS` lists Copy's and Lookup's groups, and one store action (`setActivityMode`) and one dock control serve both.
- **Read as leads General, not Source** (where the table above puts it), for OR42 item 8's reason: it decides which tabs the activity has. The text mode's tab is *Source* (it was *Location*). C7c gave it a Settings tab.
- **Switching** starts the other mode's settings as a new node of that type has them, so text → rows writes First row only on (ADF's new-node default). The dataset binding goes; the connection and its overrides stay. One undo step.
- **A refused connection names the mode.** A sqlite connection under Whole file as text reads *Lookup (whole file as text) can't use this kind yet*, since a Lookup in Rows mode takes it.
- **The text mode reads as `file_read` always has:** up to the connection's `maxBytes` (10 MiB unless set), failing a larger file, with outputs `content` and `path`. C7c added `bytes`, `truncated` and *When over the limit*.

**Built (C7c):** *When over the limit* and `bytes`/`truncated` for *Whole file as text*.
- **Settings tab** with one field, *When over the limit*: Truncate and warn · Fail. It uses the same choice and labels as rows mode (`LOOKUP_OVER_LIMIT_OPTIONS`).
- **The limit is the connection's `maxBytes`, not the 1 MiB Lookup byte cap.** That is a deliberate departure from the C7 row as first written. A stored Read file reads up to 10 MiB today, so applying 1 MiB would fail or cut files it reads now, which §8 forbids. A hoster lowers the limit per connection.
- **The default is Fail, not Truncate.**
  - Fail is what every stored `file_read` has done (§8).
  - It is also ADF's behaviour: *"The Lookup activity output supports up to 4 MB in size, activity will fail if the size exceeds the limit"* ([Lookup](https://learn.microsoft.com/azure/data-factory/control-flow-lookup-activity)).
  - A file cut short (half a JSON document) is rarely usable, where a bounded set of rows is.
  - No `newNodeConfig` is needed, because the schema default is the new-node default.
  - Only an explicit `truncate` truncates. Anything else keeps the failing read.
- **Truncate and warn** keeps the first `maxBytes` bytes, cut back to a whole UTF-8 character (a leading BOM is kept, as a whole read keeps it). It emits `activity.warned` `lookup_truncated` with the file's size, the limit and the connection field that sets it (*Largest file read*), never content, and outputs `truncated: true`. A file that shrank under the limit after its size was read is read whole, not marked truncated.
- **Outputs** `content`, `path`, `bytes` (the UTF-8 size of `content`, what was kept, as rows mode counts it), `truncated`. All four are always present. A node saved before C7c declares `content` and `path` only: `formerOutputs` re-seeds it on the editor's load, as C7a's Lookup does. `CATALOG_VERSION` 41.

**Built (C7d):** the workspace's *Lookup max rows* and the Monitor Rows read column.

- **Lookup max rows** is a workspace setting (Settings, Run defaults; `WorkspaceSettings.lookupMaxRows`, migration 0048). It defaults to 1000, today's cap, and goes up to 5000, [ADF's Lookup limit](https://learn.microsoft.com/azure/data-factory/control-flow-lookup-activity). A node's Max rows accepts up to 5000, and a run keeps the lower of the node's Max rows and the workspace's. When the workspace value is the one that applies, the truncation warning (or the Fail error) says so.
- **It applies at run time, to existing pipelines too.** That differs from the default Timeout, which only seeds new activities. Lowering it holds existing Lookups to the new value. Raising it changes nothing until a Lookup's own Max rows (default 1000) asks for more. An unchanged workspace therefore runs exactly as before (§8). It is read when the Lookup is dispatched, as connection limits are, so a retry after a change uses the new value.
- **The durable bound does not move.** The 1 MiB byte cap stays fixed, so more rows only ever means smaller rows. ADF's 4 MB is not adopted.
- **The PUT takes the whole document.** A missing field is refused rather than written as its default (#473). The Settings page builds each save from the last document it sent, so two quick saves do not undo each other.
- **Monitor:** the catalog's `rowsReadOutputs` names the outputs that fill the activity-runs Rows read column. Lookup uses `count`, and `rowCount` for a node saved before C7a. A type that declares nothing uses `rowsRead`, so another activity's `count` is never read as rows. The column comes from the run's version doc. When that doc cannot be resolved (the log-only projection), a Lookup's Rows read stays blank, because the log does not say which activity type ran. Putting the type on events was left out, as an event-schema change.
- `CATALOG_VERSION` is 42, because a 41 build refuses Max rows above 1000.
- **Not built:** the editor gives no warning when a node's Max rows exceeds the workspace's (the help text and the run warning say it), and there is no Rows read on the canvas run overlay.

### 4.3 Get metadata
Sources: [Get Metadata](https://learn.microsoft.com/azure/data-factory/control-flow-get-metadata-activity), [Validation](https://learn.microsoft.com/azure/data-factory/control-flow-validation-activity).

- **Tabs:** General · Source · Settings.
- **Source:** connection, then a file, folder or table path ⓕ, or a saved dataset.
- **Field list** (checkbox grid):
  - Exists, Item name, Item type, Size, Created, Last modified, Content MD5 (files);
  - **Child items** (folders), with *Filter* wildcard ⓕ, *Files only / folders only / both*, *Modified between*, *Include subfolders*;
  - **Structure** and **Column count** (files with a header, and tables);
  - **Row count** (tables; a studio addition).
  - With **Exists** ticked, a missing object returns `exists:false` instead of failing (as ADF).
- **Wait until** toggle (= ADF Validation): *Wait until it exists* / *Is non-empty* / *Is at least N bytes*, *Check every* (default 10 s), *Give up after* (default 12 h). This is a durable park, the same mechanism as Wait, not a busy loop.
- **Outputs:** one per ticked field, plus `childItems[{name, type, size, lastModified}]`.

**Built (C8a, 2026-10-16):** Get metadata on a file system connection, as the new `get_metadata` type. It is in the palette as *Get metadata*, with Source (connection, *File or folder path* ⓕ) and Settings tabs.

- **Field list:** ADF's names, stored as ADF's `fieldList` array and drawn as a grid of tick boxes (a new `enumSet` config-form kind for an array of an enum). They are Exists, Item name, Item type, Size, Created, Last modified, Content MD5 and Child items. The array is written in the options' order. It takes no dynamic content, because an enum member can never be a `${}`, and a new node ticks nothing, as in ADF.
- **Child items settings:** *Filter* (wildcard ⓕ, default `*`), *Child entries* (All · Files only · Folders only) and *Modified from* / *Modified before*. The wildcard and window checks are Copy · Files as-is's, now in one module (`catalog/file-selection.ts`). They are shown only while Child items is ticked (`appliesWhen` now also reads a set of choices), and refused at save when set without it.
- **Outputs:** `path` plus one optional output per field, each `null` when unticked.
  - **Deliberate difference from ADF:** the contract is fixed, not derived from the ticks, because a derived one would go stale when they change. A reference to an unticked field therefore saves and resolves to `null`, where ADF fails it.
  - The editor's Problems panel **warns** about such a reference (#1736), through the shared validator's `advisories` sink as #1669's warnings do, so it never refuses Save, Debug or the server's write gate. It is silent as `default()`'s first argument, which takes the fallback on `null`. A read through another null-tolerant function (`coalesce`, `empty`) still warns, because it can only ever take its fallback.
- **Missing path:** with Exists ticked, a missing path (a missing parent included, `ENOENT` or `ENOTDIR`) gives `exists: false` and `null` elsewhere. Otherwise it fails as any read does.
  - That answer is never given for a path outside the roots. `confine.ts`'s `missingWithinRoots` walks up to the nearest ancestor `realpath` resolves and judges that canonical ancestor with the one containment test (`isWithinCanonicalRoots`, now shared with `resolveWithinRoots`). A dangling link on the way up is refused as well, because its target may be outside. So a link out of a root cannot turn `exists: false` into an oracle for outside folders.
  - A symlink at the path is refused even with Exists ticked, because the connector never follows one.
- **Child items:** read from a folder only, and fail on a file, so the lowered `file_list` (C8b) still fails where List directory did.
  - The list limit (`maxEntries`) counts every entry visited, matched or not, as `file_list` does.
  - Each item is `{name, type, size, lastModified}`, with `size` `null` unless a file. Its type comes from an `lstat`, not the directory entry, so a file system that does not type its entries still filters correctly. The list is sorted by name in code-unit order, because a directory read's order depends on the OS.
  - A modified window leaves folders out, as ADF's does.
- **Deliberate differences from ADF:**
  - `itemType` and a child's `type` are `file_list`'s words (`file`, `directory`, `symlink`, `other`), not `File`/`Folder`, so a `type == 'directory'` test keeps working on the lowered `file_list` (C8b).
  - Content MD5 is a studio addition (ADF offers none for a file system). It is base64, the Content-MD5 form, and reads the whole file, checking for cancel between chunks.
  - Size is `null` for a folder.
  - Created is `null` where the file system records no birth time.
  - Up to `maxEntries` child items, each with a size and a time, can make a large output (ADF caps an activity's output at 4 MB). OR36 #1567 owns capture caps.
- `CATALOG_VERSION` 42→43 (a new runnable type).

**Built (C8b, 2026-10-17):** `file_list` is lowered to Get metadata · Child items (`retired.ts`), and List directory is retired from the palette. It still runs, and the server still accepts it.
- **The lowered node:** same connection and path, `fieldList: ['childItems']`, and Get metadata's contract. The child item defaults (Filter `*`, which matches a dotfile, All entries, no window) list what List directory listed.
- **The rename is rewritten, not aliased.** Get metadata has no `entries` output, so each `${nodes.<id>.output.entries…}` in the doc is rewritten to `childItems` when the node is lowered (`renameNodeOutputRefs` in `nodeRefs.ts`). That includes another node's config, user properties and bindings, a ForEach's `items` and a loop's `exitWhen`, but not a description, which is prose. So the lowering now runs over the doc (`lowerRetiredTypes({nodes, containers})`), not node by node.
- **Faithful or not at all, as C1b.** The node stays List directory, and none of its readers changes, if any read cannot be rewritten for sure: a bare or indexed `.output`, or a string naming the node that cannot be scanned (an unterminated `${`). It also stays when it has no path or carries `connectionParams`, `connectionIds`, datasets or a call. As in C1b, the lowered node gets Get metadata's contract in `config.outputs`, replacing whatever the stored node declared.
- **The starter templates and the demo** use Get metadata · Child items.
- **Deliberate differences after the next Save,** while the stored version keeps running as `file_list`:
  - child items are sorted by name, where List directory gave the OS's order;
  - each item also has `size` and `lastModified`;
  - a child's type comes from an `lstat`, not the directory entry;
  - a child removed during the listing is skipped;
  - a child whose `lstat` fails (a folder that can be read but not searched), or whose modified time cannot be written as a date, fails the run, where List directory listed it;
  - one `lstat` per listed child, up to the list limit, so a large folder lists more slowly;
  - the other field outputs (`exists`, `itemName` and the rest) are there and `null`. A bare `${nodes.<id>.output}` would therefore read a different object, which is one reason such a read is refused;
  - error wording differs, but a file or a missing path still fails `permanent`, and the list limit counts the same.
  - A server test runs both on one folder and compares names, types, path, failures and the limit (`fs-metadata.test.ts`).
- No `CATALOG_VERSION` bump: there is no new type or field, and `get_metadata` already needs 43.

**Built (C8e, 2026-10-17):** *Include subfolders* for Child items, the config's `recursive`. It is a tick box in Settings after *Child entries*, drawn only while Child items is ticked and refused at save when set without it. It is off by default, so the C8b lowering of List directory, which never recursed, is unchanged.
- **Names:** each item is named by its path below the listed folder, `/`-separated on every host (`2026/10/c.csv`). The item shape and the output contract are unchanged, so a template's `concat(path, '/', item.name)` still builds the item's path.
- **Order:** tree order, a folder's contents straight after it (`a`, `a/x.csv`, `a-b.csv`): code-unit order with `/` sorted lowest. Copy · Files as-is orders the files it copies by plain code-unit order (`a-b.csv` before `a/x.csv`), so the two lists can differ in order.
- **What is walked and what is listed:** every subfolder is walked, whatever the Filter, *Child entries* or modified window. Those decide only what is listed. The Filter matches an entry's own name, not its path, and the modified window still lists files only, at every depth.
- **Links:** a link is listed as `symlink` and never walked into, to a folder or anywhere else.
- **Limits:** the list limit counts every entry visited across the whole tree, as Copy · Files as-is's walk does, and the failure says "the folder and its subfolders". The output can therefore hold up to the limit's items from the whole tree; OR36 #1567 owns capture caps.
- **Failures:** a subfolder that cannot be opened fails the run, as in Copy's walk. A subfolder removed during the walk is skipped. Every entry visited is `lstat`ed, matched or not, because a folder is walked whether or not it is listed: one call per entry, deliberately, since a dirent's type is not reported on every file system. So an entry whose `lstat` fails fails the run even where the Filter would have left it out. Without Include subfolders only a matched entry is `lstat`ed, as before.
- **Residual:** `opendir` has no `O_NOFOLLOW`. A subfolder is `lstat`ed again just before it is opened, so one replaced by a link while it waited to be walked is skipped. A swap in the gap between that `lstat` and the `opendir` could still be read, the residual List directory and Copy's walk already state. Here it would expose names, sizes and times, not contents.
- **Deliberate difference from ADF:** ADF's Child items lists one level and has no such setting. This is a studio addition.
- `CATALOG_VERSION` 43→44: a pre-C8e build strips `recursive` and lists the top level only.

**Built (C8c-1, 2026-10-17):** Get metadata on a SQLite or Postgres **table**.
- **Source:** on a database connection the table is the Source tab's dataset, a saved `table` dataset or an inline Table (C1q's block, Table only, since Get metadata reads no query). *File or folder path* is drawn only on a file system connection (`appliesWhen` now also takes a `connectionKind` condition) and is optional in the config.
  - **Deliberate difference from §4.3's "table path ⓕ":** a table is never named by a path or an expression, C1q's one way to name a table (§8). A table name is a literal in the dataset; its bind values are what take dynamic content.
  - The dataset is **optional on a file system only** (`datasetKinds.optionalOn: ['fs']`). The executor skips the dataset block only when the node binds none; a stray dataset is still resolved and refused. On a file system with nothing bound the editor draws no dataset picker.
- **Field list per kind** (`fieldOptionsByConnectionKind`): a path's eight on `fs`; Exists, Structure, Column count and Row count on `sqlite` and `postgres`. Every field is offered while the kind is unknown (no connection, or a `${}`), and a field already ticked is always drawn so it can be unticked.
  - **At save** (`getMetadataNodeIssue`, beside the config's own issues): a node with neither a path nor a table, so a new node still shows its next step, and one with both.
  - **At dispatch** (`getMetadataKindIssue`, one sentence per mistake for all three stores), because only then is the connection's kind known: a field the kind cannot answer, a table on `fs` (refused by the dataset's connection check), and a path on a database.
- **Outputs:** `structure` (`[{name, type}]`), `columnCount`, `rowCount`, each `null` unless ticked, in the one fixed contract. `path` is the table as the dataset writes it (`schema.table`, or the bare name). A node saved before C8c holds the nine C8a outputs; `formerOutputs` re-seeds it on load.
- **Exists:** with Exists ticked, a missing table, or a name that is an index, sequence or type rather than a table or view, gives `exists: false`; without it the run fails `permanent`. A missing SQLite file, or a SQLite schema (attached database) the store does not have, fails rather than say `false`. A Postgres schema that does not exist is a table that does not exist (`exists: false`), as `to_regclass` answers.
- **One session per run:** the columns and the count are read from one open (SQLite) or one `READ ONLY` session (Postgres), so they describe the same table.
- **SQLite:** `findSqliteRelation` (the sink's `sqlite_master` lookup, `COLLATE NOCASE`, tables and views) and `pragma_table_xinfo` without a virtual table's hidden columns, so generated columns are listed as `SELECT *` returns them, on the one read-only open every SQLite read now shares.
- **Postgres:** one catalog query (`to_regclass`, so a bare name resolves through `search_path`; `relkind` is List tables' set, now one constant, `READABLE_RELKINDS_SQL`). A table the connection's role cannot SELECT is refused (`permanent`) rather than described, as List tables leaves it out. Both statements run `READ ONLY`, because counting a view runs its query.
- **Deliberate differences from ADF:** Structure's `type` is the store's own type name (Postgres `format_type`, e.g. `character varying(20)`; SQLite's declared type, `''` where a column declares none), not ADF's interim types. Row count is a studio addition. A count above 2^53 fails `permanent` rather than report an inexact number.
- **Residuals:** Row count is `count(*)`, a full scan. On Postgres the connection's statement timeout bounds it; such a timeout is classified `permanent` today, as every Postgres read's is (#1741), and a cancel waits for it. On SQLite better-sqlite3 runs it synchronously and cannot interrupt it, so a very large table holds the server's event loop until it finishes; cancel is checked before it starts.
- `CATALOG_VERSION` 44→45.

**Built (C8c-2, 2026-10-17):** Get metadata on a **delimited or Excel dataset** on a file system connection. It gives Structure and Column count of a file, as ADF's Get Metadata does for a DelimitedText or Excel dataset.
- **Source:** on a file system, the Source tab now draws *Source dataset* as well as *File or folder path*. It lists the connection's delimited and Excel datasets, with *— none —* by default. The node reads one or the other:
  - both set is refused at save ("a dataset chosen on Source names what to read; clear File or folder path") and again at dispatch;
  - neither set is refused at save, as before.
  - `datasetKinds.source` is now `['table', 'delimited', 'excel']`. The executor's connection check still keeps a file dataset off a database and a table off a file system.
- **Fields:** a file dataset answers a file's fields (Exists, Item name, Item type, Size, Created, Last modified, Content MD5) for the dataset's own path, plus Structure and Column count. The file system now offers ten tick boxes, a path's eight and these two.
  - **At save** (`getMetadataNodeIssue`), whatever the kind:
    - a path with Structure, Column count or Row count is refused, because a path's columns come through a dataset;
    - a dataset with Child items is refused, because a dataset names one file or table, never a folder.
  - **At dispatch** (`getMetadataKindIssue`, now told whether a dataset is bound): Row count on a file dataset is refused, since it is a table's.
  - The save check is stricter than C8c-1's: a table dataset with Child items, which used to save and then always fail at dispatch, is now refused at save, so such a doc no longer imports.
  - The path's help and the Field list's help say a file's columns come through *Source dataset*.
- **One path, then one reader.** The path fields, the Exists answer and the roots' confinement are C8a's (`doGetMetadata` on the dataset's path, with parameter overrides already merged). The columns are read by the dataset's own reader, the one Copy uses to describe its source (`describeColumns` through `fs.ts`'s reader fork), so Get metadata and Copy name a file's columns the same way.
  - A path that is not a file is refused before its reader opens it ("Structure and Column count need a file").
  - With *First row as header* off, columns are named by position (`column1`…), as Copy names them. ADF requires the header for a real structure; studio gives the positional one instead.
  - A file with no rows has no header to read, and fails `permanent` with the reader's reason.
  - Exists answers for the **file**. On an Excel dataset whose sheet is missing, the run fails rather than say `false`.
- **Structure `type`** is the format's own, in lowercase, as a table's is the store's (C8c-1). For a delimited file it is `string` for every column, because the file holds text (ADF says `String`). For Excel it is `''`, because a sheet declares no column type (its cells are typed one by one), as an undeclared SQLite column is `''`. No type is inferred from the data, which would be a guess.
- **A missing folder (#1743, fixed in C8d-2a):** with Exists ticked, a dataset whose folder is missing says `exists: false`, as a missing file does. C8c-2 failed it at dispatch (`dataset_address_unresolvable`).
- **Shown together with the path field** on a file system. The author sees both inputs, and the save refusal says which to clear.
- `CATALOG_VERSION` 45→46: a pre-C8c-2 build refuses the dataset's kind at dispatch.

**Built (C8d-1, 2026-10-17):** *Wait until* on a file system **path**, on the Settings tab.

- **Fields** (ADF's Validation: https://learn.microsoft.com/azure/data-factory/control-flow-validation-activity):
  - *Wait until*: Off (the default, which reads once as before) · It exists · It is not empty · It is at least N bytes (`waitUntil`).
  - *Minimum bytes*, only with the last choice (`minimumSize`).
  - *Check every (seconds)*, default 10, ADF's `sleep` (`checkEverySeconds`).
  - *Give up after (seconds)*, default 43200 (12 h), at most 7 days, ADF's `timeout` (`giveUpAfterSeconds`).
  - Plain numbers, as Lookup's Max rows. A timer setting with Wait until off is refused, as the child-item settings are.
- **The conditions:**
  - *It exists*: a file or a folder at the path.
  - *It is not empty*: a file of at least one byte, or a folder holding any entry (unfiltered, as ADF's `childItems: true`).
  - *It is at least N bytes*: a file only. A folder fails the node `permanent`.
  - While waiting, a missing path is "not yet" whether or not Exists is ticked. The roots' confinement is unchanged: a path outside them fails rather than waits. Once the condition holds, the node reads its ticked fields as without a wait.
- **The durable park.** An unmet check ends the attempt with `notReady`, mapped to `node.notReady`. The node is held `ready` and the driver either:
  - arms a `node_recheck` alarm and appends `node.recheckScheduled`, which parks it `wait_pending` (the run goes `waiting`, nothing is in flight, the same park as Wait); or
  - fails it `permanent` `wait_until_timeout`, once the check that answered ran at or after the deadline.
  - The alarm's `node.recheckDue` re-dispatches the node under a new attempt that spends no retry budget.
- **The deadline** is the first check's time + *Give up after*. It is fixed then and kept across every check and policy retry. The last alarm is clamped to it, so the final check runs at the deadline. A crash before the first park recomputes it from the resume, extending it by the downtime.
- **Checks are bounded:** *Give up after* / *Check every* ≤ 5000 (`MAX_WAIT_UNTIL_CHECKS`), because every check is a dispatch on the run's log and every alarm re-reads that log. ADF's defaults make 4,320.
- **One activity run.** The Monitor's activity-runs row and the run view's node row keep the first check's start and attempt number across the re-checks, as ADF shows one Validation run, not one per check.
- **Cancel:** a cancel fails a parked re-check (work it stopped), like a held retry, and a due re-check starts nothing on a cancelled run.
- **Crash recovery:** a not-ready node whose park was lost re-arms its alarm on resume, and a fresh one if the first was spent while the node was not parked.
- **Deliberate differences from ADF:**
  - The settings are on Get metadata, not a separate Validation activity (§1).
- `CATALOG_VERSION` 46→47: a pre-C8d build strips the keys and reads once.
- C8d-1 refused Wait until with a dataset bound; C8d-2a lifts that for a delimited or Excel dataset.

**Built (C8d-2a, 2026-10-17):** *Wait until* on a **delimited or Excel dataset** on a file system connection, with #1743.

- **The wait is on the dataset's file**, the path C8c-2 reads its fields from. The conditions, the timers, the durable park, the deadline and the one activity run are C8d-1's, unchanged. Once the condition holds, the node reads its ticked fields and the file's columns as without a wait.
- **A missing folder has an address (#1743).** Every dataset's address is resolved before dispatch. On a file system it used to `realpath` the dataset's folder, so a missing folder failed the node `dataset_address_unresolvable` before the activity ran. Now:
  - The address step takes `confine.ts`'s `resolveWithinRootsOrMissing`. A missing folder inside the roots resolves to its would-be canonical path (`missingWithinRoots`), with a `null` store identity, as a missing file in an existing folder already did.
  - A missing folder outside the roots, through a link out of a root, or past a dangling link, is still refused, with the original error.
  - Get metadata takes the same helper, so the missing-path fallback is written once.
  - **Behaviour change for Copy and Lookup:** a source in a missing folder now dispatches and fails at the read (`permanent`, the reader's message), as a missing file in an existing folder did. It used to fail before dispatch with `dataset_address_unresolvable`. Copy reads its source's columns before it opens the sink, so nothing is written. Copy · Files as-is and the path activities have no dataset address and are unchanged.
- **Where it is refused:**
  - At save, an inline source dataset with Wait until on. An inline dataset is a Table or a Query, never a file.
  - At dispatch, Wait until on a database connection (a table).
  - **Tradeoff:** a saved dataset's kind is not known at save, so a saved table dataset with Wait until on now saves and fails at its first run, where C8d-1 refused it at save. The editor draws Wait until only on a file system connection, so only a hand-written doc can reach it.
  - C8d-2b narrows both refusals to It is at least N bytes, and the editor now draws Wait until on a table too, without that choice.
- **Deliberate differences from ADF:** a delimited file of only a header, or an Excel workbook, is *not empty* once it has a byte. An Excel workbook is waited on as a file: when its sheet is missing, the wait holds and the column read then fails `permanent`.
- `CATALOG_VERSION` 47→48: a pre-C8d-2a build refuses Wait until on a dataset at save and at dispatch.

**Built (C8d-2b, 2026-10-17):** *Wait until* on a **table dataset** (SQLite, Postgres), a saved `table` dataset or an inline Table.

- **The choices on a table** are Off, *It exists* and *It is not empty*. *It is at least N bytes* is a file's: the editor offers it only on a file system (`fieldOptionsByConnectionKind.waitUntil`, from `GET_METADATA_WAIT_UNTIL_BY_CONNECTION_KIND`), and it is refused at dispatch on a database (`getMetadataKindIssue`, from the same constant) and at save on an inline Table. A saved table dataset with it still saves and fails at its first run, C8d-2a's tradeoff for the one choice left. The timers, durable park, deadline and one activity run are C8d-1's, unchanged.
- **The conditions:**
  - *It exists*: a table or view of that name (C8c-1's lookup). While waiting, a missing table is "not yet" (`there is no table 't' yet`), whether or not Exists is ticked. So is a Postgres schema that does not exist, as `to_regclass` answers.
  - *It is not empty*: at least one row. Without Row count ticked it is a one-row probe (`LIMIT 1` on SQLite, `exists (select 1 …)` on Postgres) in the same open or `READ ONLY` session as the columns, which stops at the first row. With Row count ticked the count answers it, so the probe and the count can never disagree about one table; each such check is then a full `count(*)`.
  - Once the condition holds, the node reads its ticked fields as without a wait.
- **Still a failure while waiting**, as without one: a missing SQLite file, a SQLite schema (attached database) the store does not have, a view whose base table does not exist, a Postgres table the role cannot SELECT, and a Postgres materialized view that has not been populated (the probe throws), all `permanent`. A Postgres connection that cannot be reached is `transient`, so it spends the retry budget rather than waiting for the next check. A Postgres probe or count cut off by the statement timeout fails as any timed-out read does (#1741), not "not yet".
- **Residual:** the probe scans only when there is no row to find, which is exactly while waiting. An empty view over a large table runs its whole query on every check; on SQLite that is synchronous and holds the server's event loop, as Row count's `count(*)` already does (C8c-1).
- **Deliberate differences from ADF:** ADF's Validation waits for a file or folder only (a dataset that supports *MinimumSize* or *ChildItems*). Waiting on a table, and *not empty* meaning one row, are studio additions.
- `CATALOG_VERSION` 48→49: a pre-C8d-2b build refuses Wait until on a table at dispatch, and on an inline Table at save.

### 4.4 Delete
Source: [Delete](https://learn.microsoft.com/azure/data-factory/delete-activity).

- **Tabs:** General · Source · Settings.
- **Source:** connection, then Path ⓕ, *Wildcard* ⓕ, *Include subfolders* (default **off**, as ADF), *Modified between*.
- **Settings:**
  - *Max concurrent deletes* (1).
  - **Session log** (same options as Copy): the items deleted, skipped or kept, by level.
  - *Fail if nothing matched* (off).
  - *Delete empty folders* (off).
- **Outputs:** `filesDeleted`, `foldersDeleted`, `logPath`.
- Tables are not deleted here. That is Script.

**Built (C9a, 2026-10-17):** Delete on a file system connection, as the new `delete` type. It is in the palette as *Delete*. *Delete file* left the palette in C9b, which lowers it to Delete (below).

- **Source:** connection, *File or folder path* ⓕ, *Path type* (Folder by default, or File, as Copy · Files as-is), and, for a folder only, *Wildcard* ⓕ (default `*`) and *Include subfolders* (default off, as ADF's `recursive`). *Modified from* / *Modified before* apply to a file as well. A wildcard or Include subfolders on a File path type is refused at save, not ignored.
- **Settings:** *Max concurrent deletes* (ADF's `maxConcurrentConnections`, 1 by default, 1 to 64), *Fail if nothing matched* (off), *Delete empty folders* (off; drawn and accepted only with Include subfolders on). A boolean field can now control `appliesWhen` (read as `'true'`/`'false'`).
- **Outputs:** `path` (the canonical path, as `file_delete`'s, so C9b can alias it), `filesDeleted`, `foldersDeleted`. C9c adds `logPath`.
- **Needs Allow writes** on the connection; the run refuses it otherwise, and the Problems list warns first (`writeAccessWarnings`, as for Copy · Files as-is).
- **Plan, then delete.** Every file is chosen before any is deleted, so the entry limit (`maxEntries`), a bad window or Fail if nothing matched fail the node with every file still there. Deletes then run on that many workers, taking the files in name order. The first error stops new ones; the deletes under way finish and are counted, and the counts so far are reported as outputs before the failure, as Copy · Files as-is reports its own. A cancel does the same.
- **The walk is Get metadata's.** Child items' folder walk moved to `fs-walk.ts` and both activities use it, typed by `lstat` and never following a link, so Delete is not a third copy (Copy · Files as-is keeps its dirent-typed walk: #1691).
- **Containment on a destructive walk.** Before each `unlink` and `rmdir`, the entry is checked again: still the one planned (device and inode, compared as `bigint`), still a file (or folder) and still in the window, and its folder, resolved again, still the folder at the path or under it. So a subfolder swapped for a link during the walk deletes nothing through it. The folder compared against is the path's `realpath`, so a path typed in another case on a case-insensitive file system still matches its files. The residual is the gap between that check and the call, which Node cannot close without `unlinkat`, the same gap Copy's delete-source has. A file replaced by one that reuses the freed inode number reads as the same file and is deleted, as a fresh run would delete it; the identity check is there for the swapped link, which the containment check catches.
- **Deliberate differences from ADF:**
  - The folder at the path is never removed. ADF's recursive delete of a folder with no file name removes the folder too. Here *Delete empty folders* removes every subfolder left empty, deepest first, including ones that were empty already and ones no file matched, and stops at the path. The path may name an allowed folder itself.
  - Only regular files are deleted. A link, and an entry of any other type, is left in place.
  - A folder `rmdir` cannot remove because it is a mount point (`EBUSY`) is kept, as a non-empty one is. Any other `rmdir` error fails the node after the files, with the counts.
  - A missing path matches nothing and succeeds with zero counts. *Fail if nothing matched* makes it fail. A file removed by someone else after it was chosen is skipped, not counted and not a failure.
- **Not in C9a:** the session log and `logPath` (C9c, built below), progress output while it runs (§5), and the `file_delete` lowering (C9b).
- `CATALOG_VERSION` 49→50 (a new runnable type).

**Built (C9b, 2026-10-17):** a stored *Delete file* (`file_delete`) opens in the editor as Delete on the same connection and path, *Path type* File and *Fail if nothing matched* on, and the next Save writes it as `delete` (`lowerFileDelete` in `retired.ts`, §8). *Delete file* is no longer offered in the palette. A stored version still runs through `file_delete`'s own arm.

- **Why those settings:** File is the one-file path type, and Fail if nothing matched keeps Delete file's failure on a missing file.
- **`path` keeps its name and value.** Both resolve the path the same way and report the canonical path, so a `${nodes.x.output.path}` read needs no rewrite. `filesDeleted` and `foldersDeleted` are new outputs.
- **The same outcome** for a file (deleted), and a `permanent` failure with nothing removed for a missing file or folder, a folder, a link at the path, and a path outside the allowed folders.
- **Faithful or not at all,** as the other lowerings: a node that carries something Delete would refuse or drop (`connectionParams`, datasets, a call), or whose path is not a string the Delete schema accepts, stays Delete file.
- **Deliberate differences of the saved node from Delete file** (a stored version keeps the old behaviour until it is saved again):
  - It needs *Allow writes* on the connection, which Delete file never read. The Problems list warns first (`writeAccessWarnings`), as for a lowered Copy file.
  - Only a regular file is deleted. A FIFO, socket or device file at the path fails as "not a file", where Delete file unlinked it.
  - A file deleted by someone else after it was chosen is skipped and the node succeeds with `filesDeleted` 0, where Delete file failed on the missing file.
  - A failed unlink reports the outputs (`path` and the counts) before the failure, as every Delete does. Delete file reported none.
  - A cancel or a timeout that arrives after the file was chosen stops it before the unlink. Delete file's unlink, once the path was resolved, ran regardless.
  - Failure messages are Delete's.
- No `CATALOG_VERSION` change: Delete already declares `path`, and leaving the palette stores nothing.


**Built (C9c, 2026-10-17):** Delete's session log and its `logPath` output. The settings, the line shape, the level filter and the run log's cap are shared (`catalog/session-log.ts`), and so is the folder writer (`session-log-file.ts`). Copy's C6 spreads the same fields; its log can run to a line per skipped row, so it needs an appending writer rather than lines held until the end.

- **Settings:** *Session log* Off · Warnings · Everything (`logLevel` off · warning · info, ADF's copy log names; default **Warnings**, §4.1's default), *Write to* Run log · Folder (`logTo`, default Run log; drawn while the log is on), *Log folder* ⓕ (`logFolder`; drawn for Folder). A setting that would be ignored is refused at save: Folder while Off (reported on *Session log*, the field still drawn), a Log folder without Folder, Folder without a Log folder.
- **Lines:** Timestamp, Level, Operation, Item, Message (§5). The item is relative to the path (File: the file's name). *Info*: `FileDelete` and `FolderDelete` for each item removed, and `FolderSkip` for a folder kept because it still holds files. *Warning*: `FileSkip` for a file no longer the one chosen, removed by someone else, or a link (or other non-file) that matched and is left in place; `FolderSkip` for a folder gone, no longer a folder, or a mount point. *Error*: the file or folder a delete failed on, with the error. A failure before any item (a refusal, the entry limit) is the node's error alone. Warnings keeps Warning and Error lines; Everything keeps all.
- **Run log:** each line is a `node.output` named `sessionLog` (folded inert, as Copy's progress), streamed ahead of the terminal and shown in the Monitor's Logs tab. At most 1000 lines (`SESSION_LOG_RUN_MAX_LINES`); past that the first 1000 are kept, then the Error line if there is one, and a last Warning line says how many were not kept. `logPath` is null.
- **Folder:** one CSV per attempt, `session-log.<run>.<node>.<attempt>.csv` (hashed when that is too long for a file name), through the same atomic write as `file_write`, and `logPath` is its path. The name is the attempt's own, so it is a plain rename, not Copy's no-overwrite `link`, which a file system without hard links refuses. It is `util/csv.ts`'s CSV (BOM, CRLF), so an item a spreadsheet would read as a formula gets a leading `'`. The folder is on the **same connection**. Before anything is planned it must exist, be a folder and be writable. Before the walk, a folder this Delete could remove, or whose later log files its wildcard could match (the folder at the path, or under it with Include subfolders on), is refused, and nothing is written. A File path's own folder is allowed.
- **Every terminal after those checks keeps the log:** success (a missing path writes a header-only file), Fail if nothing matched, a failure mid-delete and a cancel. The file write has its own 10 s bound (`SESSION_LOG_WRITE_TIMEOUT_MS`, a race, since `open` and `rename` take no signal), so a hung mount cannot hold a cancelled attempt open. A log that cannot be written fails a successful delete `permanent`, reporting the counts first; an attempt already failing keeps its own error, with `logPath` null.
- **Secure flags:** either flag withholds the run-log lines, since an Error line carries an error as `node.failed` does (`redactSecureEvent`); Secure output also withholds `logPath`. A folder log is a file the author asked for, so item names in it are not redacted, as Copy's written data is not.
- **Deliberate differences from ADF:**
  - The log folder is on the Delete's own connection. ADF's `logStorageSettings` names any storage linked service; studio's node binds one connection (a source/sink pair is Copy's), so another connection is deferred.
  - The columns are §5's shared ones, not ADF Delete's Name, Category, Status, Error.
  - The run log as a destination, and Warnings as the default, are studio's (ADF's `enableLogging` is off by default).
- **Not in C9c:** ADF Copy's *Best effort · Reliable* mode. The lines are held in memory (bounded by the connection's entry limit) and written at the end, so a server that dies mid-delete loses them.
- `CATALOG_VERSION` 50→51: `logPath` is a new output (with a `formerOutputs` snapshot of C9a's three), which a pre-C9c build never yields.
### 4.5 Script
Sources: [Script](https://learn.microsoft.com/azure/data-factory/transform-data-using-script), [Stored procedure](https://learn.microsoft.com/azure/data-factory/transform-data-using-stored-procedure).

- **Tabs:** General · Settings · Script.
- **Settings:** database connection (the same picker); *Block timeout* (default 30 min).
- **Script:** one or more blocks, each with:
  - **Type**: Query (returns rows) · Non-query (DDL/DML);
  - SQL ⓕ (code editor);
  - **Parameters** table: name · type · value ⓕ · direction In / Out / In-out.
- A stored procedure is a block (`CALL proc(:a)` / `EXEC`).
- Blocks run in order, in **one transaction** if *Run as one transaction* (default off; on gives all-or-nothing).
- **Logging:** *Capture result sets* Off · First 1000 rows (default) · Up to the workspace cap; *Capture messages* (server notices).
- **Outputs:** `resultSets[{rowCount, rows}]`, `recordsAffected`, `outputParameters`, `truncated`.
- Writing is gated by the connection's `writable` (fail-closed, as copy is today).

### 4.6 Web
Sources: [Web](https://learn.microsoft.com/azure/data-factory/control-flow-web-activity), [Webhook](https://learn.microsoft.com/azure/data-factory/control-flow-webhook-activity).

**Tabs:** General · Request · Auth · Settings.

**Request:**
- Connection (HTTP, optional base URL)
- Method `[GET ▾]`
- URL ⓕ
- **Headers** table (name · value ⓕ)
- Body ⓕ (with *Format JSON*)

**Auth:** the connection's auth (Bearer from its secret); per-request **Secret headers** (name · `{$secret}`, literal names, as today).

**Settings:**

| Setting | Default | Notes |
|---|---|---|
| **Fail on HTTP error** | **on** | Today a 4xx or 5xx succeeds. Off keeps today's behaviour. *Treat as success* list for codes such as 404 |
| Request timeout | 30 s | Max 10 min, as in ADF |
| **Response** | — | *Parse as* JSON · Text. *Max size* default 4 MiB, as in ADF, which closes today's uncapped body; over the limit fails or truncates and warns, your choice |
| Retry on 429/503 | on | Honours Retry-After; uses the activity retry policy |
| **Wait for callback** | off | = Webhook. Studio adds `callBackUri` to the body (or sends nothing if no URL is set, which is today's inbound-only wait). Callback timeout (default 10 min). *Report status on callback*: a callback with StatusCode ≥ 400 fails the activity |
| Pagination | — | Placeholder for later: next-link expression, max pages |

**Outputs:** `status`, `headers`, `body` (parsed), `bytes`, `durationMs`, `callback` (when waiting).

**Built (C11a).** The `web` type, on an http connection, with the Request, Auth and Settings tabs above, except *Wait for callback* (C11c) and Pagination. Decisions made while building it:
- **Field names** are ADF's (`method`, `url`, `headers`, `body`), with the timeout as `httpRequestTimeoutSeconds`, in seconds like every studio duration. An empty timeout uses the connection's `timeoutMs`, else 30 s. The labels are *Request URL* and *Request headers*, as on HTTP request, because a field's label may not contain another label on its panel (the connection's *Base URL*, the *Secret headers*). The Request tab puts the URL first, as ADF does: a tab lists its required fields first.
- **Methods** are ADF's five plus HEAD, which studio adds because `http_request` accepted it and the connection test sends one. C11b upper-cases a lowercase method when it lowers `http_request`; a method outside the six cannot be lowered, so that node stays `http_request`, and C13's Convert has to explain why.
- **Fail on HTTP error** uses `classifyHttpStatus`, as the LLM adapters do: 401/403 fail `auth`, 429 `rate_limit`, any 5xx `transient`, anything else `permanent`. The error is `HTTP <status> <text>: <first 500 characters of the body>`; the whole body is redacted of every request header value before it is cut. The secure flags withhold it, as they withhold every error. A retryable failure carries `Retry-After` to the retry alarm. *Retry on 429 and 503* off makes those two `permanent`; any other 5xx stays a retry candidate. The policy's retry count still decides whether anything retries.
- **Max size** defaults to ADF's 4 MiB and is capped at the connections' read ceiling, `DEFAULT_MAX_READ_BYTES` (10 MiB), because the body lands in `node.succeeded` on every attempt. A `Content-Length` over the limit fails before the body is read, except under a `Content-Encoding` (it is then the compressed size) and on a HEAD, 204 or 304 (no body). *Truncate* needs Parse as Text, because a JSON prefix is not JSON. It keeps the first Max size bytes, without a UTF-8 character the cut split, sets the `truncated` output and warns `web_response_truncated`. `truncated` is not in the list above; it is Lookup's two-channel rule (C7c). `bytes` is the body bytes read.
- **Parse as JSON.** An empty body (a 204) is null. A body that is not JSON fails `permanent` and names Parse as Text, and so does one nested deeper than 64 levels, which keeps clear of the redaction walk's 100-level ceiling. An error status let through (Fail on HTTP error off, or *Treat as success*) keeps a body that is not JSON as text, because an error page is usually HTML.
- **No secret in the outputs.** The connection's Bearer and the resolved secret headers are redacted from the body and the response headers, for an endpoint that echoes its request. `http_request` now does the same.
- **A network failure is `transient`.** Node's `fetch` throws the same `TypeError` for a refused connection as for a bad URL, so the `cause.code` decides: ECONNREFUSED, ENOTFOUND, a dropped socket and the other listed codes are transient. A bad URL or header stays `permanent`. `http_request` still reports them `permanent`; when C11b lowers it, a lowered node with a retry policy will retry a refused connection, the one result the lowering changes.
- **Redirects** are followed by studio, not by `fetch`, so the secret headers, the Bearer and cookies are dropped on a redirect to another origin. Node's own walk forwarded a custom secret header such as `X-Api-Key`. Plain headers (the connection's defaults and the Request headers table) still follow, as a browser's do, so a credential belongs in *Secret headers*. `http_request` now uses the same walk.
- **`callback`** is declared now and is always null until C11c fills it, so a C11a node needs no contract refresh then.
- **Not built:** *Format JSON* on Body (polish), and Pagination (a placeholder above).
- **The palette** showed Web next to HTTP request until C11b (below).

**Built (C11b, 2026-10-18):** a stored *HTTP request* (`http_request`) opens in the editor as Web on the same connection, with *Fail on HTTP error* off, *Parse as* Text and *Max size* 10 MiB, and the next Save writes it as `web` (`lowerHttpRequest` in `retired.ts`, §8). *HTTP request* is no longer offered in the palette. A stored version still runs through `http_request`'s own arm.

- **Why those settings:** Fail on HTTP error off lets a 4xx or 5xx succeed and be read from `status`, as before. Text keeps `body` the string it was. Max size is the read ceiling (`WEB_MAX_RESPONSE_BYTES`), the closest to HTTP request's unbounded read. ADF's 4 MiB default, and §4.6's "closes today's uncapped body", apply to a new node only.
- **Outputs keep their names.** `status`, `body` and `headers` are Web's too, so no read is rewritten. Web's `body` is declared `json`, which types as `any`, so every expression that typed against HTTP request's string `body` still types. `bytes`, `durationMs`, `truncated` and `callback` are new outputs.
- **The method is upper-cased** (`patch` → `PATCH`). An unset method is GET.
- **Connection parameters are kept.** Web binds one connection, as HTTP request does, so `connectionParams` apply to it unchanged. This differs from the other lowerings, whose replacements pair two connections.
- **Faithful or not at all.** The node stays HTTP request when:
  - its method is not one of the six, or is an expression;
  - it is a GET or HEAD with a body, even an empty one (HTTP request fails that node at every run, and Web would send `''` as no body and succeed);
  - its contract is not a list, or declares an output Web lacks or types narrower (a reader of it would no longer resolve or type);
  - it carries a key that is one of Web's own settings (`parseAs`, `successStatusCodes`), which HTTP request never read and Web would act on;
  - it carries paired connections, datasets or a call;
  - its config fails Web's schema (no URL, a header that is not a string).
- **Unknown keys are carried over**, unlike in the other lowerings, which build the config afresh. The config form keeps a key it has no control for, and an API-authored or imported doc may hold one that this build does not know.
- **The same answer.** A server test runs each stored config as HTTP request and its lowering as Web against one stub. It compares `status`, `body` and `headers`, and the request's path and method, for a 200, a 404 HTML page, a 503 with Retry-After, a 204, a HEAD and a JSON body kept as text. For a POST it also compares the body and headers sent, with the connection's Bearer and a secret header. For a timeout it compares the failure kind.
- **Deliberate differences of the saved node from HTTP request** (a stored version keeps the old behaviour until it is saved again):
  - A refused connection or a DNS failure is `transient`, so a retry policy retries it (C11a, above).
  - A response over 10 MiB fails, where HTTP request read it whole.
  - A lowercase method goes out upper-case. Node's `fetch` already upper-cased all but PATCH.
  - A POST, PUT, PATCH or DELETE with an empty body sends no body, and so no `text/plain` Content-Type.
  - A contract the author edited (descriptions, `optional`) is replaced by Web's, as in every lowering.
  - Error and cancel messages are Web's ("web request timed out").
- **The starter template** *Call an API and stop on an error response* now adds a Web with Fail on HTTP error off, so its If still reads the status. With Fail on HTTP error on, ADF's default, the Web alone would fail the run on an error status.

**Built (C11c-1, 2026-10-18): Wait for callback, with a URL.** C11c is split. C11c-1 is the outbound half: a Web with *Wait for callback* on sends its request with `callBackUri` and waits. C11c-2 is the rest: a Web with no URL (today's inbound-only `webhook` wait), the `webhook` lowering, and Webhook leaving the palette.

- **Settings:** *Wait for callback* (`waitForCallback`, off), *Callback timeout* (`callbackTimeoutSeconds`, whole seconds, empty is ADF's 10 minutes, at most 7 days) and *Report status on callback* (`reportStatusOnCallback`, off). The last two show, and save, only while Wait for callback is on. All three are literal, like the other Settings toggles; the callback timeout is a number like *HTTP request timeout*, not dynamic content.
- **The body.** Studio sends the author's JSON object with `callBackUri` set, replacing an author key of that name, and `Content-Type: application/json` unless a header sets one. An empty body sends `{ callBackUri }`. Any other body is refused: at save for a literal body, at dispatch for a `${}` one. A GET or HEAD is refused at save, since it carries no body.
  - **Deliberate difference from ADF:** ADF's Webhook is POST only. Studio allows POST, PUT, PATCH and DELETE, because Web already sends a body with each of them.
- **The callback URL** is absolute: `AUTONOMY_PUBLIC_URL` (configuration, with a path prefix allowed behind a proxy) joined to `/api/external-wait/<token>`. Unset, it is the bind address, which only a caller on the same machine can reach. The token is `webhook`'s: derived per attempt, stored only as a hash, never in the log. An endpoint that echoes its request cannot leak it: the URL and the token are redacted from Web's outputs and errors, like the Bearer.
- **The request runs as without the wait** (Fail on HTTP error, Max size, Parse as, Retry-After). A failure fails the attempt, and nothing waits. A success ends the attempt as `node.awaitingCallback` (the request's outputs, without `callback`). The engine then parks the node on `webhook`'s machinery: the expiry alarm, the correlation row and `externalWait.created`. The run shows *waiting*, and the owner's pending-callbacks panel offers the URL.
- **The callback.** Its JSON body, whole, is the `callback` output, merged with the request's outputs. An empty body is null. A body that is not JSON is refused with 422 and the node stays parked, so the caller can retry. With *Report status on callback*, a `StatusCode` of 400 or above (a number or a numeric string, as in ADF's example) fails the activity. The message is `the callback reported StatusCode <n>: <ErrorCode>: <Message>`, carried on the event as `reportedError`. Like an expiry, it is a permanent failure: the retry policy does not apply, and the failure edge is the escape hatch. The callback is kept whole as `callback`, rather than ADF's `Output` alone, so `Error` and `StatusCode` stay readable.
- **The timeout** counts from the request's success. Running out fails the node as a `webhook` expiry does. `policy.timeoutSeconds` bounds the request only, not the wait.
- **A callback that arrives before the endpoint answers** (a synchronous endpoint that calls back first) is not lost. The correlation row is recorded before the request is sent, so the callback finds it. Its body is kept on the row (`external_waits.early_callback`, migration 0049) rather than appended to the log, because the run's own pump is mid-request. When the request returns, the park's arm reads it and settles the node at once: `externalWait.created.arrived`, with no alarm and no park.
  - A request that ends without waiting expires its row, so a dead attempt offers no callback URL.
  - A crash mid-request can leave a `pending` row on an interrupted run. It completes nothing, because the completer checks the node.
- **Crash recovery:** a node held `ready` with its request's outputs re-parks on resume. It never re-sends the request; Web is not idempotent.
- **Not built (C11c-2):** a Web with no URL, the `webhook` lowering, and Webhook leaving the palette.

### 4.7 Set variable
Sources: [Set variable](https://learn.microsoft.com/azure/data-factory/control-flow-set-variable-activity), [Append variable](https://learn.microsoft.com/azure/data-factory/control-flow-append-variable-activity), [pipeline return value](https://learn.microsoft.com/azure/data-factory/tutorial-pipeline-return-value).

- **Operation** Set · Append (array variables only) · **Pipeline return value**. Return value is a key · type · value ⓕ table that the parent reads as `output.pipelineReturnValue.<key>` (this joins OR34's outputs work).
- **Variable** `[▾ declared variables]` (literal, with ＋ New variable).
- **Value** ⓕ.

### 4.8 Unchanged except as noted

| Activity | Change |
|---|---|
| Execute pipeline | General tab (§3); version binding Follow live / Follow latest / Pin (OR34 #1483); *Wait on completion* (default on) |
| Wait | Seconds ⓕ |
| Fail | Message ⓕ + **Error code** ⓕ (new; default `forced_fail`) |
| If condition, Switch, Filter | General tab; evaluation records (OR36 #1567 A2) |
| ForEach | *Sequential* toggle + Batch count (1–50); items ⓕ |
| Until | Exit when ⓕ, Max rounds, Timeout |
| LLM call, Agent task | General tab (§3); tabs as today. Their `capture` setting folds into §5's capture level |

---

## 5. Logging, the same for every activity

This builds on OR36 #1567, which owns capture caps and retention.

| Record | Content | Where |
|---|---|---|
| Input | Resolved config after `${}`, the per-field expression trace (template → value), dataset and connection snapshot, resolved SQL | `node.dispatched` (OR36 A1/A2) |
| Metrics | The activity's typed outputs (§4). The monitor maps rows, files, bytes, duration and count columns for **every** activity, not just copy | `node.succeeded` |
| Progress | Copy and Delete: rows and files so far, every N seconds | `node.output progress` (today copy only) |
| Error | Code, message, kind (transient / permanent), **cause chain**, source/sink side, the failing item (file or row number) | `node.failed` (+ OR36 A5) |
| Session log | Copy and Delete: per-file and skipped-row lines (Timestamp, Level, Operation, Item, Message), written to the run log or a folder | new |
| Warnings | Truncation, skipped rows/files, unmapped columns, count mismatch | `activity.warned` |

The **capture level** (workspace setting, overridable per pipeline and per activity) is *Standard* or *Full*. Secure flags beat every level.

---

## 6. Sources and sinks: what each connection can do

✓ = today · **T** = this spec builds it · OR# = the ticket that adds the connector or format · — = not applicable.

| Capability | File system (fs) | SQLite | Postgres | HTTP | S3 / Blob / SFTP | MySQL / SQL Server / Snowflake |
|---|---|---|---|---|---|---|
| Copy source, rows | ✓ delimited, excel; JSON/Parquet OR14 | ✓ table, query | ✓ table, query | T (JSON response as rows) | OR13 | OR15 |
| Copy sink, rows | T delimited (OR14 writer) | ✓ append/overwrite; **T** truncate, upsert, auto-create, pre-copy | ✓ same | — | OR13 | OR15 |
| Copy, files as-is | ✓ copy/move (single file); **T** folder, wildcard, list, delete-after | — | — | T (download to file) | OR13 | — |
| Lookup | ✓ | ✓ | ✓ | (use Web) | OR13 | OR15 |
| Get metadata | ✓ full field list (C8a), a file dataset's structure and column count (C8c-2); **T** wait | ✓ exists, structure, columns, rows (C8c-1) | ✓ same | — | OR13 | OR15 |
| Delete | ✓ one file, wildcard, subfolders, dates, empty folders (C9a); session log (C9c) | — (Script) | — (Script) | — | OR13 | — |
| Script | — | **T** | **T** | — | — | OR15 |
| Web | — | — | — | ✓ fail-on-error, cap, parse, Retry-After (C11a); **T** callback | — | — |
| Test connection | ✓ roots | ✓ `select 1` | ✓ `select 1` | ✓ HEAD | OR13 | OR15 |
| Preview / import schema | OR10 #1401 | OR10 | OR10 | OR10 | OR13 | OR15 |

The matrix is generated from adapter capability declarations, and **OR39 #1574 makes it a CI gate**. A cell this doc marks ✓ or T without a passing conformance test fails the build.

---

## 7. Build slices (each a merged PR with e2e)

| # | Slice | Absorbs |
|---|---|---|
| C0 | General tab for all activities: description, state + mark as, **enforced timeout**, user properties as monitor columns | F3 timeout |
| C1 | **Copy: Files as-is**. Folder/wildcard/list/recursive/modified-between source; preserve/flatten/merge; if-exists; after-copy keep/delete/move. Lower file_copy and file_move. Split: **C1a** the `copy_files` type, its fs engine, the fs `writable` permission and the dock toggle; **C1b** the `file_copy`/`file_move` lowering with output aliases (§8), and both retired from the palette (moved forward from C13, since their lowering exists) | part of OR30 #1478 |
| C1q | **Copy + Lookup: database source Use Table · Query, inline** (operator ask 2026-10-14; §4.1's Database row had no slice). Split: **C1q-a** the engine — `Node.inlineDatasets.source` {kind table/query, config}, `datasetIds.source` optional beside it, save rules, dispatch, portability (`CATALOG_VERSION` 38); **C1q-b** the dock's Source block (Use Saved dataset · Table · Query, the literal SQL statement with ⤢, the `:name` bind values table with ⓕ values), the same block on Lookup, and the watermark-journey e2e; **C1q-c** Preview, the table dropdown, Query timeout, `:name`-derived rows (*Import from statement*) and a type per bind value (all built; C1q complete) | — |
| C2 | Copy: inline source + file sink (rows → delimited). Lower file_write | OR14 writer dependency |
| C3 | Copy: database sink. Truncate, upsert (keys), auto-create from mapping, pre-copy script, batch size | OR15 upsert/auto-create |
| C4 | Copy: mapping redesign (x → y rows from imported schemas, map-by-name default, type conversion settings, ƒx whole mapping, additional columns) | depends on OR10 import |
| C5 | Copy: incremental (watermark Automatic / Expression; files modified-since-last-success) | OR15 incremental |
| C6 | Copy: settings. Fault tolerance, consistency check, parallelism, session log; complete outputs | — |
| C7 | Lookup: first-row-only, max rows, over-limit choice, whole-file text. Lower lookup and file_read. Split: **C7a** Settings (First row only, Max rows, When over the limit), `count`/`firstRow`, a stored node's former contract refreshed on load (built); **C7b** Read as Rows · Whole file as text (`file_read` as Lookup's second type), the title *Lookup* (built); **C7c** *When over the limit* and `bytes`/`truncated` for the text mode, limited by the connection's `maxBytes` rather than the 1 MiB byte cap (built); **C7d** the workspace Lookup max rows (1000 by default, up to ADF's 5000) and the Monitor Rows read column (built) | — |
| C8 | Get metadata + wait-until. Lower file_list. Split: **C8a** the `get_metadata` type on a file system connection, the field list as tick boxes, child items with filter, entries and modified window (built); **C8b** the `file_list` lowering with the `entries` → `childItems` rewrite, List directory retired from the palette (built); **C8c-1** tables (SQLite, Postgres) with per-kind field options (built); **C8c-2** a delimited or Excel dataset source's structure and column count (built); **C8d-1** Wait until on a file system path (built); **C8d-2a** Wait until on a delimited or Excel dataset, with #1743 (built); **C8d-2b** Wait until on a table dataset (built); **C8e** Include subfolders (built) | OR17 #1408 |
| C9 | Delete: wildcard, folders, dates, log. Lower file_delete. Split: **C9a** the `delete` type on a file system connection, with path type, wildcard, Include subfolders, modified window, Max concurrent deletes, Fail if nothing matched and Delete empty folders, on Get metadata's walk (built); **C9b** the `file_delete` lowering (Path type File, Fail if nothing matched on, `path` kept), Delete file retired from the palette (built); **C9c** the session log and `logPath` (a new output, so a `formerOutputs` snapshot and a version bump), shared with Copy's (built) | OR17 #1408 |
| C10 | Script activity | OR12 #1403, OR15 sql_script |
| C11 | Web: fail-on-error, response cap, parse, retry-after, wait-for-callback. Lower http_request and webhook. Split: **C11a** the `web` type, its Request, Auth and Settings tabs, and the redirect walk that keeps secret headers on their origin (built); **C11b** the `http_request` lowering (Fail on HTTP error off, Parse as Text, method upper-cased) and HTTP request retired from the palette (built); **C11c** Wait for callback and the `webhook` lowering | — |
| C12 | Set variable operations + pipeline return value. Lower append_variable | OR34 outputs |
| C13 | Palette regroup (§2), retire the remaining old types from the palette (C1b retired Copy file and Move file), `CATALOG_VERSION` bump, the migration guarantees in §8. `file_read` is NOT retired: since C7b it is Lookup's *Whole file as text* mode, so it is never refused, converted or listed as retired | — |

**Order:** C0, then C1 (the operator's "copy and copy file" complaint), C7, C8, C9 (cheap consolidations), C11, C12, then C2–C6 as their dependencies (OR10, OR14) land, then C10 and C13. C13 can only land once every retired type has a lowering.

---

## 8. Migration guarantees

- **Lowering at read time.** A stored node of a retired type is presented and dispatched as its replacement:

  | Retired type | Becomes |
  |---|---|
  | `file_copy` | Copy · Files as-is · Keep |
  | `file_move` | Copy · Files as-is · Delete source |
  | `file_write` | Copy · Inline → file |
  | `file_read` | Lookup · Whole file as text (C7b: the same type, offered as Lookup's mode; no lowering) |
  | `file_list` | Get metadata · Child items |
  | `file_delete` | Delete · File · Fail if nothing matched (C9b) |
  | `lookup` | Lookup · not first-row-only, so today's `rows` shape is kept |
  | `http_request` | Web · Fail on HTTP error **off**, Parse as Text, Max size 10 MiB, so today's behaviour is kept (C11b) |
  | `webhook` | Web · Wait for callback, no URL |
  | `append_variable` | Set variable · Append |

  The saved document is not rewritten until the author saves it again. Old versions keep running and replay identically, because a version is immutable and binds the type it holds.

  **How C1b built it** (`packages/shared/src/catalog/retired.ts`), with two deliberate departures from the sentence above:
  - **Presented, not dispatched.** The lowering runs on the editor's load only, so the next Save writes the replacement. A stored version keeps its type and dispatches through that type's own arm. Dispatching `file_copy`/`file_move` as `copy_files` would change four results, against the "Defaults keep today's behaviour" rule below:
    1. `copy_files` needs Allow writes on the connection; the old types never read it.
    2. It creates a missing destination folder, where Copy file fails.
    3. One file is a regular file, where Move file also moves a folder.
    4. A move becomes a copy then a delete: it succeeds across file systems where Move file fails, and it copies the bytes where Move file renamed. A move onto its own source, a case-only rename included, is refused.
  - **Not on the server's write path.** `lowerPipelineNodes` also runs for workspace-git apply and portable import, which keep a file's version id and re-mint history. Lowering there would make a re-pulled branch file differ from its own stored row, and change what an imported OLD version does. The server keeps accepting the retired types until C13 decides otherwise.
  - **Faithful or not at all.** A node is left as its retired type when it carries `connectionParams` (a paired node refuses them), when its destination's file name begins with an expression or its folder is one bare expression (either may resolve absolute, empty or to a number, which the split fields refuse where the old string join wrote it), or when the lowered config would not validate. C13's Convert has to explain those, since they never lower.
  - **Allow writes.** A saved lowered node is a real `copy_files` and needs Allow writes on its connection. The Problems list warns while the connection lacks it, for every Files as-is copy, so the author hears it before the run refuses. A lowered Delete file is the same: a saved `delete` needs it too, and the same warning covers every Delete (C9b, §4.4).
- **Output aliases.** Old output names stay readable. For example `nodes.x.output.entries` (List Directory) is rewritten to `childItems` in the doc as the node is lowered, and the node is not lowered where a read cannot be rewritten (C8b). `output.content` from Read File works on the Lookup. Each lowering declares its aliases, and a unit test checks every retired output name. Copy file and Move file need no renaming: Files as-is yields `bytesWritten`, `source` and `dest` under the same names and types (C1b).
- **Defaults keep today's behaviour** where the new default would change a running pipeline's result: Web *Fail on HTTP error*, Lookup *first row only*, Copy *after copy*. The *new-node* defaults are ADF's. The *lowered-node* defaults are today's behaviour.
- **Palette:** retired types are not offered. A pipeline that still contains one shows it under its new name, with a one-click *Convert*. Convert is the lowering written back, and it shows a diff before saving.

---

## 9. Choices made under config over decisions

These are defaults the operator can override; none blocks the build.

- **LLM call and Agent task stay separate.** Their property sets barely overlap. They could merge later as one *AI* activity with Mode Prompt · Agent if the palette needs it.
- **Stage stays** as studio's grouping container (no ADF equivalent).
- **If condition and Switch stay separate**, as in ADF.
- **Stored procedure is a Script block**, as in Fabric, not its own activity as in ADF.
- **Validation is Get metadata's *Wait until* toggle**, not its own activity (Fabric dropped it too).
