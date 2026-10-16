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

**Built (C1q-a, #1600):** an inline Table or Query is `Node.inlineDatasets.source`, a node-level field beside `datasetIds` (whose `source` became optional so a Copy can bind a saved sink beside it). It dispatches as the same resolved dataset a saved one becomes, so every reader runs unchanged. The SQL text, table and schema stay literal by construction: the reducer resolves `${}` only in the parameter **values**, and save refuses a `${` in the SQL, so a value can never become SQL and a name never comes from an expression (§8). At dispatch the node's source connection must be a store the kind can live in (sqlite or postgres). A Lookup's first row is read as `${nodes.<lookup>.output.rows[0].<column>}` until C7 adds `firstRow`; studio has no `activity('Name')` function, so the ticket's ADF spelling does not apply.

**Built (C1q-b, #1600):** the Source tab's *Use* Saved dataset · Table · Query edits `Node.inlineDatasets.source` for Copy and Lookup, writing through on each keystroke with one undo step per field. It shows when the source connection is a store an inline kind can live in, or when an inline source is already stored; a stored one under a connection that cannot hold it says so. The fields, titles and `?` notes come from the `table` and `query` dataset schemas, so the inline form and the saved dataset form cannot drift. This row's original ⓕ on the table and the SQL editor contradicted §8's literal rule, so they are literal here: only a bind value takes ⓕ, and the statement's ⤢ editor has no reference flyout. The issue list counts every inline-source problem on the Source tab. Not built yet, and owned by **C1q-c**: Table `[▾ from the connection]` (built, below), *Preview* (built, below), *Query timeout* (built, below), bind-value rows derived from the statement's `:name`s (built, below), and a type for a new literal bind value (built, below).

**Built (C1q-c Preview, #1600):** *Preview data* on the Source tab, under an inline Table or Query, answered by `POST /api/datasets/preview`. It is not a second reader: the server dispatches the source store's own `lookup` arm on a synthetic context, so Preview shows what the run would read, through the same read-only reader (sqlite opened read-only, postgres inside `BEGIN READ ONLY`), its row and byte caps and its JSON-safe values, and keeps the first 100 rows. It applies the run's checks (store kind, secret marker, config, shared with the executor as `resolveInlineSource`) and save's literal-SQL rule, so it never shows rows for a source that would be refused. A bind value written as `${}` has no value until a run resolves it, so Preview asks for one in its place (*Preview value for :name*), as ADF asks for parameter values before a preview; a value that reads back as the same number binds as a number, as a resolved `${}` keeps its type. The connection is read as saved: a node's `connectionParams` are not applied, and the form says so. Its concurrency has Test connection's shape in a pool of its own (a slot is held until the real read ends; the caller is answered at 60s). The request is a union on `source.from` so OR10 #1401's saved-dataset preview joins as a second variant.

**Built (C1q-c table list, #1600):** Table `[▾ from the connection]` is a *List tables* button under the Schema and Table boxes, answered by `POST /api/datasets/tables`. It lists on request, as *List sheets* does, never per keystroke, and the boxes stay, so a name the list does not hold can still be typed. Choosing a table writes its schema and name together as one undo step; a list belongs to the connection it was read for and is dropped when that changes. The listing is Preview's read, not a second one: the store's catalogue query runs as an inline Query through the same Lookup arm, gate, caps, pool and backstop. sqlite lists the main database's tables and views from `sqlite_master` without sqlite's own `sqlite_` tables (an FTS or R-tree index's shadow tables are listed; sqlite reads them). postgres reads `pg_class`, as the sink's own catalogue reads do, not `information_schema`, which omits materialized views and lists relations the role cannot SELECT: tables, partitioned tables without their partitions, views, materialized views and foreign tables the role can SELECT, outside the `pg_` and `information_schema` schemas. A list over Lookup's row or byte cap says it is a prefix.

**Built (C1q-c query timeout, #1600):** *Query timeout* is the `query` dataset config's `queryTimeoutSeconds`, ADF's copy-source `queryTimeout` ([PostgreSQL V2 source](https://learn.microsoft.com/azure/data-factory/connector-postgresql#postgresql-as-source): "default is 120 minutes"). It is in whole seconds, the unit of the activity timeout beside it, where ADF takes a timespan. A new inline Query is written with 7200 (`NEW_QUERY_TIMEOUT_SECONDS`), and a query stored without one runs with no limit: applying 2 h at dispatch would limit pipelines that already run, which is the C0f decision's reasoning and §8's rule. The saved dataset form shows the field blank and its `?` says blank means no limit, because ADF's default belongs to the copy source, which is the inline form. Inline it is literal, as the statement is. On a saved dataset it is overridable per node like any key the dataset declares. The clock is wall time from the statement's start to its last row, so it includes the time a copy spends writing between batches, because the cursor is open for all of it. Both readers check it before pulling each batch after the first, so no pull starts past the limit (a read whose rows run out exactly at a batch boundary needs one more, empty pull, which is refused like any other). What bounds the pull in flight differs by store. postgres, in the final stretch (less time left than the connection's statement timeout), runs `SET LOCAL statement_timeout` to the time left, so the server cancels the fetch in flight at the limit, and that cancel is reported as the query timeout (measured against postgres 17, inside `BEGIN READ ONLY`). sqlite steps synchronously and cannot be interrupted, so a batch already being pulled finishes, its last batch included, and a one-batch read such as an aggregate is never cut short. The failure is `transient` with no code, the adapter-timeout convention; `FAILURE_CODES.TIMEOUT` stays the activity timeout's. **Deliberate differences from ADF:** a `table` source has no query timeout here (ADF's applies to any source read), and a stored query with no value has no limit rather than 2 h. `CATALOG_VERSION` 39.

**Built (C1q-c bind values, #1600):** the bind values table is Name · Type · Value, and C1q is complete. *Import from statement* adds a blank text row for each `:name` the statement uses that has no value yet, in statement order and as one undo step, and a status beside it lists the names still unbound. It is ADF's *Import parameter* (the stored procedure source's), and like *List tables* it runs on request, never per keystroke: rows that appeared as the statement was typed would churn the config (`:w`, then `:wm`). A stored row whose name the statement does not use says *Not in the statement, so it is not bound*, which is what the run does (sqlite ignores an extra value; the postgres reader drops it), and Preview no longer asks a value for one. The names come from the store's own lexical rules: the scanner the postgres reader rewrites through moved to shared (`datamove/sql-placeholders.ts`, `scanSqlPlaceholders`), so the table and the reader cannot disagree, and it gained a sqlite dialect, measured on better-sqlite3 and pinned by a test that binds through the driver: `:a`, `@a`, `$a` and `#a` all bind the key `a`, a digit may start a name, `[..]` and `` `..` `` are identifiers, block comments do not nest, and only LF ends a line comment. On postgres an array slice bound such as `[1:hi]` reads as `:hi`, as it does for the reader, so the field's `?` says so. **Type** is Text · Number · Null, one choice per member of the stored union, so every stored value shows its type and every choice stores one: Text stores the box as typed, Number stores a plain decimal (the literal a `number` pipeline parameter accepts) and holds other text with *Enter a number* rather than storing it, and Null stores `null` with no value box. A value written as `${}` is stored as text whatever the type, because a run keeps the type it resolves to, so the type shows *Expression* and is not editable while it is one. The earlier rule (a stored number stayed a number while its text read as one) is gone: with the type explicit, typing `7` into a Text row stores `"7"`.

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
  - **When over the limit**: Truncate and warn · Fail (default Truncate and warn, as today).
- **Outputs:**
  - `firstRow` (first row only), or `rows` + `count`;
  - `content` + `path` (whole-file text);
  - `truncated`, `bytes`.
- **Monitor:** `count` maps to the rows column, which is not mapped today.

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

### 4.4 Delete
Source: [Delete](https://learn.microsoft.com/azure/data-factory/delete-activity).

- **Tabs:** General · Source · Settings.
- **Source:** connection, then Path ⓕ, *Wildcard* ⓕ, *Include subfolders* (default **off**, as ADF), *Modified between*.
- **Settings:**
  - *Max concurrent deletes* (1).
  - **Session log** (same options as Copy): every deleted item, with its status.
  - *Fail if nothing matched* (off).
  - *Delete empty folders* (off).
- **Outputs:** `filesDeleted`, `foldersDeleted`, `logPath`.
- Tables are not deleted here. That is Script.

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
| Get metadata | ✓ list only; **T** full field list + wait | **T** exists, structure, columns, rows | **T** same | — | OR13 | OR15 |
| Delete | ✓ one file; **T** wildcard, folders, dates, log | — (Script) | — (Script) | — | OR13 | — |
| Script | — | **T** | **T** | — | — | OR15 |
| Web | — | — | — | ✓; **T** fail-on-error, cap, callback | — | — |
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
| C7 | Lookup: first-row-only, max rows, over-limit choice, whole-file text. Lower lookup and file_read | — |
| C8 | Get metadata + wait-until. Lower file_list | OR17 #1408 |
| C9 | Delete: wildcard, folders, dates, log. Lower file_delete | OR17 #1408 |
| C10 | Script activity | OR12 #1403, OR15 sql_script |
| C11 | Web: fail-on-error, response cap, parse, retry-after, wait-for-callback. Lower http_request and webhook | — |
| C12 | Set variable operations + pipeline return value. Lower append_variable | OR34 outputs |
| C13 | Palette regroup (§2), retire the remaining old types from the palette (C1b retired Copy file and Move file), `CATALOG_VERSION` bump, the migration guarantees in §8 | — |

**Order:** C0, then C1 (the operator's "copy and copy file" complaint), C7, C8, C9 (cheap consolidations), C11, C12, then C2–C6 as their dependencies (OR10, OR14) land, then C10 and C13. C13 can only land once every retired type has a lowering.

---

## 8. Migration guarantees

- **Lowering at read time.** A stored node of a retired type is presented and dispatched as its replacement:

  | Retired type | Becomes |
  |---|---|
  | `file_copy` | Copy · Files as-is · Keep |
  | `file_move` | Copy · Files as-is · Delete source |
  | `file_write` | Copy · Inline → file |
  | `file_read` | Lookup · Whole file as text |
  | `file_list` | Get metadata · Child items |
  | `file_delete` | Delete |
  | `lookup` | Lookup · not first-row-only, so today's `rows` shape is kept |
  | `http_request` | Web · Fail on HTTP error **off**, so today's behaviour is kept |
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
  - **Allow writes.** A saved lowered node is a real `copy_files` and needs Allow writes on its connection. The Problems list warns while the connection lacks it, for every Files as-is copy, so the author hears it before the run refuses.
- **Output aliases.** Old output names stay readable. For example `nodes.x.output.entries` (List Directory) resolves to `childItems`, and `output.content` from Read File works on the Lookup. Each lowering declares its aliases, and a unit test checks every retired output name. Copy file and Move file need no renaming: Files as-is yields `bytesWritten`, `source` and `dest` under the same names and types (C1b).
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
