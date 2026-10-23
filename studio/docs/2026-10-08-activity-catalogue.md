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
| Timeout | duration (`D.HH:MM:SS` or seconds) | 12 h (workspace setting) | **Enforce it** (done in C0a; it was stored but unenforced, F3). Expiry fails the attempt with `timeout`, which can be retried, unless the activity may already have changed the store: then it is permanent (#1804) |
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
- **Monitor:** the activity runs grid adds one column per distinct name across the run's rows, after the fixed columns, in first-seen order. A cell shows the value, `Not resolved: <error>` in the error colour, or the secure marker. Group and iteration lines are padded. The grid's search matches what those cells say. A row a rerun reused has no `node.dispatched` of its own, so its cells are empty.
  - **Built (#1673 part 1):** an attempt that failed before dispatch (a missing connection, a secret that would not resolve, a cancel during preflight or while queued behind the per-run cap) records the resolved properties on its `node.failed` instead, stamped by one seam in the driver around every dispatch stream, so its cells read as a dispatched attempt's would. Redacted on a secure node as `node.dispatched` is. Not scrubbed against the attempt's held secrets as the dispatched copy is, because the save already refuses a secret ref or a secure-output read in a value. A failure after dispatch does not repeat them. Not covered: a pre-flight that throws instead of failing, which writes no `node.failed` at all.
- No `CATALOG_VERSION` bump (the ledger in `schemas/version.ts`).
- **Not built yet:** user properties on control activities, pipeline calls and containers, and on a row a rerun reused (each needs a record other than `node.dispatched`), tracked in #1673; Copy's own tab and *Auto-generate*, which belong with the Copy slices.

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

The run reads `col > old AND col <= new`, and outputs `watermark.old` and `watermark.new`. For files, Incremental = *Modified since last successful run* (Automatic); the explicit window is Load Full with *Modified between* (C5b, below).

**Built (C5a, #1600): Load Incremental for a rows Copy from a database source** (SQLite or PostgreSQL, a table or a query, saved or inline). ADF has no Load toggle; its [incremental copy](https://learn.microsoft.com/azure/data-factory/tutorial-incremental-copy-overview) is a Lookup, a Copy and a Stored procedure, which *Expression* keeps and *Automatic* folds into the Copy.
- **Fields** (Source tab, first among its settings, after the source block): *Load* (`load`, `full` · `incremental`, absent is Full), *Watermark column* (`watermarkColumnName`, literal, §8), *Watermark from* (`watermarkFrom`, `automatic` · `expression`, absent is Automatic, which the dock shows as *Automatic (default)*) and *Old watermark* (`watermarkOld`, ⓕ, Expression only). Load and Watermark from are literal: they decide which fields are required and whether studio stores a watermark. The column is a text box: the `[▾ source columns]` list needs OR10 #1401's schema import.
- **The read:** new = `max(col)` over the source rows above old (every row when old is null). Nothing above old reads nothing and keeps new = old, so the watermark never moves back. Otherwise the copy reads `old < col <= new`, the source statement wrapped as a subquery. A `;` that ends the statement is dropped; one followed by a comment is not (telling it from a `;` inside a string or comment needs the store's lexer), so that statement fails as a syntax error, never silently. The new watermark is read before the sink opens, so a bad column refuses with nothing written. **No shared snapshot**: the read is bounded by new, so a row committed between the two statements is copied now rather than missed. **Caveats** (in the column's `?`): a NULL watermark is never copied, a row committed late with a value at or below the last watermark is never copied, and a row Skip incompatible rows drops is not retried.
- **Values:** compared in the source store, in the column's type. PostgreSQL reads the max as the server's text under `DateStyle` ISO and `extra_float_digits` 3 (exact for a float before postgres 12 too) and binds both bounds untyped, so a timestamp keeps its microseconds; smallint, integer and bigint within 2^53 are numbers, everything else text. Accepted column types: the integers, numeric, real, double precision, date, timestamp (with and without time zone), time, text, varchar and char; `money`, `boolean`, `uuid`, `json` and the rest are refused. The query timeout, when the source has one, bounds the max too. SQLite gives integers and reals as numbers and text as text, and refuses an integer past 2^53, an infinite real and a blob. An Expression old watermark is bound as it resolved: text compared with a computed (not a plain) column of a SQLite query has no affinity, so it compares as text.
- **`watermark` output:** `{column, old, new}`, under Incremental only, so a Full copy's outputs are exactly what they were. On a failure only when the sink committed: a rolled-back copy's `new` would read as copied up to a value nothing landed for, and a failure branch writing it to a control table would skip rows. **Deliberate addition:** `column`, beside the spec's old and new, so the run log says which column the values belong to.
- **Automatic** stores the new watermark in `copy_watermarks` (migration 0050), not the run log: deleting a run, pruning debug runs or a secure output's redaction would otherwise lose it and re-copy every row. One row per pipeline (across its versions), doc node and **copy**, a hash of the resolved source (connection, dataset kind and config, bind values included, the query timeout not), the column and the resolved sink (connection, dataset kind and config). So one node reading different sources (a `${}` connection, a parameterised query, a child pipeline called with other parameters) keeps a watermark per source, and changing the source, the column or the sink table starts from nothing. A bind value that changes on every run (today's date) therefore makes every run a new source: put a moving bound in the watermark instead. A connection edited in place keeps its id and so its watermark. Switching to Full and back resumes from the stored watermark. The copy stores it the moment its sink commits, so "the last successful run" means the last copy that committed, even if a later node failed, and a folder log that then fails to close does not leave it behind. It is stored as the write finishes, before the copy reports anything, so a run torn down at that moment keeps it too. A watermark that cannot be stored fails the node and says the rows are committed. **At least once, not exactly once:** the sink's commit and the store are two writes, so a server lost between them, or a commit acknowledgement lost after the rows landed, copies those rows again. Debug runs count: their sink writes are real.
- **One copy per source at a time:** the executor holds an in-process lease on the key from reading the old watermark until the attempt ends. A second attempt on the same copy fails `transient` with `copy_watermark_busy` rather than copying the same rows twice; a retry policy or the next run copies once the first ends. The lease is held while the attempt waits for a run slot too, and an attempt that hangs holds it until its activity timeout (new activities get the workspace default, 12 h).
- **Save refuses:** the watermark fields under Full, Incremental without a column, an expression in the column, Expression without an old watermark, an old watermark under Automatic, Incremental with Partition option Dynamic range (one reader), and **Automatic inside a ForEach or an Until**, at any depth (an iteration does not identify what it copied; Expression with a watermark per item works there). A rows Copy from a file source still refuses Load Incremental at dispatch: it reads one file, and files are a Files as-is copy's (C5b, below).
- `CATALOG_VERSION` 70.

**Built (C5b, #1600): Load Incremental for a Files as-is copy, *Modified since last successful run*.** ADF's equivalent is the Copy Data tool's [*Incremental load: LastModifiedDate*](https://learn.microsoft.com/azure/data-factory/tutorial-incremental-copy-lastmodified-copy-data-tool), which drives `modifiedDatetimeStart`/`End` from a tumbling window; studio stores the window's end itself, as C5a's Automatic does.
- **Fields:** *Load* (`load` on `copy_files`, `full` · `incremental`, absent is Full, literal), on the Source tab directly after the required Source path. There is no Watermark from, column or old value: line 161's "or the explicit *Modified between* window" is **Load Full with Modified between**, the Expression form for files, so under Incremental the dock hides Modified from and Modified before and save refuses them.
- **The window** is `[old, cutoff)`, start inclusive and end exclusive like Modified between. The cutoff is taken before anything is listed and **2 s behind the clock** (`COPY_FILES_SETTLE_MS`): FAT and exFAT round modified times to 2 s and a kernel's file timestamps can trail its clock, so a file written just after the listing could otherwise carry a time below the cutoff. A file changed within the margin is the next run's. Successive windows meet with no gap and no overlap. The first run has no old time and copies every file below the cutoff. A window that selects nothing keeps the stored time (new = old), as a rows Copy with nothing above its watermark does, so the next window starts where it did. A clock set back since the last run (old ≥ cutoff) selects nothing and keeps the stored time too, so it never moves back. The window is Modified between's own (`modifiedWindow`), read against the later of the two times.
- **A file's time is the later of its modified and status-change times.** **Deliberate difference from ADF**, which compares LastModifiedDate only: a rename or a move into the folder keeps the modified time, so a file written as `x.tmp` and renamed `x.csv`, one moved in from elsewhere, or one unpacked with its times kept would sit below the last cutoff for good. The status-change time also moves when a file's permissions or links change, which copies it again: a duplicate, never a miss. Load Full's Modified between still reads the modified time only.
- **Stored** in `copy_watermarks` (C5a's table, no migration) under the column `lastModified`, keyed by pipeline + node + a hash of the parsed config's selection (source connection, path type, path, wildcard, subfolders, file list) and destination (sink connection, folder, file name, copy behaviour), as resolved for the run and tagged `files`. So a `${}` folder keeps a time per folder, and how the copy runs (If file exists, After copy, parallelism, the log) does not move it. **A sink folder that changes every run (a dated folder) is a new key each time and copies every file**: the safe polarity, chosen over keying on the unresolved text, which would let one node writing to several destinations by parameter skip files at the second. The Load `?` says so. Stored the moment every selected file is written, before the folder log closes; a run where any file fails stores nothing, so the next run selects the same window again (If file exists decides what an earlier attempt left). A time that cannot be stored fails the node `permanent` with the counts, saying the files were copied. Same lease as C5a: an overlapping attempt fails `transient` with `copy_watermark_busy`.
- **Output:** `watermark` = {old, new} as ISO instants (old null on the first run), under Incremental only, and only once the window is finished: on a success, and on a failure after every file was written (a time that could not be stored, whose error says so, or a folder log that could not be closed). No `column`: a files copy has none.
- **Save refuses:** an expression in Load, Modified from or before under Incremental, **Merge** under Incremental (its one file would hold only the newly changed files: Overwrite would lose the earlier ones and Skip would never add the new), **Flatten** under Incremental (it names a file by its name alone and a run sees only its own files, so `b/x.csv` would overwrite the `x.csv` an earlier run copied from `a/`, a clash Load Full refuses because it sees both), and Incremental inside a ForEach or an Until (Load Full with Modified between per item works there).
- **Caveats** (the Load `?` names the per-folder key; the rest are here): a file whose times are both set into the past is never copied; under If file exists = Skip, a changed file whose earlier copy is in the sink is skipped and the time moves past it, as under Full it is never updated; under Fail, a run that failed part-way leaves files a retry then fails on; a file in a *subfolder* that Skip forbidden files skipped is not retried when the folder is opened up (a forbidden *file* is, because `chmod` moves its status-change time); a file Skip inconsistent files skipped changed after the cutoff, so the next run copies it. A network share whose clock is more than the margin behind the server's can hide a file. A sink folder inside a recursive source copies its own copies, as under Full.
- `CATALOG_VERSION` 70→71.

**Sink:**

| Sink is | Fields |
|---|---|
| Database | **Connection** as above. **Table** `[▾ existing]` ⓕ, or **Table option** *Auto-create from mapping*, which generates DDL with quoted identifiers and types from the mapping. **Write behaviour** Append · Overwrite (delete then insert, one transaction) · Truncate then insert · Upsert (Key columns `[▾ multi]`, default the primary key). **Pre-copy script** (SQL, runs once; literal with ⓕ bind values, see C3b below). Batch size (default 1000) |
| Files | **Folder** ⓕ, **File name** ⓕ (or prefix plus *Max rows per file*, Rows mode). **Copy behaviour** Preserve hierarchy · Flatten · Merge into one file (Files as-is plus folder sources). **If file exists** Overwrite · Skip · Fail (default Overwrite). In Rows mode only: **Format** (Delimited, later JSON / Parquet OR14) with its write options |

**Built (C3a, #1600): Write behaviour on a database sink** ([Azure SQL Database as a sink](https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database#azure-sql-database-as-the-sink): `writeBehavior`, `upsertSettings.keys`).
- **Stored as `mode`**, which held Append and Overwrite before C3a, so no saved copy changes its content hash: `append` · `overwrite` · `truncate` · `upsert` (`COPY_WRITE_MODES`). Absent is Append. The field is titled *Write behaviour*, a literal enum.
- **Overwrite** deletes the rows, then inserts, in one transaction. **Truncate then insert** runs the store's TRUNCATE inside the same transaction. On PostgreSQL that needs the TRUNCATE privilege, fires no delete triggers, refuses a table a foreign key references (the refusal says to use Overwrite) and holds `ACCESS EXCLUSIVE` until the copy commits. SQLite has no TRUNCATE, so there it is Overwrite's `DELETE`, which cascades per the schema's `ON DELETE`. The field's help says so.
- **Upsert** updates the rows whose **Key columns** match and inserts the rest. Key columns are `keyColumns`, literal column names (§8; the write gate refuses a `${}`), each a mapped sink column. Empty means the table's primary key, every column of which must be mapped. The keys need no unique constraint.
  - **Save refuses:** Key columns on any other behaviour, a key no mapping row writes, a key named twice, and a key whose mapping row writes NULL on a conversion error. Names compare as strings, as the duplicate-sink rule does. The sink resolves them by the store's case rule (`resolveSinkColumns`).
  - **Deliberate difference from ADF: a NULL key fails the copy** and rolls it back, naming the row. `=` never matches NULL, so inserting it would add a row on every rerun. A null-safe match was rejected because PostgreSQL can neither index nor hash-join `IS NOT DISTINCT FROM`.
  - **SQLite:** per row, a `SELECT` for the key, then `UPDATE` or `INSERT`. Explicit keys with no index scan the table for each row (#1126's bound).
  - **PostgreSQL:** `SHARE ROW EXCLUSIVE` (so concurrent writers cannot race the match; readers are not blocked), a session-private staging table typed like the target, then per chunk one `UPDATE … FROM` and one `INSERT … WHERE NOT EXISTS` over `DISTINCT ON (keys)`. It needs SELECT on the target and TEMP on the database. `INSERT … ON CONFLICT` needs a unique index matching the keys, and `MERGE` refuses a target with rules and needs PostgreSQL 15.
  - **A key repeated in the source:** the last row wins on both stores. `rowsWritten` is the store's own count of rows inserted plus rows updated. So the stores count repeats differently: SQLite counts every write (an insert, then its updates); PostgreSQL counts a key once per chunk, so a repeat in a later chunk counts again as an update.
- **Deliberate difference from §4.1's `[▾ multi]`:** Key columns is a one-per-line list in C3a, since a choice list needs the sink's columns in the form. The choice list is #1768, to land with the mapping redesign (C4), which imports the sink schema.
- **A `${}` Write behaviour** is decided at dispatch, so save does not refuse Key columns beside one.
- **The default key is the primary key's key attributes only.** A `PRIMARY KEY … INCLUDE` column is not part of it.
- **PostgreSQL stages with a column named `studio_copy_ord`**, so a mapping that writes a column of that name is refused under Upsert.
- **Truncate then insert from a query that reads the same table waits on itself.** Its `ACCESS EXCLUSIVE` lock conflicts with the source cursor, so the copy waits until the activity timeout ends it. Nothing is truncated. Use Overwrite there.
- The canvas card names the behaviour: `· overwrite`, `· truncate`, `· upsert on id`. `CATALOG_VERSION` 55→56.
- **Not built here:** *Auto-create from mapping* (C3c) and *Skip incompatible rows* (built in C6d-1, below; it excludes Upsert). Pre-copy script and Batch size are C3b, below.

**Built (C3b, #1600): Pre-copy script and Batch size on a database sink** ([Azure SQL Database as a sink](https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database#azure-sql-database-as-the-sink): `preCopyScript`, `writeBatchSize`). Both are on the Sink tab, after Write behaviour, in ADF's order.
- **Pre-copy script** is `preCopyScript`, one SQL statement run once per copy, before the first row and even when the source has none.
  - **Literal, a deliberate difference from this row's ⓕ** (C1q-b made the same correction for the Query source): save refuses a `${` in it (`preCopyScriptIssue`), and the reducer hands it to the sink unsubstituted (`prepInput`), so a value can never become SQL, even in a doc that reached the store without passing save. The dispatch schema refuses a raw `${` too.
  - **Bind values** are *Pre-copy bind values*, `preCopyScriptParameters`: rows of `:name` and a value that takes ⓕ. A value is text unless a `${}` gives a number or null. The rows are the generic key/value control, not C1q-c's typed Name · Type · Value table. They show once the script has text (`appliesWhen` condition `set`), which keeps the fresh Sink tab whole at 1440x900. Save refuses bind values with no script. A `:name` with no value is refused at dispatch, by the store's own lexer, before the statement runs.
  - **Inside the copy's transaction**, so a failed copy undoes it. It runs before Write behaviour: Overwrite and Truncate then insert also delete what it inserts.
  - **Where in the transaction:** SQLite, right after `begin immediate` and before the table is described, so a column it adds can be written. PostgreSQL, after the write behaviour's `LOCK TABLE` and before the describe. A script cannot create the sink table on PostgreSQL, because the lock needs it; C3c's *Auto-create* creates it before the lock.
  - **Residual, PostgreSQL locks:** a script that needs a stronger lock on the sink than its write behaviour takes (ALTER, DROP or TRUNCATE under Append, Overwrite or Upsert) upgrades it inside the transaction, so two such copies at once can deadlock; PostgreSQL ends one with `40P01`, which is transient and retried. Like Truncate then insert, a script that locks the table a query source is reading waits on itself until the activity timeout.
  - **One statement, and an allow-list on the statement it begins with** (`PRE_COPY_SCRIPT_STATEMENTS`). Text that does not begin with a word (a leading `;`, a `(`) is refused.
    - **SQLite: INSERT, UPDATE, DELETE, REPLACE, CREATE, DROP, ALTER, WITH.** This is the file-confinement boundary. Measured on better-sqlite3 12: `ATTACH` runs inside the write transaction and opens any existing database file the process can reach, and the sink's dataset may then name that schema; `VACUUM INTO` writes a file. Neither is listed, nor is `PRAGMA`. better-sqlite3's `prepare` refuses a second statement. After the script, the sink checks that nothing is attached and fails the copy if anything is.
    - **PostgreSQL also takes MERGE, TRUNCATE, SELECT, CALL and DO.** Here the credential is the authority, and the list keeps the script inside the copy's transaction by excluding transaction control. The script is sent over the extended protocol even with no bind values, so the server refuses a second statement (`delete …; commit`). An effect PostgreSQL does not roll back (a sequence, `dblink`) survives a failed copy and its retry.
    - **Deliberate difference from ADF**, whose script may hold several statements: several statements are separate Script blocks (C10a). Text with a `;` inside a statement body (`CREATE TRIGGER … BEGIN …; END`) runs on SQLite, where `prepare` reads it as one statement.
  - A synchronous SQLite script that runs long blocks the server for its duration, as a large Overwrite does (#1126).
- **Batch size** is `writeBatchSize`, 1 to 10,000 rows (`COPY_MAX_BATCH_ROWS`). Empty is 1000 (`COPY_DEFAULT_BATCH_ROWS`), the batch every copy used before, so a stored copy is unchanged (§8). The pump passes batches through one for one, so it is the rows per read and per write batch: PostgreSQL inserts a batch in one statement (still split at its 65,535 bind parameters), SQLite yields to the event loop and checks for a cancel between batches, and a query source's timeout is checked between them. It is a literal number like every numeric field today; ⓕ on numbers is OR38 #1573. It sits on the Sink tab rather than a Settings · Performance group, which C6 builds.
- `CATALOG_VERSION` 56→57: the copy dispatch schema is not strict, so a pre-C3b build would ignore the script.

**Built (C3c, #1600): Table option *Auto-create from mapping* on a database sink** ([Azure SQL Database as a sink](https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database#azure-sql-database-as-the-sink): `tableOption`, `none` or `autoCreate`). It is the first field on the Sink tab, before Write behaviour, as in ADF.
- **Stored as `tableOption`**: `none` (*Use existing*, the default, so absent changes nothing) or `autoCreate` (*Auto-create from mapping*). `COPY_TABLE_OPTIONS`.
- **When the table does not exist, the copy creates it** from the mapping's sink names and declared types, in mapping order, inside the copy's write transaction, so a failed copy undoes the create. An existing table is used as it is: nothing is added, altered or retyped.
- **Every column is nullable and there is no primary key.** The mapping declares neither. So Upsert into a table Auto-create has just made needs Key columns; with none it is refused by the existing *no primary key* rule, and the create rolls back with it. A save refusal would be wrong, because an existing table with a primary key makes that combination valid.
- **Types** (`AUTO_CREATE_COLUMN_TYPES`, a record over the closed `DataType` set, so a new type does not compile until both stores name it):

  | Type | SQLite | PostgreSQL |
  |---|---|---|
  | string | TEXT | text |
  | integer | INTEGER | bigint |
  | number | REAL | double precision |
  | boolean | INTEGER (1/0) | boolean |
  | date | TEXT (ISO date) | date |
  | timestamp | TEXT (ISO instant) | timestamptz |
  | binary | BLOB | bytea |

  PostgreSQL's `timestamptz` because a coerced timestamp is a UTC instant (`toISOString()`, with its `Z`). `bigint` holds every integer the matrix produces, a `bigint` past 2^53 included. A SQLite boolean is stored as 1 or 0, which the coercion matrix does not read back as a boolean (a number is not one), as for any SQLite boolean column today.
- **Column names are quoted by the sink's own quoter**, so a name the sink can write into an existing table can also be created: on SQLite any text (`Full Name`), on PostgreSQL a bare identifier, as its sink already requires.
- **Save refuses two sink names that differ only by case** under Auto-create (`autoCreateCollisionIssue`). The mapping otherwise compares names as strings (#1151), which suits an existing table, where the sink resolves names by the store's rule. A new table has no rule to defer to: SQLite refuses the pair as a duplicate column, and PostgreSQL creates both and the sink cannot tell them apart. One helper (`copyTableOptionIssue`) runs on the canvas, at the #444 write gate (so a git-imported or POSTed version too) and in the dispatch schema, where a `${}` Table option is checked once resolved; the sinks' DDL builder checks again for a direct caller.
- **PostgreSQL refuses a schema, table or column name over 63 characters**, which the server would silently truncate.
- **Order in the transaction: create, then the Pre-copy script, then the describe.**
  - SQLite: right after `begin immediate`, as `CREATE TABLE IF NOT EXISTS`. A view of the same name makes it a no-op, and the describe then refuses the view as before. A schema other than `main` is refused (`unknown database`), since the connector attaches nothing.
  - PostgreSQL: after `BEGIN` and before the write behaviour's `LOCK TABLE`, which needs the table. This settles C3b's residual: a PostgreSQL sink table can now be created, by the Table option rather than by a script.
  - So a Pre-copy script can alter the new table, and is described after it does. A script that itself creates the table fails with *already exists* under Auto-create.
- **PostgreSQL checks with `to_regclass`, not `CREATE TABLE IF NOT EXISTS`.** For an unqualified name, `IF NOT EXISTS` checks only the schema the table would be created in (the first in `search_path`). With `search_path = s_b, public` and an existing `public.t`, it would create `s_b.t`, and the copy would write into a new empty table instead of the one the name resolved to. `to_regclass` is the resolution the LOCK and the describe use.
- **Two copies auto-creating one PostgreSQL table at once:** the check runs under an advisory lock, so the second copy waits, then finds the table.
  - The key is the RESOLVED `schema.table` (`autoCreateLockKey`: 8 bytes of a SHA-256, computed in studio rather than with the server's undocumented `hashtext`). An unqualified name's schema is `current_schema()`, where CREATE puts it, so `t` and `public.t` share one lock.
  - **The lock comes before any lookup of the name.** Measured in CI on the first design, which looked the name up, then locked and looked again: a copy that waited on one creating the table still missed it after that one committed, and its CREATE failed with *already exists*. The likely mechanism is the backend's catalog cache keeping the first miss within the transaction; one lookup, after the lock, leaves nothing to keep.
  - **Session-scoped:** a table that exists releases the lock at once, so copies into an existing table do not serialise. A copy that creates the table holds it to its COMMIT or ROLLBACK, then releases it explicitly (ending the session would release it too).
  - The wait polls `pg_try_advisory_lock` every 100ms rather than blocking, so a cancel or the activity timeout ends it. A blocking wait would hold until the other copy's whole write has committed. With no signal it still ends at the connection's statement timeout (default 30s), as the LOCK TABLE after it would, and fails transient as that LOCK's own timeout does (57014): nothing has been written and the transaction rolls back, so the retry finds the table once the creator commits.
  - Not covered: a table created outside studio between the check and the CREATE (the CREATE then fails, permanent), and a type of the same name with no table (*type already exists*). Creating needs CREATE on the schema; a refusal is the server's words, permanent.
- **Not built here:** primary keys, NOT NULL and defaults on the created table, and adding mapped columns to an existing one. A sink dataset's declared columns still drive the dispatch NOT NULL check (#1162), whatever the created table holds.
- `CATALOG_VERSION` 57→58: the copy dispatch schema is not strict, so a pre-C3c build would ignore the option and refuse the copy for a missing table.

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
| Data consistency | *Verify after copy*: row counts (Rows; not with Upsert) or size + modified time (Files as-is) | off |
| Performance | Degree of copy parallelism (files: C6f-2, built, first on the Settings tab as in ADF; partitioned reads: C6f-3, built, with *Partition option* on the Source tab), Batch size (on Sink) | 1 / 1000 |
| Session log | **Logging** Off · Warnings (skipped rows and files) · Everything (every file and row batch). **Log mode** Best effort · Reliable (C6c-2). **Write to** connection + folder ⓕ, or *Run log* (kept with the run, capped). | Warnings to the run log, Reliable |

**Outputs:** `rowsRead`, `rowsWritten`, `rowsSkipped`, `filesRead`, `filesWritten`, `filesSkipped`, `filesDeleted`, `filesMoved`, `bytesRead`, `bytesWritten`, `durationMs`, `throughput` (bytes/s), `watermark` {old, new}, `logPath`, `consistency` {verified, result}, `usedParallelCopies`. Files as-is (C1a) yields the file and byte counters only, never the row outputs: a `rowsWritten` of 0 would read as "wrote nothing" in the run's rows total. A file list may be merged too, in the list's order. Files as-is also yields `source` and `dest` (C1b), the canonical source file or folder and the file written (one file or a merge) or the sink folder. They are the retired Copy file / Move file outputs, so a lowered node's refs still resolve (§8).

**Built (C6a, 2026-10-20):** a rows Copy's session log, to the run log. It is the Settings tab's first field, after Mapping as in ADF ([session log](https://learn.microsoft.com/azure/data-factory/copy-activity-log)).
- **Setting:** *Session log* Off · Warnings · Everything (`logLevel`). It is Delete's field from `catalog/session-log.ts`, with the same default (Warnings), titles and help (its help now says "what was skipped or kept", which reads for both). *Write to* and *Log folder* came with C6c-1b (built below).
- **Lines:** *Warning* `TabularRowSkip` is ADF's name for each row the copy skips. It is a row whose value a column's *If it won't convert* (`onError` fail) cannot convert, or (C6d-1, below) a row the sink rejects under *Skip incompatible rows*. The item is `row N`, numbered from 1 among the rows read, so a CSV header is not counted. The message is the coercion code, the sink column and the reason. The reason never holds the value (`coerce.ts`), so no row data reaches the log. *Info* `TabularRowBatch` is §4.1's "every row batch": one line per batch, `rows a-b`, `read N rows, M skipped`. It never says "written", because the sink's running total is not committed truth. A batch the sink fails on gets its skip lines but no batch line, because that line is added once the sink has taken the batch. The `COPY_ROWS_FAILED` advisory now numbers its first failure from 1 too, so a row has one number.
- **Run log:** the lines are `node.output sessionLog`, yielded at the terminal and never streamed, because a running row's latest output is its progress hint. A failed copy keeps the lines it logged, ahead of its counters, and a cancel unwinds the same way. They are kept as they are added, at most `SESSION_LOG_RUN_MAX_LINES` (`SessionLog`'s `keepAtMost`). A copy can skip every row it reads, so the rest are counted, not held. The last line says how many were not kept, and (since C6c-1b) that a folder keeps every line. The first lines are kept whatever their level, so at Everything a long copy's batch lines (one per 1,000 rows by default) can fill the run log before a late skipped row. Warnings keeps only the skips, and C6c's folder keeps every line.
- **No Error line in the run log:** a copy's failure is the node's error, which the Logs tab already shows. Delete adds one only for the item it failed on. A folder log does end with one (C6c-1b, below).
- **Secure flags:** as Delete's, `redactSecureEvent` withholds `sessionLog` lines under either flag, by the output's name (`secure.ts`).
- **The Logs tab** shows a value whole, up to 4,000 characters (`MAX_LOG_VALUE_CHARS`), rather than at the 80-character inline cap. A session log line runs past 80 characters, and Delete's were being cut the same way. It shows 200 lines at a time, opening on the newest, and pages back to the first (*First* · *Earlier* · *Later* · *Latest*); a *Name* filter narrows it to `sessionLog` when the attempt streamed other names too (#1772). Download has every line.
- **The dock's tab strip wraps** to a second row when it is wider than its dock, rather than clipping a tab. Copy's five tabs are wider than the right-hand dock at 1440x900 (`activity-tabs.spec.ts` asserts every tab is inside the strip).
- **Deliberate differences from ADF:**
  - The item is the row number, not the row's content.
  - `onError` null substitutions are not logged, because the row is kept.
- No new output and no `CATALOG_VERSION` bump. A pre-C6a build strips `logLevel` and copies the same rows, so only the log lines are lost (the ledger's no-bump entry).
- **Not built here:**
  - **C6b:** files-as-is lines: `FileRead`, `FileWrite` and `FileSkip` (built, below).
  - **C6c:** *Write to* a folder, which needs a log connection binding of its own. A database-to-database copy has no file system connection, and ADF's `logLocationSettings` names a linked service. C6c also brings `logPath`, an appending writer and *Log mode* Best effort · Reliable. Split: **C6c-1a** the log connection, the appending writer and Files as-is's folder log with `logPath` (built, below); **C6c-1b** a rows Copy's folder log and `logPath` (built, below); **C6c-2** *Log mode* Best effort · Reliable (built, below).
  - **C6d:** fault tolerance: **C6d-1** the rows the sink rejects (built, below); **C6d-2** a files-as-is Copy's *Skip missing files* and *Skip forbidden files* (built, below).
  - **C6e:** consistency: **C6e-1** a rows Copy's *Verify after copy* (built, below); **C6e-2** Files as-is's *Verify copied files* and *Skip inconsistent files* (built, below).
  - **C6f:** **C6f-1** the complete outputs (built, below); **C6f-2** Files as-is parallelism (built, below); **C6f-3** a rows Copy's partitioned reads (built, below).

**Built (C6b, 2026-10-20):** a files-as-is Copy's session log, to the run log, with ADF's file operations ([session log](https://learn.microsoft.com/azure/data-factory/copy-activity-log): `FileRead`, `FileWrite`, `FileSkip`).
- **Setting:** the same *Session log* field (`logLevel`, default Warnings) on a new Settings tab after Sink, as on a rows Copy. Switching the *Copy mode* restarts it at its default, as it does every other setting.
- **Lines:**
  - *Info* `FileRead`: one per source file, `read N bytes`. The item is the file's path under the source path.
  - *Info* `FileWrite`: one per file written, `wrote N bytes from '<source>'`, or `wrote N bytes merged from K files` for a merge. The item is the file's path under the sink folder.
  - *Warning* `FileSkip`: one per source that *If file exists* = Skip left uncopied, saying whether the target already existed or appeared during the copy. Under After copy Delete or Move it also says either that the source is kept, or that the target already holds the file's bytes so After copy still applies (the retry that converges, #1685).
- **When:** a read and its write are logged together, once the write has landed, beside the counters they match, so a line never claims a file the counters do not. A skip is logged even when its byte comparison fails part-way, because it has already been counted.
- **Run log:** the same rule and cap as a rows Copy, with lines yielded at the terminal and ahead of a failure's counters. Everything logs at least two lines per file (a merge of K files logs K + 1), so a copy of more than 500 files fills the run log, and a later `FileSkip` is counted in the last line rather than kept. Warnings keeps only the skips, and C6c's folder keeps every line.
- **Deliberate differences from ADF:**
  - One line per read and per write, at completion, rather than ADF's start and complete pairs. The `FileRead` timestamp is therefore the write's.
  - The message holds the size, not the file's metadata.
  - The After copy delete or move is not logged. It is not one of ADF's copy-log operations, and `filesDeleted` and `filesMoved` count it.
- **No Error line**, as on a rows Copy. Here the reason is that the node's error names the file the copy failed on.
- **The run-log loop is one helper.** Delete, a rows Copy and a files Copy now yield their lines through `sessionLogRunEvents` (`connectors/activity-events.ts`), rather than three copies of the loop.
- No new output and no `CATALOG_VERSION` bump: `copyFilesConfigSchema` is not strict, so a pre-C6b build strips `logLevel` and copies the same files (the ledger's no-bump entry). A lowered `file_copy` or `file_move` gets the default but always overwrites, so it never skips and logs nothing.
- **Not built here:** `FileSkip` for missing or forbidden files, which is fault tolerance (C6d-2, built below). A line holding a space or a newline in a file name is ambiguous in the run log's space-separated form, as Delete's is; C6c-1a's CSV file (built below) is the unambiguous form.

**Built (C6d-1, 2026-10-20):** a rows Copy's *Skip incompatible rows*, the Settings tab's first field, before the Session log as in ADF ([fault tolerance](https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance): `enableSkipIncompatibleRow`, default false).
- **Setting:** `skipIncompatibleRows`, a literal boolean, default off (ⓕ on typed fields is OR38 #1573). Save refuses it with Upsert (`copySkipIncompatibleIssue`, on the field and at the #444 write gate), because ADF's "doesn't apply" with Upsert and studio's PostgreSQL Upsert writes each chunk as one set statement. A `${}` Write behaviour is left to dispatch, where the dispatch schema sees the resolved value. The dock does not draw it under Upsert (`appliesWhen`), unless it holds a value or the Write behaviour is a `${}` (UI standard rule 3). Both sinks refuse it with Upsert too, before any lock is taken, which is where a `${}` mode that resolved to Upsert is caught (`SKIP_INCOMPATIBLE_UPSERT_REFUSAL`, one sentence for all three).
- **What is skipped:** a row the sink database rejects, which is ADF's primary key violation and type incompatibility with the sink's native type:
  - SQLite: every `SQLITE_CONSTRAINT` code but a trigger's (a duplicate key, NOT NULL, CHECK, an immediate foreign key, a STRICT table's datatype), `SQLITE_MISMATCH` and `SQLITE_TOOBIG`.
  - PostgreSQL: SQLSTATE class 22 (data exception, such as a value too long or an integer that does not parse) and class 23 (integrity constraint violation).
  - A conversion failure on the source side is already a skipped row, under *If it won't convert*.
- **How:**
  - SQLite takes a savepoint per row (measured about 0.6 µs a row, 32 ms to 96 ms per 100,000 trivial inserts). A rejected row is undone whole, including a BEFORE trigger's writes and a `FAIL` conflict's partial effects.
  - PostgreSQL runs each batch's INSERT under a savepoint. Only when it fails on class 22 or 23 is the batch rolled back to it and replayed row by row, each row under its own savepoint, with the cancel checked per row.
  - Off, both stores write exactly the statements they wrote before C6d.
- **Not skipped, and the copy fails as before:**
  - A trigger's rejection, so the two stores agree:
    - SQLite's `RAISE(ABORT)` (`SQLITE_CONSTRAINT_TRIGGER`).
    - PostgreSQL's `RAISE EXCEPTION` (P0001).
    - A class 22 or 23 error raised inside a PostgreSQL function, which is a trigger's `RAISE … USING ERRCODE` or its own write elsewhere. It carries a `where` naming the function (measured: `PL/pgSQL function f() line 2 at RAISE`). A row's own error has no `where`, or one naming the bound parameter (`unnamed portal parameter $1 = '...'`).
  - A constraint declared `ON CONFLICT ROLLBACK`, or a trigger's `RAISE(ROLLBACK)`. Either ends SQLite's whole transaction (measured), so it is checked before anything else.
  - Any other failure.
  - A deferred constraint, which fails at COMMIT.
- **Counted and logged as a coercion skip is:**
  - `rowsFailed` and `COPY_ROWS_FAILED`'s tally count it under the code `sink_rejected` (C6f-1 adds ADF's `rowsSkipped`, the same number, below).
  - It is a *Warning* `TabularRowSkip`, `row N`, numbered as the source row it came from. The pump hands the sink each batch's read indices (`onSinkBatch`), and a sink finishes a batch before it pulls the next.
  - The message is `sink_rejected: into '<table>': <reason>`.
  - The batch line's "M skipped" includes it.
  - The pump coerces a whole batch before the sink sees it, so within a batch a sink line can follow a later row's coercion line. The advisory's "First at row" is the lowest row either way (`recordCopyRowFailure`).
- **No row data in the reason:**
  - SQLite's message names the table, column or CHECK expression, never the value (measured: `UNIQUE constraint failed: orders.id`).
  - PostgreSQL's reason is built from the SQLSTATE, its condition name, the constraint and the column only (such as `23505 unique_violation, constraint 'orders_pkey'`). The message and the detail quote the value (`invalid input syntax for type integer: "abc"`, `Key (id)=(2) already exists.`).
- **Residuals:**
  - A copy whose every row is rejected succeeds having written nothing, as in ADF. `COPY_ROWS_FAILED` says how many rows were skipped and why, and `rowsFailed` can be branched on. A threshold (ADF has none) would be a later setting.
  - A duplicate key from a concurrent writer is skipped as the row's, as it is in ADF: it was incompatible when it was written.
  - On PostgreSQL, each batch's savepoint is a subtransaction, and more than 64 in one transaction overflow the backend's subtransaction cache. Other sessions' snapshot checks slow for the rest of a long copy. The field's help says the copy is slower with it on.
- **Deliberate differences from ADF:**
  - A column-count mismatch cannot arise, because a Copy writes the mapping's columns.
  - The skipped row is logged by its number, not its content.
  - Triggers' rejections are not skipped.
- `CATALOG_VERSION` 58→59: a pre-C6d build ignores the key and fails a copy this build finishes.

**Built (C6d-2, 2026-10-20):** a files-as-is Copy's *Skip missing files* and *Skip forbidden files*, the Settings tab's first two fields, before the Session log ([fault tolerance](https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance), "Copying binary files": `skipErrorFile.fileMissing`, default true, and `.fileForbidden`, default false).
- **Settings:** `skipMissingFiles` (on) and `skipForbiddenFiles` (off), literal booleans with ADF's defaults. As in ADF they apply only to a source of several files: a Folder (with or without a wildcard) or a File list. One file fails whatever they say. The dock draws them only for those path types (`appliesWhen`), and save refuses *Skip forbidden files* on one file. *Skip missing files* on one file cannot be refused, because it is the default and a default cannot be told from a choice. A saved Folder or File list Copy has neither key, so it now reads with *Skip missing files* on: a file removed during its copy is skipped with a warning where it used to fail the copy, as in ADF.
- **What is skipped:**
  - *Missing:* a file or subfolder removed by someone else after the copy chose it (`ENOENT` or `ENOTDIR`). That is a file gone between the folder's listing and its stat, a subfolder gone before it is listed, or a source gone before it is opened, including before *If file exists* = Skip compares it.
  - *Forbidden:* a file the connection may not open, a subfolder it may not list, or a file-list line in a folder it may not search (`EACCES` or `EPERM`).
  - Only the source's own open, listing or stat. A sink failure, a source replaced by another file, a symlink and an abort still fail.
- **How it is reported:**
  - A *Warning* `FileSkip` line. The item is the file's path under the source path (for a file-list line, the line as written, normalised), and the message is `skipped: removed by someone else and Skip missing files is on` (Delete's wording) or `skipped: permission denied and Skip forbidden files is on`.
  - A skipped subfolder's line says `folder`. It is not counted in `filesSkipped`, because its files were never seen.
  - Under *If file exists* = Skip, the compared target's one line adds `; its source could not be read: <reason>`, and the file is counted once.
  - Two file-list lines naming one forbidden file skip it once, as they would copy it once.
  - Skips made while selecting are counted beside a later plan refusal too, so a line never claims a file the counters do not.
- **A skipped source is never written, deleted or moved.**
  - No file is landed for a target whose sources were all skipped, so a missing source never becomes an empty copy.
  - A merge opens each source and closes it again before it writes, so the merged file's bits are those of the files it holds. A source lost to a race after that is left out too, and the bits are then narrower than they need be, never wider.
  - After copy leaves a skipped source where it is.
- **Deliberate differences from ADF:**
  - **A file-list line naming a file that is not there still fails** (`file list path '…' does not exist`). ADF's *fileMissing* is for files "being deleted by other applications" during the copy. A line that names nothing is the author's mistake, and skipping it by default would hide a typo.
  - The message is the reason, not the underlying error.
  - A file is skipped only before it is read, at its open, listing or stat. ADF can skip one part-way ("skipped after read N bytes"); here an error mid-read fails the copy, which leaves no partial file to explain.
  - ADF lists File System among the stores for *fileMissing* but not *fileForbidden*. Studio's file connection offers both.
  - *Skip missing files* and *Skip forbidden files* are one switch each, not ADF's `skipErrorFile` object. *Data inconsistency* is C6e-2's *Skip inconsistent files* (below), and *Invalid file name* applies only to ADLS Gen2 and S3, which studio does not have.
- **Empty sink subfolders (#1777, fixed):** when a target's sink folder does not exist yet, its sources are opened before the folder is made, so a target whose every source is skipped as missing or forbidden makes no folder. A folder that is already there, or that this run has made, costs no second open.
- **Residual:** a source lost between that first open and the copy's own still leaves its new subfolder empty, and so does a file C6e-2 skips as inconsistent, because it is skipped only after it is read. No data is affected: nothing is written and the source stays where it is.
- `CATALOG_VERSION` 59→60: a pre-C6d-2 build strips both keys and fails a copy this build finishes.

**Built (C6e-1, 2026-10-20):** a rows Copy's *Verify after copy*, on the Settings tab between *Skip incompatible rows* (on the same row) and the Session log, the Settings table's order ([data consistency](https://learn.microsoft.com/azure/data-factory/copy-activity-data-consistency): `validateDataConsistency`, default false).
- **Setting:** `validateDataConsistency`, ADF's name, a literal boolean, default off (ⓕ on typed fields is OR38 #1573).
- **The check is ADF's for a table:** rows read = rows written + rows skipped. Rows written is the store's own count, the one `rowsWritten` reports (#1270). The skipped rows are both kinds `rowsFailed` counts: a value a column's *If it won't convert* dropped, and a row the sink rejected under *Skip incompatible rows*. It is the condition `COPY_STORE_COUNT_DIFFERS` already warns on (`storeCountAdvisory`), judged as a gate instead of a warning.
- **When:** after the last batch is written and before COMMIT, inside the write transaction (`verifyBeforeCommit`, run by both sinks). A mismatch fails the copy `permanent` with `Verify after copy failed: the copy read R row(s) and skipped S, so N should have been written, but the store reports K`, and the sink's ROLLBACK unwinds the rows, an Overwrite's or Truncate's emptying, the Pre-copy script and an Auto-create. The failure path reports `rowsWritten: 0` because the sink proved the rollback. If the rollback itself fails, the sink's usual "the rollback FAILED" message and `partialWritePossible` apply, as on any failure. Off, a copy commits exactly as before C6e, and a mismatch is still the `COPY_STORE_COUNT_DIFFERS` warning.
- **What it catches:** a store whose own count of the rows it kept differs from the rows it was sent, such as a trigger's `RAISE(IGNORE)`, an `ON CONFLICT IGNORE` clause, or a PostgreSQL rule. A trigger or rule that discards rows on purpose therefore fails a verified copy, which the field's `?` says.
- **What it does not catch:** it compares the store's per-statement count, not a recount of the table. A SQLite `ON CONFLICT REPLACE` column reports each insert as one row while the table ends with fewer, so it passes. Recounting the table is not built: on Append it would need a count before and after, and a concurrent writer would make it wrong.
- **Refused with Upsert,** on the field (`copyVerifyConsistencyIssue`), at the #444 write gate, and by both sinks before a lock or a session (a `${}` Write behaviour that resolves to Upsert is caught there; `VERIFY_CONSISTENCY_UPSERT_REFUSAL`). An Upsert's store count is not the rows it was sent: on SQLite a matched row adds 0 when every mapped column is a key, and a key that is not unique adds one per row it updates; on PostgreSQL `DISTINCT ON` counts a key repeated in a chunk once. A row-count check would fail correct copies. The dock does not draw it under Upsert (`appliesWhen`), unless it holds a value or the Write behaviour is a `${}`.
- **Deliberate differences from ADF:**
  - ADF checks "after job completes", once the rows have landed. Studio checks before COMMIT, so a failed verification leaves the store as it was.
  - Not with Upsert (above). ADF's page does not mention Upsert.
  - No session-log line. The failure is the node's error, as for every rows Copy failure (C6a).
- **Not built here:**
  - **C6e-2:** Files as-is (built, below).
  - **The `consistency` output** (`{verified, result}`, ADF's `dataConsistencyVerification`) moves to C6f's complete outputs, so Copy's output contract changes once, with its `formerOutputs` snapshot and the `rowsFailed` → `rowsSkipped` rename (built in C6f-1, below).
- `CATALOG_VERSION` 60→61: a pre-C6e build strips the key and commits a copy this build rolls back and fails.

**Built (C6e-2, 2026-10-21):** a files-as-is Copy's *Verify copied files* and *Skip inconsistent files*, on the Settings tab after the C6d-2 skips and before the Session log ([data consistency](https://learn.microsoft.com/azure/data-factory/copy-activity-data-consistency): `validateDataConsistency` and `skipErrorFile.dataInconsistency`, both default false).
- **Settings:** `validateDataConsistency`, the rows Copy's key, and `skipInconsistentFiles`, literal booleans (ⓕ on typed fields is OR38 #1573). The title is *Verify copied files*, not *Verify after copy*, because a title may not hold another of the same activity's, and this mode has *After copy* (`activity-labels.test.ts`).
- **Where, as in ADF:**
  - The check applies only with *Copy behaviour* Preserve hierarchy. Save refuses it with Flatten or Merge, and so does dispatch for a `${}` Copy behaviour. The dock draws it only under Preserve (`appliesWhen`).
  - The skip applies only with the check, and only to a Folder or a File list. One file fails, as C6d-2's skips do. Save refuses it otherwise. The dock draws it once the check is on. View conditions are OR'd, so a verified one-file copy draws it too and save refuses it there.
- **The check is per file, before the file lands.** Once a source's bytes are written into the temp, and before the temp is synced and renamed, `changedSince` compares the source with the stat taken when it was opened. It is After copy's own rule, so the two cannot disagree. The source fails the check when:
  - it is removed, or another file takes its place;
  - a different number of bytes was read than it held;
  - its size changed;
  - or its modified time changed.
  
  Then the written file's size is compared with the bytes read on the handle it was written through: ADF's file size check, which ADF runs between any stores.
- **A failed check, with the skip off,** fails the copy `permanent` with `Verify copied files failed for '<file>': the source changed while it was copied: <reason>`, or `…: the file written holds K bytes, not the N bytes read`. An abort during the check is reported as the cancel, never as a failed check or a skip. The temp is removed, so nothing lands for that file. A target it would have overwritten keeps its old bytes, and the source is never deleted or moved. Files already copied stay copied: a files copy has no transaction to roll back, as before C6e. `permanent`, like After copy's `changedSince` refusal, because a retry would read a file that is still being changed.
- **With the skip on,** the file is a *Warning* `FileSkip` line, `skipped: <reason>, and Skip inconsistent files is on`, and it counts in `filesSkipped`, not in `filesRead` or `bytesRead`. It is never written, deleted or moved, and the rest are copied.
- **Off, a copy behaves exactly as before C6e-2:** a file that grows while it is read is landed with the bytes read.
- **A source removed while it is read** is inconsistent, not missing: *Skip missing files* covers a file gone before it is opened (C6d-2), and once it is read there is no source left to verify the copy against.
- **A file *If file exists* = Skip leaves in place** is not copied, so it is not verified.
- **Deliberate differences from ADF:**
  - No checksum. ADF checksums only Azure Blob and ADLS Gen2, and checks the file size between any stores. Studio checks the size and also the source's modified time, which a same-size rewrite changes.
  - The check runs before the file lands, not once the job is done, so an inconsistent file is never left in the sink.
  - A file is judged after it is read. A change made once the file is read and before its After copy is still caught there (`unchangedSince`), as before.
  - ADF's `FileSkip` message says how far it read ("skipped after read N bytes"). Studio's says what changed.
- **Residual:**
  - A file system whose modified time is coarse (whole seconds) can miss a same-size rewrite made within one tick.
  - A change made after the check and before the rename lands, a window of one fsync. After copy Delete or Move re-checks the source then, and Keep does not.
  - A skipped file can leave its new sink subfolder empty, because it is judged after it is read (the C6d-2 residual above).
- No new output: the `consistency` output stays with C6f's complete outputs, for both modes (built in C6f-1, below).
- `CATALOG_VERSION` 61→62: a pre-C6e-2 build strips both keys and lands a file this build fails or skips.

**Built (C6f-1, 2026-10-21):** Copy's complete outputs, in both modes ([monitor copy activity](https://learn.microsoft.com/azure/data-factory/copy-activity-monitoring), [data consistency](https://learn.microsoft.com/azure/data-factory/copy-activity-data-consistency#monitoring)).
- **Outputs, in the catalog's order:**
  - **Rows:** `rowsRead`, `rowsWritten`, `rowsSkipped`, `rowsFailed`, `bytesRead`, `truncated`, `durationMs`, `throughput`, `consistency`.
  - **Files as-is:** C1b's nine, then `durationMs`, `throughput`, `consistency`.
  - Every one but `throughput` is required. Each is yielded on success, a Files as-is Copy that selected nothing included, and as output events on a failure once the copy has started (`copyOutputs`, `outputsOf`). A refusal before then yields none, as before.
- **`rowsSkipped`** is ADF's name for the rows a copy skipped: coercion drops and the rows Skip incompatible rows let the sink reject. **`rowsFailed` stays** with the same number, so a node that reads it keeps working (§8, as Lookup kept `rowCount`). The run card, `COPY_ROWS_FAILED` and the progress tick's `rowsFailed` are unchanged.
- **`durationMs`** is the copy's own time on a monotonic clock (`performance.now()`), from the adapter's start to its terminal, rounded. **`throughput`** is `bytesRead` per second over that rounded duration, and null for a copy that took under half a millisecond, so the two always agree (`copyMeasure`, `datamove/copy-measure.ts`).
- **`consistency`** is `{verified, result}`:
  - `verified` says the check was on (ADF's `Verified` · `NotVerified`). It does not say the data was consistent; `result` does. ADF's `Unsupported` cannot arise, because save and dispatch refuse a check a copy cannot make (Upsert, a hierarchy other than Preserve).
  - `result` is ADF's `InconsistentData`: `none`, `found` (the check failed the copy, so it appears only in the output events ahead of the failure) or `skipped` (Files as-is: Skip inconsistent files stepped over a file). `none` means nothing inconsistent was found, so a copy that failed for another reason before its check ran also says `none`.
- **Stored contracts:** a node saved before C6f-1 holds the five (rows) or nine (Files as-is) former outputs, or C1a's seven for a Files as-is node saved before C1b, which had no snapshot until now. `formerOutputs` re-seeds each on the editor's load, as C7a's Lookup does, and the next Save writes it.
- **Deliberate differences from ADF:**
  - `bytesRead`/`bytesWritten`, not `dataRead`/`dataWritten`; `rowsWritten`, not `rowsCopied`, which studio's runs list already totals.
  - `durationMs` in milliseconds, not `copyDuration` in seconds, with Web's name and unit (Web reads the wall clock, Copy a monotonic one). `throughput` in bytes/s, not KBps, so it shares `bytesRead`'s unit.
  - `consistency` holds a boolean and a lower-case result rather than ADF's two strings.
- **Not built here:**
  - A rows Copy's `bytesWritten`. ADF's `dataWritten` is what the store kept, which a database sink does not report; a count of the bytes sent would read as that and is not.
  - `filesRead` for a delimited or Excel source. A rows Copy reads one file today, so the count would always be 1.
  - `logPath` is C6c's (Files as-is: C6c-1a; rows: C6c-1b; both built below) and `watermark` C5's.
- `CATALOG_VERSION` 62→63: a pre-C6f-1 build never yields the required new outputs, so it fails such a node "missing declared output".

**Built (C6f-2, 2026-10-21):** *Degree of copy parallelism* on Copy · Files as-is, and `usedParallelCopies` in both modes ([parallel copy](https://learn.microsoft.com/azure/data-factory/copy-activity-performance-features#parallel-copy): between file stores "`parallelCopies` determines the parallelism at the file level", no more than the number of files, and a merge "can't take advantage of file-level parallelism").
- **Setting:** `parallelCopies`, an integer from 1 to `COPY_MAX_PARALLEL_COPIES` (64, Delete's bound), default 1, ⓕ allowed. It leads the Settings tab, as in ADF's. It is drawn under Preserve and Flatten, and save refuses more than 1 under Merge, which writes one file. A one-file copy may set it and uses 1, as a folder holding one file does.
- **Run:** the targets are copied by a pool of workers over one cursor (Delete's). The first failure stops new work; the copies already under way finish, are counted, and their After copy applies, then the failure is the outcome. Above 1, the failure kept is the first to happen. An abort is checked at the start of every target, so it is never a quiet success. The workers share one creation of each new folder, and a folder found already there is marked for the flush too (another copy may have just made it under a name that differs only in case), so none removes a source before the folder entry it was copied into is durable. Flushes run one at a time, each syncing what was marked before it began, and a failed sync fails every later flush, so no source is removed after it. The pool is Delete's, written a second time (tech debt, #1782).
- **Output:** `usedParallelCopies` is the workers the copy ran: the degree, capped at the number of files selected to copy (a merge is one), and 1 when nothing was selected or the copy failed before it started writing. A rows Copy always yields 1: it is one reader pumped into one sink transaction, as ADF's copy from a store with no partition option ("parallel copy doesn't take effect").
- **Run log:** at 1 the lines are in the order they were before. Above 1 they are in the order the copies made them, so the lines of different files interleave. Each names its file.
- **Stored contracts:** a node saved before C6f-2 declares C6f-1's outputs. Those are a new `formerOutputs` snapshot for both modes, re-seeded on the editor's load.
- **Deliberate differences from ADF:** the default is 1, not Auto, so a node saved before C6f-2 copies as it did. The bound is 64, where ADF takes any integer from 1: Node's file calls share a small thread pool, so more rarely helps.
- **Not built here:** **C6f-3**, a rows Copy's partitioned reads (ADF's `partitionOption` on a database source), which is where the rows Copy's degree would apply (built, below).
- `CATALOG_VERSION` 63→64: a pre-C6f-2 build never yields `usedParallelCopies`, so it fails such a node "missing declared output".

**Built (C6f-3, 2026-10-21):** a rows Copy's *Partition option* Dynamic range on a PostgreSQL table, with *Degree of copy parallelism* as its degree ([parallel copy from PostgreSQL](https://learn.microsoft.com/azure/data-factory/connector-azure-database-for-postgresql#parallel-copy-from-azure-database-for-postgresql): "the parallel degree is controlled by the `parallelCopies` setting").
- **Settings:** on the Source tab, as in ADF, *Partition option* None · Dynamic range (`partitionOption`, default None), then, drawn under Dynamic range, *Partition column* (`partitionColumnName`, literal, as Key columns are: §8) and *Partition lower bound* / *Partition upper bound* (`partitionLowerBound` / `partitionUpperBound`, integers, optional, packed on one row). *Degree of copy parallelism* (`parallelCopies`, 1 to 64, default 1) leads the Settings tab under Dynamic range; it is Files as-is's field (one `parallelCopiesField`, its help per mode). Save refuses Dynamic range without a column, a column, bound or degree above 1 under None, a `${` in the column, and a lower bound above the upper (`copyPartitionIssues`).
- **Ranges:** the span from the lower to the upper bound is cut into `degree` equal ranges, no more than the span holds values (ADF's example: 1 to 80 at 4 is 1-20, 21-40, 41-60, 61-80). The bounds set the **stride, not a filter**, as ADF's example says: the first range is open below and holds the NULLs, and the last is open above, so every row is read exactly once and a bound authored inside the data loses nothing. A bound left empty is the column's lowest or highest value, read by one `min`/`max` scan; with both given there is no scan. An empty table, a column of NULLs or crossed bounds read as one range. The edges are bound as `bigint` parameters, so an edge past a smallint column's range compares rather than failing.
- **One snapshot:** a coordinator session opens a repeatable-read, read-only transaction and exports its snapshot; each range is read by a session of its own that imports it (`SET TRANSACTION SNAPSHOT`), so the readers see one consistent table, as the single reader did, and a row committed while they run is in none of them. A read of N ranges holds N + 1 source sessions, so a degree of 64 can hold 65 (count it against the server's `max_connections`). The snapshot's session is idle while the ranges are read; a server that ends idle sessions in a transaction (`idle_in_transaction_session_timeout`) shorter than the copy fails a reader that has not yet imported the snapshot.
- **Run:** planned after the ladder's other refusals and **before the write**, so its refusals (a column that is not smallint, integer or bigint, a missing column, a Query source, a source that is not PostgreSQL) land before the sink's transaction, Pre-copy script or Auto-create. The readers feed one stream (`mergeBatches`) into the pump and the one sink transaction. The first failure, a cancel, or the sink stopping early stops every reader at its next batch boundary and closes every session before the copy ends; the planning session is released on every path, including a sink that fails before it pulls a row.
- **Cancel:** a cancel or a failure stops each reader at its next batch boundary, so a reader in a long FETCH is waited for, bounded by the connection's statement timeout, as the one reader is.
- **Order:** rows arrive in the order the readers return them, so the sink's row order, a skipped row's `row N` and the batch lines' `rows a-b` vary between runs; the counts and Verify after copy do not. Upsert with a key repeated across ranges keeps whichever arrives last.
- **Output:** `usedParallelCopies` is the ranges read, from the moment they are planned (on the failure path too), and 1 under None. A copy refused while planning reports no outputs, as every refusal before the write does.
- **Refused, not partitioned:** a SQLite source (it reads on one thread in this process), a file source, and a Query source (no partition hook yet). Each fails permanent before any write and names Partition option None as the fix.
- **Deliberate differences from ADF:** the default degree is 1, not Auto. Integer columns only. The column is required: ADF's primary-key default is not built.
- **Not built here** (#1788, C6f-3b): Physical partitions of table, a Query's `?AdfDynamicRangePartitionCondition` hook, date and timestamp columns, the primary key as the default column, and a canvas warning for a source that cannot be partitioned.
- `CATALOG_VERSION` 67→68: a pre-C6f-3 build strips the fields and reads with one reader, so it reports `usedParallelCopies` 1 and copies from a source this build refuses.

**Built (C6c-1a, 2026-10-21):** Copy · Files as-is's session log written to a folder, through a **log connection** of its own ([session log](https://learn.microsoft.com/azure/data-factory/copy-activity-log): `logLocationSettings` names a linked service and a path).
- **Binding:** `Node.connectionIds.log`, an optional third end of the connection pair (`${}` allowed, resolved in the run's env as the others are). It sits inside the pair, not beside it, because every portability site rebuilds `{source, sink}` by name: a site that forgot it drops it, and the copy refuses at dispatch, where a field beside the pair would ride an export unremapped. The catalog says which activities have one (`logConnectionKinds`, `['fs']`, paired entries only). Dispatch resolves and readiness-gates it as it does the sink; the enable gate and the connection dependency preview count it. A failure to resolve it is labelled `log connection:` in the message; the durable `side` field still names only the pair's two ends.
- **Settings:** *Write to* Run log · Folder (`logTo`, default Run log; drawn while the log is on) and *Log folder* ⓕ (`logFolder`, drawn for Folder), Delete's fields and save rules, with the folder on the log connection. The *Log connection* picker is drawn on the Settings tab directly before *Log folder*, only file connections pickable. A log connection the log would not use (Write to is not Folder, or the activity has none) is refused at save. Write to Folder **without** one is not refused at save: an export strips a literal end and an import drops it, so refusing it would roll the import back. It is a canvas warning, and the run refuses it before copying anything. A bound log connection stays drawn after Write to goes back to Run log, so it can be cleared, and switching Copy mode drops it.
- **Before anything is planned:** the log connection must be a file connection that allows writes (the canvas warns first), and the folder must exist, be a folder and be writable (Delete's checks, now one shared `checkSessionLogFolder`). A Folder source's folder, or under it with Include subfolders on, is refused as the log folder: the copy would copy its own log, and After copy would delete or move it (Delete's overlap rule). Nothing is copied and no log is written then.
- **Writer:** `SessionLogWriter`, one CSV per attempt, `session-log.<run>.<node>.<attempt>.csv` (Delete's name and format: BOM, CRLF, formula cells quoted), created exclusively at its **final** name with the header, then appended as the copy goes: lines are buffered and written in order once 64 KiB is held and at the end (C6c-2: under Best effort; Reliable writes after every file). Writes are awaited between files, so a slow mount holds the copy back rather than the buffer growing. A server that dies mid-copy leaves the lines written so far, not an orphaned temp. Each write has `SESSION_LOG_WRITE_TIMEOUT_MS`; the first failure is kept and no later line is written. `SessionLog` hands each kept line to the writer (`onLine`) and holds none, so the file has every line, uncapped.
- **Terminals:** every terminal after the log is opened keeps it: success, nothing selected (a header-only file), a refusal while planning, a failure and a cancel. A failure or cancel ends the file with an *Error* `Copy` line holding the node's error, as Delete's does, since the file is read without the node's error beside it (the run log needs none: the failure is the node's error, C6a). `logPath` is the file, null for the run log. A write that fails mid-copy **stops the copy** before its next file (`the session log could not be written: …`), so After copy deletes or moves no more sources the author asked to have logged. A log that cannot be finished fails a successful copy `permanent` (`copied N files, but the session log '<path>' could not be written: …`), reporting the counts first with `logPath` null; an attempt already failing keeps its own error (Delete's rule). The file is closed once, whichever terminal asks. The run log gets no lines while the log goes to a folder, and its "not kept" line now points at a folder, since Files as-is can write one.
- **Secure flags:** Secure output withholds `logPath`, as it does every output. The file itself is not redacted: it is a file the author asked for, as Delete's is (C9c) and as Copy's written data is not.
- **Deliberate differences from ADF:** a log that cannot be written fails the copy, Delete's rule, under C6c-2's *Log mode* Reliable, the default; Best effort keeps copying and warns. One CSV file per attempt, not ADF's folder of files per run.
- `CATALOG_VERSION` 64→65: `logPath` is a new output (a `formerOutputs` snapshot of C6f-2's), and a pre-C6c build strips the log end and the two fields and writes no file.

**Built (C6c-1b, 2026-10-21):** a rows Copy's session log written to a folder, through the log connection C6c-1a built ([session log](https://learn.microsoft.com/azure/data-factory/copy-activity-log)).
- **Settings:** *Write to* and *Log folder* after *Session log*, with the *Log connection* picker directly before *Log folder*, as on Files as-is: the same fields, save rules (`sessionLogIssues`, also at dispatch) and canvas warning. `logConnectionKinds: ['fs']` on the rows entry, so the binding, readiness, portability and the dock needed no change. Allowed with Upsert, unlike the two Settings fields before it.
- **Before a store is opened:** the log connection and folder are the refusal ladder's last rung (`checkLogConnectionFolder`, now shared by both modes), so a missing, non-file or read-only log connection, or a bad folder, fails the copy with nothing read or written. No source overlap rule: a rows source is one table or file, and the log's name is the attempt's own, created exclusively. Then the file is created, and every later terminal keeps it.
- **When the log closes, relative to COMMIT:** the sink writes in one transaction, so unlike Files as-is the copy can be undone, and it is.
  - Between batches, the reader's batches flush the log once 64 KiB is held (C6c-2: under Best effort; Reliable flushes after every batch), and are awaited, so a slow mount holds the copy back. The reader's rather than the pump's: a batch whose rows were all skipped never reaches the sink, and it is the batch that logs most. The buffer is then at most 64 KiB and one batch's lines. A write that fails stops the copy inside the transaction, which rolls back (`the session log could not be written: …`, `permanent`).
  - After the last batch, the log is drained before the sink's Verify after copy and COMMIT, so a log that could not be written rolls the copy back too. No line is added after it: the last batch line is the pump's, and both sinks write a batch's statements (and log its rejected rows) before asking for the next.
  - After COMMIT only closing the file is left. If that fails, the rows are committed and the copy fails `permanent` (`copied N rows, but the session log '<path>' could not be written: …`), reporting the counts first with `logPath` null: Files as-is's rule, as the residual.
  - A cancel waits for a log write under way, up to `SESSION_LOG_WRITE_TIMEOUT_MS` (10 s), with the store's write transaction still open, as Files as-is waits between files.
- **Terminals:** a consumer that stops reading the activity's events still has the file closed. A refusal after the file is created (the source cannot be described, a mapped column is missing), a failure and a cancel end the file with an *Error* `Copy` line holding the node's error. Those refusals report no outputs, as Files as-is's planning refusals do; a failure reports its counters with `logPath`. The run log gets no lines while the log goes to a folder.
- **The run log's "not kept" line** now points at a folder for a rows Copy too, so `sessionLogRunValues` lost its `folderHint` option: every activity with a session log can write a folder.
- **Secure flags:** as C6c-1a: Secure output withholds `logPath`; the file is not redacted, and its reasons never hold a row's values (C6a).
- **Deliberate differences from ADF:** a log that cannot be written fails the copy, and rolls it back, under C6c-2's *Log mode* Reliable, the default; Best effort commits and warns. One CSV file per attempt.
- `CATALOG_VERSION` 65→66: `logPath` is a new output on a rows Copy (a `formerOutputs` snapshot of C6f-2's ten), and a pre-C6c-1b build strips the log end and the two fields and writes no file.

**Built (C6c-2, 2026-10-21):** Copy's *Log mode* Best effort · Reliable, in both modes ([session log](https://learn.microsoft.com/azure/data-factory/copy-activity-log): `copyActivityLogSettings.enableReliableLogging`, true for Reliable).
- **Setting:** `logMode`, `reliable` or `bestEffort`, defined once (`sessionLogModeField`, `catalog/session-log.ts`) and spread into both Copy schemas. It is titled *Log mode* rather than ADF's *Mode*, since the General tab already has *Copy mode*. It is drawn after *Log folder* while *Write to* is Folder, so the log connection picker stays directly before the folder it serves. Best effort without a folder log is refused at save and at dispatch, on `logMode` (`sessionLogIssues`); Reliable is the default, so it is never a stray. Delete has no mode: it writes its log once, at the end (C9c).
- **Reliable (the default):** the writer flushes at every flush point (`sessionLogWriterOptions`, `flushBytes` 0): after each file on Files as-is, and after each batch read on a rows Copy. A log that cannot be written stops the copy as C6c-1a and C6c-1b describe, and a rows Copy rolls back.
- **Best effort:** the writer holds lines until 64 KiB, and writes the rest at close. A write that fails stops the writing, not the copy. Files as-is copies the remaining files, and After copy still deletes or moves their sources. A rows Copy neither throws nor drains before COMMIT: a drain would hold the write transaction open, for up to the write bound, for an error it would not act on.
  - The success then carries a `warned` `copy_session_log_incomplete` (`WARNING_CODES.COPY_SESSION_LOG_INCOMPLETE`), saying the file is missing lines and why.
  - `logPath` names the file, which holds the lines written before the error.
  - This also covers a log that could not be closed, and a Files as-is copy that selected nothing.
  - A failed or cancelled copy keeps its own error, as in Reliable.
- **Not the mode's to excuse:** a log connection or folder that cannot be opened still refuses the copy before anything is read or written, in either mode. That is a configuration error, not a lost line.
- **Deliberate differences from ADF:**
  - Reliable is the default (ADF's is Best effort). A node saved before C6c-2 has no mode, and its copy failed when its log could not be written. Best effort as the default would turn those failures into successes, with After copy removing sources the log does not name.
  - Best effort flushes by size only, not also "within a period of time", so a slow copy's lines can wait until 64 KiB or the end.
- `CATALOG_VERSION` 66→67: a pre-C6c-2 build strips `logMode` and fails (or rolls back) a copy Best effort finishes, which is an outcome. A node saved before C6c-2 keeps its outcome, but its log is now written after each file or batch, in more and smaller writes.

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
- **Not in C9c:** ADF Copy's *Best effort · Reliable* mode, which Delete does not get (C6c-2 gave it to Copy only). The lines are held in memory (bounded by the connection's entry limit) and written at the end, so a server that dies mid-delete loses them.
- `CATALOG_VERSION` 50→51: `logPath` is a new output (with a `formerOutputs` snapshot of C9a's three), which a pre-C9c build never yields.
### 4.5 Script
Sources: [Script](https://learn.microsoft.com/azure/data-factory/transform-data-using-script), [Stored procedure](https://learn.microsoft.com/azure/data-factory/transform-data-using-stored-procedure).

- **Tabs:** General · Settings · Script.
- **Settings:** database connection (the same picker); *Block timeout* (default 30 min; built as the connection's Statement timeout, which it can only lower, C10b-2b).
- **Script:** one or more blocks, each with:
  - **Type**: Query (returns rows) · Non-query (DDL/DML);
  - SQL ⓕ (code editor);
  - **Parameters** table: name · type · value ⓕ · direction In / Out / In-out.
- A stored procedure is a block (`CALL proc(:a)` / `EXEC`).
- Blocks run in order, in **one transaction** if *Run as one transaction* (default off; on gives all-or-nothing).
- **Logging:** *Capture result sets* Off · First 1000 rows (default) · Up to the workspace cap; *Capture messages* (server notices).
- **Outputs:** `resultSets[{rowCount, rows}]`, `recordsAffected`, `outputParameters`, `truncated`, `outputLogs` (C10b-2b).
- Writing is gated by the connection's `writable` (fail-closed, as copy is today).

**Built (C10a, #1600): Script on SQLite** ([Script activity](https://learn.microsoft.com/azure/data-factory/transform-data-using-script)). A new runnable type `script` (`CATALOG_VERSION` 71→72), in the General group, on a `sqlite` connection only, so the picker offers only what can run (C10b-1 adds `postgres`).

- **Config** (`script-config.ts`): `blocks` (1 to 50) of `{type, sql, parameters?}`, `runAsOneTransaction` (default off) and `captureResultSets` (default *First 1000 rows*). A block's Type is required, as in ADF.
- **Tabs:** Settings (connection, *Run as one transaction*, *Capture result sets*) · Script (the blocks). The General tab is every activity's. The blocks were a row table: a Type select, the SQL, and Parameters as a JSON cell. C10c replaced it with a block editor (below).
- **The SQL is literal, a deliberate difference from this section's ⓕ** (C1q-b and C3b made the same correction). Save refuses a `${` in a block's SQL or Type (`scriptBlockIssues`), `prepInput` hands both over unsubstituted and evaluates only `parameters`, and the dispatch schema refuses a raw `${`. A value is bound, never spliced, so it can never become SQL.
- **Statements:** SELECT, WITH, INSERT, UPDATE, DELETE, REPLACE, CREATE, DROP, ALTER: the Pre-copy script's list plus SELECT, and for its reason (file confinement). ATTACH, VACUUM, PRAGMA and transaction control are refused, and every block is checked before any runs. The attached-database tripwire runs after every block. **One statement per block**, because better-sqlite3's `prepare` refuses a second; split a multi-statement script into blocks. A stored procedure does not exist on SQLite; it is a C10b block (`CALL`).
- **Writing:** a script with a Non-query block opens the store read-write under the same process-wide write queue a copy sink takes (#1423), and is refused on a connection not marked writable. A script of Query blocks only opens it read-only, takes no write lock, and every statement must be one SQLite reports as read-only before any runs. So `INSERT … RETURNING` written as a Query needs a Non-query block in the same script, which is the fail-closed side. The Problems list warns for a Non-query block on a sqlite connection without *Allow writes*.
- **Run as one transaction:** on, the blocks run inside one transaction (`BEGIN IMMEDIATE` when the script writes, a plain `BEGIN` when it only reads) and any failure rolls them all back. A rollback SQLite already did itself (`INSERT OR ROLLBACK`) is not repeated. If the rollback itself fails, the failure says some blocks may have been applied. Off, each block commits as it finishes. A failure after a block has already changed the store is then reported `permanent`, or stays `cancelled` on a cancel, and names how many blocks stay applied, because a retry would run them again. A Query block that writes counts as applied from its first row.
- **Capture result sets:** a Query block's rows are pulled 100 at a time, with a yield and a cancel check between batches. Its result set keeps the first 1000 rows (`SCRIPT_RESULT_ROW_CAP`, Lookup's default bound), within 1 MiB across the whole script (`LOOKUP_BYTE_CAP`), since outputs are durable. Both caps latch, so the kept rows are always a prefix: past the byte cap no later row of any set is kept. `rowCount` counts every row. A truncation sets `truncated` and warns `script_result_truncated`. *Off* keeps no rows and truncates nothing. *Up to the workspace cap* waits for a workspace setting of its own: the only row ceiling today is Lookup max rows, which belongs to Lookup. Integers past 2^53 stay exact (safe integers, as the reader).
- **Outputs:** `resultSetCount` (ADF's, a deliberate addition to this section's list), `resultSets[{rowCount, rows}]` in block order, `recordsAffected` (the Non-query blocks' changed rows, summed), `outputParameters` (always `{}` on SQLite, declared now so C10b changes no contract) and `truncated`.
- **Residual:** one statement is synchronous and cannot be interrupted (this SQLite omits the progress callback), so a single long block holds the server's event loop for its duration and the activity timeout cannot cut it short, as for a Pre-copy script or a large Overwrite (#1126).
- **Not built in C10a:** PostgreSQL (C10b-1, below), and the rest of C10b and C10c (below).

**Built (C10b-1, #1600): Script on PostgreSQL.** `script.connectionKinds` gains `postgres` (`CATALOG_VERSION` 72→73). The config, the tabs, the outputs and the literal-SQL rule are C10a's; `postgres-script.ts` runs it and shares the result-set capture and the outputs with `script.ts`.

- **Statements** (`SCRIPT_POSTGRES_STATEMENTS`, a list of its own so a Pre-copy script change cannot move it): SELECT, WITH, VALUES, TABLE, EXPLAIN, SHOW, INSERT, UPDATE, DELETE, MERGE, TRUNCATE, CREATE, DROP, ALTER, REFRESH, CALL, DO. It is not a privilege boundary (the connection's credential is), as for the Pre-copy script. It keeps out what would take the script out of the activity's hands: transaction control, `COPY`, `VACUUM`, and `SET`/`RESET`, because `SET TRANSACTION READ WRITE` as the first statement would lift a read-only script's guarantee. Measured on postgres:17, `set_config` cannot do that (the SELECT calling it has already taken the snapshot), but it can lift the server's `statement_timeout`, so pg's own client timer is the bound a block cannot change. Every block is checked, and its `:name`s rewritten to `$n`, before the session opens. Each is sent alone over the extended protocol, so the server refuses a second statement in one block.
- **A stored procedure is a block** (`CALL p(:a, null)`). Written as a Query, its Out and In-out values come back as the block's one row. C10b-2a fills `outputParameters` from them (below).
- **Writing.** A Non-query block needs a connection marked writable, refused before the session opens. A script of Query blocks only runs inside one `BEGIN READ ONLY` transaction whatever *Run as one transaction* says, so the server refuses a write (SQLSTATE 25006, measured for an INSERT and for `nextval`), reported as *Script block N writes to the store … make it a Non-query block*, followed by the server's words, which matter on a store that is itself read-only (a hot standby). SQLite asks each statement instead (C10a).
- **Rows are streamed and never kept whole.** Measured on postgres:17: `DECLARE CURSOR` refuses `INSERT … RETURNING`, a data-modifying `WITH` and `CALL`, each a legitimate Query block, so a block runs as one statement whose rows are handed to the capture one at a time and dropped. pg 8.23 keeps every row of a query that has a callback, and this one always has one (the client wraps it to clear `query_timeout`), so studio turns that off (`StreamedQuery`); a live test pins it. Non-query blocks run the same way, so an `INSERT … RETURNING *` written as one keeps nothing. Values read as Lookup on postgres reads them: `int8` and `numeric` as text, a naive `timestamp` as UTC.
- **`recordsAffected`** sums the Non-query blocks' INSERT, UPDATE, DELETE and MERGE counts. A SELECT's tag also carries a count, of rows returned, which is not rows changed.
- **A Query block whose statement returns no rows fails** after it has run, as on SQLite: postgres only says so once the statement has executed. "Returns rows" is the server describing a row, so `SELECT FROM t` (no columns) is a Query and `SELECT … INTO` is not.
- **What a failure leaves applied.** With *Run as one transaction* on, a failure rolls every block back, and a COMMIT that fails with no SQLSTATE (pg's client timeout, a dropped socket) is reported `permanent` because it may have landed. A cancel during the last block rolls the transaction back rather than committing it. Off, a statement is atomic, so a block the server refused applied nothing, and every block that finished counts as applied (a `SELECT f()` can write). The failing block counts too when its failure has no SQLSTATE (pg's client timeout, a socket code such as `EPIPE`), or when it is a `CALL` or `DO`, which may commit partway. Any applied block makes the failure `permanent` (or keeps it `cancelled`) and names how many, because a retry would run them again.
- **Bound.** Each block is one statement under the connection's *Statement timeout* (30 s by default), on the server and on pg's own timer, until *Block timeout* (C10b-2b, below) lowers it for a script. Cancel and the activity timeout are checked between blocks and before the COMMIT, and while a block runs they send the server a CancelRequest for the session (#1800), so the block fails `57014`, reported `cancelled`. The request is the protocol's, on a new connection, in plaintext as `pg` and libpq before 17 send it, so a front end that refuses it leaves the block running to that timeout. None is sent during BEGIN, COMMIT or ROLLBACK. A read-only script's client timeout is `transient`, as Lookup's is; a write script's stays `permanent`. A script with blocks applied outside a transaction is never retried, on either store, the activity timeout included: that timeout then ends `permanent` (code `timeout`) and names what stays applied (#1804).
- **The Problems list** warns for a Non-query block on either kind of connection without *Allow writes*.
- **Not built here.** **C10b-2a:** Out and In-out parameters (below). **C10b-2b:** *Capture messages* (server notices) and *Block timeout*. **C10c:** a block editor, the C1q SQL editor and a Name · Value table per block, in place of the row table's JSON cell.

**Built (C10b-2a, #1600): Script Out and In-out parameters on PostgreSQL** ([Script activity](https://learn.microsoft.com/azure/data-factory/transform-data-using-script), `scripts[].parameters[].direction`). Each block gains an optional `parameterDirections` beside `parameters`, keyed by the same names, each `in`, `out` or `inOut` (In needs no entry). `parameters` keeps its shape, so a saved script is unchanged. `CATALOG_VERSION` 73→74: the block is strict, so a pre-C10b-2a build refuses the new key at import.

- **Literal (§8)**, as the Type is: a direction decides what is sent and what is read back. Save refuses a `${` in a direction or its name (`scriptBlockIssues`), and `prepInput` evaluates only `parameters`.
- **What is sent.** An Out parameter binds NULL whatever value it was given, as ADF ignores an Output parameter's value, so it needs no entry in Parameters. An In-out parameter sends its value and still needs one. A direction for a name the block's SQL never binds is refused before the session opens. A stray `in` is not refused, since an unused Parameter is dropped (#1194).
- **What is read back, by NAME.** A `CALL` of a procedure with INOUT or OUT parameters returns one row whose columns are named after them (measured on postgres:17; a quoted name keeps its case, an unquoted one is lower-cased). Each Out and In-out name is read from the column of the same name. Position is never used: `CALL p(1, null, :z)` would map `:z` to the first OUT column. The block's Type does not matter. Written as a Query, the row is also its result set, and *Capture result sets* Off does not suppress `outputParameters`.
- **Refused after the statement has run:** no row (a procedure with no INOUT or OUT parameters returns none), more than one row, a name with no column (the failure lists the row's columns), and a value Lookup could not keep. The block counts as applied, so outside a transaction the failure is `permanent` (C10b-1's accounting). A row with two columns of one name keeps the last, as pg's row object does.
- **Same name in a later block replaces the earlier value**, ADF's documented rule. Values read as Lookup on postgres reads them (`int8` and `numeric` as text).
- **Bound.** `outputParameters` has a 1 MiB allowance of its own (`LOOKUP_BYTE_CAP`) across the script, charged per name, so a value a later block replaces gives its bytes back. A block's values go through the same check as a Lookup row and a result-set row (`keepRowWithin`, which folds #1794's two copies): the lower-bound estimate refuses a large string or byte value before it is copied, then the exact serialised size decides. Past the allowance the block fails rather than keeping part of a value. With the result sets' own 1 MiB, a script keeps at most 2 MiB of durable outputs (3 MiB once C10b-2b's `outputLogs` is counted).
- **SQLite refuses an Out or In-out direction** before the store opens: it has no stored procedures. An `in` direction runs as a plain bind value. There is no Problems-list warning for it yet. The run refuses it fail-closed and names the fix, so the warning is polish, and the save gate's literal check cannot see the connection's kind.
- **Values are sent untyped**, as every bind value here is. On an overloaded procedure, postgres resolves an untyped value to the `text` overload (measured: `ov(int)` and `ov(text)`, `CALL ov($1, $2)` ran the text one). Cast to choose (`CALL ov(:a::int, :r)`).
- **Not built here:** *Capture messages* and *Block timeout* (C10b-2b, below), the block editor (C10c).

**Built (C10b-2b, #1600): Script *Block timeout* and *Capture messages*** ([Script activity](https://learn.microsoft.com/azure/data-factory/transform-data-using-script): `scriptBlockExecutionTimeout`, `logSettings`, output `outputLogs`). Two Settings fields, `blockTimeoutSeconds` and `captureMessages`, and an `outputLogs` output. `CATALOG_VERSION` 74→75: the config object is not strict, so a pre-C10b-2b build would strip both keys and run without them. A Script saved before keeps its five outputs (`formerOutputs`). Both fields are drawn for a postgres connection only (`appliesWhen`).

- **Block timeout**, labelled *Timeout per block* (whole seconds, 1 to 86,400). The label differs because *Block timeout (seconds)* would contain the General tab's *Timeout (seconds)*, which #1396's label rule refuses. It arms both of the session's statement timers (`clientOptionsFor`: the server's `statement_timeout` and pg's client `query_timeout`), so it bounds every block and the BEGIN and COMMIT around them. A block cannot lift the client timer.
  - **It only ever lowers the connection's *Statement timeout*.** That is the connection owner's bound, which a node may not raise. This is `queryTimeoutSeconds`' rule (C1q-c). A longer value has no effect.
  - **Deliberate difference from this section's "default 30 min"** (and from ADF, which allows a long default): blank means the connection's Statement timeout, 30 s unless its owner set another. A cancel reaches a block in flight through a CancelRequest (#1800), but a front end that refuses one would leave a long default holding the cancel or the activity timeout that long.
  - **The ceiling is a day** (`SCRIPT_MAX_BLOCK_TIMEOUT_SECONDS`). pg's client timer is a `setTimeout`, which fires at once past 2^31-1 ms (#1799).
  - **The failure names the bound:** *Script block N ran past the Timeout per block of X seconds*, or *the script could not begin its transaction / commit within the Timeout per block of X seconds*, followed by the server's or pg's words. This happens only when the Block timeout was the bound, that is, strictly lower than the connection's; an equal value keeps the connection's. The failure kind stays the path's (C10b-1): `transient` for a read-only script, so the retry policy applies as it does to Lookup, and `permanent` for a write script, with the applied blocks counted.
  - **SQLite refuses a Block timeout** before the store opens. It runs a statement synchronously and cannot interrupt it (C10a's residual), so the bound could not be honoured.
- **Capture messages** (default off, as ADF's logging is off without `logSettings`). Every message the server sends while the script runs goes into `outputLogs`: RAISE NOTICE, a WARNING, `DROP … IF EXISTS`'s "skipping". `openSession`'s own set-up messages do not.
  - **Format.** Each message is `SEVERITY: message`, with its DETAIL and HINT on the following lines as psql prints them. Messages are joined by newlines, and the connection's secret is scrubbed from each. The severity is the server's localised one (pg does not parse the untranslated `V` field).
  - **Bound.** `outputLogs` has a 1 MiB allowance of its own (`LOOKUP_BYTE_CAP`), measured as it will be serialised (a newline costs two bytes). The cap latches, so what is kept is a prefix of whole messages. A message past the cap is dropped, never cut. It never fails the script (ADF: "any error caused by log won't fail the activity"). A truncation sets `truncated` and warns `script_messages_truncated`, which is a separate code from the result sets' `script_result_truncated`. With the result sets' and `outputParameters`' allowances, a script keeps at most 3 MiB of durable outputs.
  - **On a failed script they go to the run log** (#1801). `outputLogs` is an output, and only a success carries outputs (as in ADF), so before the failure each kept message is yielded as a `node.output outputLogs` line: inert, as a session log line is, so the Monitor's Logs tab shows it. The run log keeps the first `SESSION_LOG_RUN_MAX_LINES` and then a line counting the rest; a byte-cap truncation still warns. A succeeded script's messages stay in its output alone, so they are not stored twice.
  - **SQLite sends no messages**, so its `outputLogs` is always empty.
- **`outputLogs` is always present**, `''` when Capture messages is off. This matches `outputParameters`, so a downstream read never depends on a setting. It is a string, as ADF's is.
- **Not built here:** logs to an external store (ADF's `ExternalStore`; C6c's log connection is the likely seam) and the block editor (C10c).

**Built (C10c, #1600): the Script block editor.** The Script tab draws each block as its own group in place of C10a's row table: a head with *Block N*, its Type, ↑ ↓ and ✕, then its SQL and its Parameters. No schema change and no `CATALOG_VERSION` bump: the editor writes the same row-list draft the generic list did, so Apply, the JSON view and the save gate are unchanged (`ScriptBlocksEditor`, `scriptBlocks.ts`).

- **SQL** is C1q's statement editor (`LiteralSqlField`): one line at rest, growing as it is typed, ⤢ for a larger editor, and no ⓕ in either, since the SQL stays literal (§8).
- **Parameters** is one Name · Value · Direction table per block, merging `parameters` and `parameterDirections` by name. A Value takes ⓕ. A name with only a direction (an Out needs no value) is a row of its own, and choosing In removes its direction entry, since In is the default. A stored explicit `in`, and a value stored for an Out, are kept, so the editor never rewrites what it was given. *Add parameter* and *Import from statement* (the SQL's `:name`s with no row, read by the bound connection's lexer) work as C1q's do. A name with only a direction counts as bound, because an Out binds NULL.
- **Row notes:** a name the SQL does not use says *not bound* for In, but for Out and In-out it says the run refuses it (C10b-2a). Out or In-out on a SQLite connection says SQLite has none. An Out with a value says the value is not sent. A name with `${` is refused as it is typed (`bindNameProblem`), which is shared with C1q, so an inline query's bind value refuses one too; no `:name` can hold one.
- **No Type column, a deliberate difference from this section's "name · type · value".** A Script's authored values are text (`scriptConfigSchema` binds `z.string()`). A `${}` keeps the type it resolves to, and PostgreSQL receives values untyped (C10b-2a). C1q's Text · Number · Null choice belongs to an inline query, whose values are typed.
- **One editor, not a copy.** The bind row, the statement field and *Import from statement* moved out of `InlineSourceEditor` into `BindValues.tsx`, which both editors use. ↑ ↓ and the focus that follows a moved row are `useRowMoves`, which the generic row list uses too.
- **A block whose cells cannot be shown as rows keeps them as JSON**: text that is not JSON yet, or a non-text value. That choice is fixed for the block's mount, so the controls never swap mid-typing.
- *Add block* starts with no Type chosen (the Type is required and has no default) and stops at `SCRIPT_MAX_BLOCKS`.

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
- **A network failure is `transient`.** Node's `fetch` throws the same `TypeError` for a refused connection as for a bad URL, so the `cause.code` decides: ECONNREFUSED, ENOTFOUND, a dropped socket and the other listed codes are transient. A bad URL or header stays `permanent`. `http_request` and the LLM adapters reported them `permanent` until #1757; all three now classify through one `fetchFailure`, so lowering `http_request` no longer changes this result.
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
- **The callback URL** is absolute: `AUTONOMY_PUBLIC_URL` (configuration, with a path prefix allowed behind a proxy) joined to `/api/external-wait/<token>`. Unset, it is the bind address, which only a caller on the same machine can reach. A callback URL on a loopback or unspecified host (`127.0.0.0/8`, `::1`, `localhost`, `0.0.0.0`, `::`) records an `activity.warned` (`callback_url_loopback`) at dispatch, before the request, naming the origin and `AUTONOMY_PUBLIC_URL`, so a node that can only time out says why (#1761). It warns rather than fails, because a local endpoint can call it. The token is `webhook`'s: derived per attempt, stored only as a hash, never in the log. An endpoint that echoes its request cannot leak it: the URL and the token are redacted from Web's outputs and errors, like the Bearer.
- **The request runs as without the wait** (Fail on HTTP error, Max size, Parse as, Retry-After). A failure fails the attempt, and nothing waits. A success ends the attempt as `node.awaitingCallback` (the request's outputs, without `callback`). The engine then parks the node on `webhook`'s machinery: the expiry alarm, the correlation row and `externalWait.created`. The run shows *waiting*, and the owner's pending-callbacks panel offers the callback path (its editor sends a JSON object). A finished run offers none, even for a row a crash or a cancel left pending.
  - A redirect that would re-send the body to another origin (a 307 or 308), or drop it (a 303, or a 301 or 302 after a POST), fails the request: the first would hand the capability to another host, the second would leave the endpoint nothing to call back.
  - With *Fail on HTTP error* off (or a status in *Treat as success*), an error status is a request success and the node waits, as the author asked.
- **The callback route** answers 204 once the wait is settled and lets the run continue in the background, as the owner's door does. A `webhook` callback still waits for the resumed run to rest. A Web callback has no caller built on that, and holding the remote system's request open would block a single-threaded endpoint that the run's next Web call needs.
- **The callback.** Its JSON body, whole, is the `callback` output, merged with the request's outputs. An empty body is null. A body that is not JSON (or nests deeper than Web's 64-level response limit) is refused with 422 and the node stays parked, so the caller can retry. With *Report status on callback*, a `StatusCode` of 400 or above (a number or a numeric string, as in ADF's example) fails the activity. The message is `the callback reported StatusCode <n>: <ErrorCode>: <Message>`, carried on the event as `reportedError`. Like an expiry, it is a permanent failure: the retry policy does not apply, and the failure edge is the escape hatch. The callback is kept whole as `callback`, rather than ADF's `Output` alone, so `Error` and `StatusCode` stay readable.
- **The timeout** counts from the request's success. Running out fails the node as a `webhook` expiry does. `policy.timeoutSeconds` bounds the request only, not the wait.
- **A callback that arrives before the endpoint answers** (a synchronous endpoint that calls back first) is not lost. The correlation row is recorded before the request is sent, so the callback finds it. Its body is kept on the row (`external_waits.early_callback`, migration 0049) rather than appended to the log, because the run's own pump is mid-request. When the request returns, the park's arm reads it and settles the node at once: `externalWait.created.arrived`, with no alarm and no park.
  - A secure node's early callback is stored redacted, as the log will hold it.
  - An early callback is acknowledged (204) before the request's outcome is known. If the request then fails, the node fails as ADF's Webhook does when its call fails, and the callback is not used.
  - A request that ends without waiting expires its row, so a dead attempt offers no callback URL.
  - A crash mid-request can leave a `pending` row on an interrupted run. It completes nothing, because the completer checks the node.
- **Crash recovery:** a node held `ready` with its request's outputs re-parks on resume. It never re-sends the request; Web is not idempotent.
- **Not built in C11c-1 (C11c-2, below):** a Web with no URL, the `webhook` lowering, and Webhook leaving the palette.

**Built (C11c-2, 2026-10-18): a Web with no URL, and the `webhook` lowering.** C11 is complete with it.

- **No Request URL.** With *Wait for callback* on, the Request URL may be empty (an empty box is no URL). The Web then sends nothing and only waits: ADF's Webhook with nothing to call, and what studio's `webhook` did.
  - With *Wait for callback* off, a URL is still required.
  - Save refuses a request setting that would have nothing to apply to: Body, Request headers, Secret headers, HTTP request timeout and Treat as success (an emptied box, table or list is not one). The response settings are inert: there is no response. The dock still shows the request settings, because an `appliesWhen` condition names values and cannot say "empty".
  - It takes no activity timeout and no user properties (`timeoutApplies`), as a Webhook took none: it is never dispatched, so neither would apply. Its *Callback timeout* is the bound. A dispatch-time `${}` URL that resolves empty fails `permanent` with *the Request URL resolved empty*.
- **The engine never dispatches it.** The reducer holds it `ready` and parks it on the `webhook` machinery, as `node.awaitingCallback` does after a request (`webWaitsOnly`). It needs no connection, and a connection left on it neither resolves nor blocks a trigger's enable (`connection-readiness.ts`). From the park on, every C11c-1 rule holds: callback timeout, Report status on callback, early callback, crash re-park, cancel.
- **Outputs.** `callback` is the callback's body. The request outputs (`status`, `headers`, `body`, `bytes`, `durationMs`, `truncated`) are present nulls, so a read of one resolves to null rather than failing as missing. The run view's fold has no doc, so on a success it cannot tell this Web from a Webhook and shows the callback alone.
- **A body that is not JSON is kept as text** (bounded, as every callback body is, by the server's request body limit), where a Web that sent a request refuses it with 422. A Webhook accepted any body, so this keeps the lowering faithful. A Web that sent a request told its endpoint to call back with JSON, and the endpoint can retry.
- **Card:** *callback · timeout 10m 00s*, as the Webhook's was.
- **The `webhook` lowering** (`lowerWebhook` in `retired.ts`, §8). A stored Webhook opens as Web with *Wait for callback* on, no URL, *Callback timeout* from its timeout and *Report status on callback* off. The next Save writes it as `web`. A stored version still runs through `webhook`'s own arm. *Webhook* is no longer offered in the palette.
- **Faithful or not at all.** The node stays a Webhook when:
  - it declares outputs (`config.outputs` other than `[]`). A Webhook checks the callback against its contract, answering 422 for a missing key while the node stays parked, and its readers read `output.<key>`. Web keeps the whole body as `callback`, unchecked, and a read cannot be renamed to a path. C13's Convert has to explain this;
  - its timeout is anything but one whole number from 1 to 7 days in `${}` (`${900}`, `${ 900 }`). An expression is only known at the run, `${0}` completes at once, and Web's *Callback timeout* is a literal number with a 7-day ceiling;
  - it carries a connection or any other binding, or a key that is one of Web's own settings.
- **Deliberate differences of the saved node from Webhook:**
  - The callback is answered 204 at once and the run continues in the background, as for every Web callback (C11c-1). A Webhook's callback was answered only once the run came to rest.
  - The body is kept as `callback`; a Webhook with no declared outputs discarded it.
  - An array or scalar JSON body is the callback; a Webhook with no contract read it as `{}`.
- `CATALOG_VERSION` 53→54: a build before C11c-2 would dispatch a Web with no URL and fail it.

### 4.7 Set variable
Sources: [Set variable](https://learn.microsoft.com/azure/data-factory/control-flow-set-variable-activity), [Append variable](https://learn.microsoft.com/azure/data-factory/control-flow-append-variable-activity), [pipeline return value](https://learn.microsoft.com/azure/data-factory/tutorial-pipeline-return-value).

- **Operation** Set · Append (array variables only) · **Pipeline return value**. Return value is a key · type · content ⓕ table (*Return keys*) that the parent reads as `output.pipelineReturnValue.<key>`. It was planned to join OR34's outputs work; C12b split them, see below.
- **Variable** `[▾ declared variables]` (literal, with ＋ New variable).
- **Value** ⓕ.

**How C12a built it** (Set and Append; Pipeline return value is C12b):
- `set_variable` gained `operation` (`set` · `append`, `SET_VARIABLE_OPERATIONS`). An absent key is Set, so every Set variable saved before C12a keeps its meaning and its content hash. The dock's empty choice reads *Set (default)* and writes nothing. It is the tab's last field, after Variable and Value, where ADF puts the variable type first: a tab lists its required fields before its defaulted ones. It is a literal enum with no dynamic content, because it decides which event the write is (`variable.set` or `variable.append`) and what the determinism guard counts.
- One reading of a node's operation, `variableWriteOp`, used by the reducer (the write, its fold check and crash resume), the save rules, the dock's chooser and the card summary. Whether a node is a writer at all stays its type (`isVariableWriterType`), so a `set_variable` with an unknown operation is still checked as one: refused at save (`node.<id>.operation: must be Set or Append`), and a run of an older stored version that holds one ends `invalid_event` rather than guessing a write.
- Append behaves exactly as `append_variable` did: an untyped element, never coerced, an array variable only. The fold takes only `variable.append` for an Append node and only `variable.set` for a Set one.
- `append_variable` → Set variable · Append (§8), lowered in the editor only, as in C1b. It stays Append variable where it carries an `operation` key of its own (it never read one, and on Set variable it would decide the write), a connection or binding, or a config Set variable's schema refuses. Append variable left the palette and still runs.
- The variable chooser follows the Operation as drafted, so choosing Append narrows it to array variables before Apply.
- An `operation` key on a `set_variable` saved before C12a was never read (the save gate does not refuse an unknown config key, and nothing in studio wrote one), and is now. No stored version carries one: the operator's live store held 12 versions on 2026-10-18 and none had the key. A hand-written one would now decide the write, which is the price of reusing ADF's name.
- Not built here: ＋ New variable in the chooser (variables are declared on the pipeline's Variables tab, as before) and the one-click *Convert*, which is C13's.
- `CATALOG_VERSION` 54→55: a build before C12a ignores `operation`, so a Set variable · Append would replace the array.

**How C12b built it** (Pipeline return value):
- `operation: 'return'` with `returnValues`, a table of `{key, type, content?}` rows that the dock draws as *Return keys* (Key · Type · Content, ⓕ on Content; `content` is ADF's own name for a return value's payload). Operation stays the tab's last field (C12a's rule: required fields first). It decides the rest: Variable and Value apply to Set and Append, and Return keys to Pipeline return value (`appliesWhen`). Variable and Value stay required, so a Set marks them; the dock's pre-check does not refuse a required field it does not draw (`issuesOfShownFields`), and the save rules are the gate. A literal cell in a row list, the return Key, gets no ƒx, as a literal field does not. A return node has no Variable or Value, and a Set or Append has no Return keys. Each is refused at save rather than ignored.
- **Types:** String · Number · Boolean · Array · Object · Null.
  - ADF's Int and Float are one Number, studio's number type.
  - ADF's *Expression* type is dropped, because every row already takes `${}`.
  - Array and Object take JSON text or one whole-value `${}` of that kind. A Set's array has no literal form, but a return value is typed per row, so its text is decided.
  - Null takes no content. A String with none is `""`.
  - The literal and template checks are the run's own (`coerceReturnValue`, which reuses `coerceVariableValue` for the scalars), and a whole-value `${}` is type-checked at save as a Set's is.
- **Keys:** letters, digits and `_`, not starting with a digit, so `…pipelineReturnValue.<key>` is one path segment. They must be unique, at least one is required, and `__proto__` is refused. The run builds the map from own keys, so a stored one is never a prototype write.
- **Not a variable write.** The node succeeds the way Filter does: `succeedControl` → `node.succeeded` with the one output `pipelineReturnValue` (`json`). It records no `variable.*` event, and the determinism guard does not count it as a writer, although its reads still count. Its contract is derived from the Operation by `lowerSetVariableReturnOutputs` in `lowerPipelineNodes`, which overwrites it for a return node and heals the row back to `[]` when the Operation goes back to Set or Append. The canvas re-derives the contract on every config edit, so a child's own `${nodes.<ret>.output.pipelineReturnValue}` checks against what the server will store.
- **Failures:** a row of the wrong type, a map that is not replay-safe, or a map over `VARIABLE_MAX_BYTES` (256 KiB, counted over the whole map) fails the node `permanent` with the Set's `VARIABLE_*` codes. ADF's cap is 4 MB; studio keeps one bound for everything a run holds in state. A malformed table, or an evaluation that throws, ends the run `invalid_event`, as a Set does. Dispatch and crash resume share one function (`variableWriteCommand` → `returnValueCommand`).
- **The parent** reads `${nodes.<call>.output.pipelineReturnValue.<key>}`. `projectChildRunOutputs` reserves the name:
  - Only a return node contributes `pipelineReturnValue`, so an ordinary node's same-named output can't pose as one.
  - A nested call's value, which came from its grandchild, doesn't pass up (ADF parity).
  - If two return nodes both run, the last by sorted id wins, with its whole map: the keys aren't merged. ADF says to make sure only one runs.
  - With none, the key is absent, so a parent that reads one fails, as ADF's does. A rerun-from-failed copies the call node's outputs, or the return node's, like any other succeeded node's.
- **Not inside a ForEach**, at any depth, which is refused at save. Each item would replace the map, and a parallel body's per-item outputs are dropped at the end of each item, so the caller would get nothing.
- **Secure flags are refused**, because the values are handed unredacted to the calling pipeline.
- **`CATALOG_VERSION` 68→69:** a build before C12b reads an unknown Operation and ends the run `invalid_event`.
- **Split from OR34 #1483:** the C12 row bundled C12b with OR34's pipeline outputs. C12b builds the ADF mechanism, a return value. OR34 keeps a declared pipeline-level `outputs` getting value expressions, its binding modes (*Follow live* · *Follow latest* · *Pin*), and moving the merged child outputs under `.nodes`.

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
| Copy sink, rows | T delimited (OR14 writer) | ✓ append/overwrite/truncate/upsert (C3a), pre-copy script, batch size (C3b), auto-create (C3c) | ✓ same | — | OR13 | OR15 |
| Copy, files as-is | ✓ copy/move (single file); **T** folder, wildcard, list, delete-after | — | — | T (download to file) | OR13 | — |
| Lookup | ✓ | ✓ | ✓ | (use Web) | OR13 | OR15 |
| Get metadata | ✓ full field list (C8a), a file dataset's structure and column count (C8c-2); **T** wait | ✓ exists, structure, columns, rows (C8c-1) | ✓ same | — | OR13 | OR15 |
| Delete | ✓ one file, wildcard, subfolders, dates, empty folders (C9a); session log (C9c) | — (Script) | — (Script) | — | OR13 | — |
| Script | — | ✓ (C10a) | ✓ (C10b-1, C10b-2a Out parameters, C10b-2b messages and block timeout) | — | — | OR15 |
| Web | — | — | — | ✓ fail-on-error, cap, parse, Retry-After (C11a); ✓ callback, with or without a URL (C11c) | — | — |
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
| C3 | Copy: database sink. Truncate, upsert (keys), auto-create from mapping, pre-copy script, batch size. Split: **C3a** Write behaviour Truncate then insert and Upsert with Key columns (built); **C3b** Pre-copy script and Batch size (built); **C3c** *Auto-create from mapping* (built) | OR15 upsert/auto-create |
| C4 | Copy: mapping redesign (x → y rows from imported schemas, map-by-name default, type conversion settings, ƒx whole mapping, additional columns) | depends on OR10 import |
| C5 | Copy: incremental (watermark Automatic / Expression; files modified-since-last-success). Split: **C5a** a rows Copy from a database source, Automatic and Expression (built); **C5b** a Files as-is copy, *Modified since last successful run* (built; C5 complete) | OR15 incremental |
| C6 | Copy: settings. Fault tolerance, consistency check, parallelism, session log; complete outputs. Split: **C6a** the session log of a rows Copy, to the run log (built); **C6b** files-as-is lines (built); **C6c-1a** Write to a folder on a log connection, the appending writer, Files as-is `logPath` (built); **C6c-1b** a rows Copy's folder log and `logPath` (built); **C6c-2** Log mode Best effort · Reliable (built); **C6d-1** Skip incompatible rows, the rows the sink rejects (built); **C6d-2** Skip missing and forbidden files (built); **C6e-1** Verify after copy on a rows Copy, before COMMIT, not with Upsert (built); **C6e-2** Files as-is *Verify copied files* (size and modified time, before the file lands) and *Skip inconsistent files* (built); **C6f-1** complete outputs: `rowsSkipped`, `durationMs`, `throughput` and `consistency` {verified, result} for both modes (built); **C6f-2** Files as-is Degree of copy parallelism and `usedParallelCopies` for both modes (built); **C6f-3** a rows Copy's Dynamic range on a PostgreSQL table, one shared snapshot (built); **C6f-3b** Physical partitions, a Query's partition hook, date columns, the primary key default, a canvas warning (#1788) | — |
| C7 | Lookup: first-row-only, max rows, over-limit choice, whole-file text. Lower lookup and file_read. Split: **C7a** Settings (First row only, Max rows, When over the limit), `count`/`firstRow`, a stored node's former contract refreshed on load (built); **C7b** Read as Rows · Whole file as text (`file_read` as Lookup's second type), the title *Lookup* (built); **C7c** *When over the limit* and `bytes`/`truncated` for the text mode, limited by the connection's `maxBytes` rather than the 1 MiB byte cap (built); **C7d** the workspace Lookup max rows (1000 by default, up to ADF's 5000) and the Monitor Rows read column (built) | — |
| C8 | Get metadata + wait-until. Lower file_list. Split: **C8a** the `get_metadata` type on a file system connection, the field list as tick boxes, child items with filter, entries and modified window (built); **C8b** the `file_list` lowering with the `entries` → `childItems` rewrite, List directory retired from the palette (built); **C8c-1** tables (SQLite, Postgres) with per-kind field options (built); **C8c-2** a delimited or Excel dataset source's structure and column count (built); **C8d-1** Wait until on a file system path (built); **C8d-2a** Wait until on a delimited or Excel dataset, with #1743 (built); **C8d-2b** Wait until on a table dataset (built); **C8e** Include subfolders (built) | OR17 #1408 |
| C9 | Delete: wildcard, folders, dates, log. Lower file_delete. Split: **C9a** the `delete` type on a file system connection, with path type, wildcard, Include subfolders, modified window, Max concurrent deletes, Fail if nothing matched and Delete empty folders, on Get metadata's walk (built); **C9b** the `file_delete` lowering (Path type File, Fail if nothing matched on, `path` kept), Delete file retired from the palette (built); **C9c** the session log and `logPath` (a new output, so a `formerOutputs` snapshot and a version bump), shared with Copy's (built) | OR17 #1408 |
| C10 | Script activity (C10a, C10b-1, C10b-2a, C10b-2b, C10c built; C10 complete) | OR12 #1403, OR15 sql_script |
| C11 | Web: fail-on-error, response cap, parse, retry-after, wait-for-callback. Lower http_request and webhook. Split: **C11a** the `web` type, its Request, Auth and Settings tabs, and the redirect walk that keeps secret headers on their origin (built); **C11b** the `http_request` lowering (Fail on HTTP error off, Parse as Text, method upper-cased) and HTTP request retired from the palette (built); **C11c-1** Wait for callback with a URL (built); **C11c-2** a Web with no URL, the `webhook` lowering and Webhook retired from the palette (built) | — |
| C12 | Set variable operations + pipeline return value. Lower append_variable. Split: **C12a** Operation Set · Append, the `append_variable` lowering and Append variable retired from the palette (built); **C12b** Pipeline return value, read by the parent as `output.pipelineReturnValue.<key>` (built). OR34 #1483's declared pipeline outputs, binding modes and `.nodes` stay in OR34, see §4.7 | OR34 outputs (return value only) |
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
  | `webhook` | Web · Wait for callback, no URL, when it declares no outputs (C11c-2) |
  | `append_variable` | Set variable · Append (C12a) |

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
