import { z } from 'zod';
import { CallConfigSchema, type Output } from '../schemas/pipeline.js';
import { SecretRefSchema } from '../schemas/secret-ref.js';
import type { ActivityCatalog, ActivityCatalogEntry } from './types.js';
import {
  AGENT_TASK_ACTIVITY_TYPE,
  EXECUTE_PIPELINE_ACTIVITY_TYPE,
  FAIL_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_DELETE_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  FILE_WRITE_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  IF_ACTIVITY_TYPE,
  LLM_CALL_ACTIVITY_TYPE,
  SWITCH_ACTIVITY_TYPE,
  WAIT_ACTIVITY_TYPE,
  WEBHOOK_ACTIVITY_TYPE,
} from './types.js';
import { agentTaskConfigSchema } from './agent-config.js';
import { llmCallConfigSchema } from './llm-config.js';
import {
  fileCopyConfigSchema,
  fileDeleteConfigSchema,
  fileListConfigSchema,
  fileMoveConfigSchema,
  fileReadConfigSchema,
  fileWriteConfigSchema,
} from './fs-activity-config.js';

/**
 * P3 MVP activity catalog. Each entry is STATIC and pure (see
 * `ActivityCatalogEntry`). The executable side (the adapter that actually runs
 * an activity via its connector) lives server-side in `@autonomy-studio/server`
 * — this module is metadata only, so `shared` stays I/O-free and isomorphic.
 *
 * MVP set (per the target architecture): `http_request` (self-contained HTTP),
 * `llm_call` (an LLM provider connection), `agent_task` (an `agent_cli`
 * subprocess). In P3a only `http_request` has a server adapter; `llm_call` /
 * `agent_task` are catalogued (so the UI + reconciler know them) but a run that
 * dispatches one fails LOUDLY at the executor ("no adapter for kind …") until
 * P3b supplies the adapter — never a silent hang.
 *
 * `idempotent` is `false` for every MVP activity: an HTTP call may be a
 * non-GET write, an LLM call may already be billed, an agent subprocess has
 * arbitrary side effects. Fail-safe by default — a crash mid-flight FREEZES the
 * run (`interrupted`) rather than risk a double side effect on resume. A future
 * read-only activity (e.g. a pure `transform`) can opt into `idempotent: true`.
 */

const out = (name: string, type: Output['type']): Output => ({ name, type });

/**
 * The `http_request` secret-SINK config field name (item 7 / S4) — the ONE
 * source of truth. The catalog declares it as a sink here; the server http
 * adapter (`connectors/http.ts`) imports it to derive the `secretFields` key
 * prefix it consumes. Shared so a rename can't silently desync the two sides
 * (a magic string on each would drop the secret header without a type error).
 */
export const HTTP_SECRET_HEADERS_FIELD = 'secretHeaders';

/**
 * The Zod SHAPE of the `secretHeaders` sink value: header name → inert
 * `{$secret:name}` marker. SSOT'd here (not just the field NAME above) so the
 * catalog `configSchema` below and the http adapter's live `httpRequestInputSchema`
 * (`connectors/http.ts`) can't desync on the value/key constraints either — one
 * change to the record shape reaches both consumers, type-checked.
 */
export const httpSecretHeadersSchema = z.record(z.string(), SecretRefSchema).optional();

const ENTRIES: ActivityCatalogEntry[] = [
  {
    type: 'http_request',
    title: 'HTTP Request',
    kind: 'execution',
    category: 'general',
    idempotent: false,
    connectionKinds: ['http'],
    outputs: [out('status', 'number'), out('body', 'string'), out('headers', 'json')],
    // Item 7 / S4 — the FIRST real secret SINK. A `{$secret:name}` marker is
    // permitted only within `secretHeaders` (header name → marker); the save
    // gate (`validateRefs`) refuses one anywhere else, and the http adapter
    // sends the dispatch-resolved plaintext as that header, LAST, never echoed.
    secretSinkFields: [HTTP_SECRET_HEADERS_FIELD],
    configSchema: z.object({
      url: z.string().min(1),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      // Metadata only (catalog `configSchema` is not a save-time validator — the
      // adapter validates the live request). Documents the sink shape for the UI.
      // Computed key + shared shape (`httpSecretHeadersSchema`) so neither the
      // field name NOR the record shape can desync from the adapter's schema.
      [HTTP_SECRET_HEADERS_FIELD]: httpSecretHeadersSchema,
    }),
  },
  {
    type: LLM_CALL_ACTIVITY_TYPE,
    title: 'LLM Call',
    kind: 'execution',
    category: 'ai',
    idempotent: false,
    // #2 L14b — `agent_cli` joins the LLM-provider kinds: an `llm_call` can bind a
    // CLI/subscription connection (the SAME agent-CLI connection `agent_task` uses,
    // per the spec's "LLM connection kinds unchanged; subscription/CLI auth via the
    // agent CLI"). The `agent_cli` adapter serves BOTH activities, selecting by
    // `ctx.activityType`. Widening this list bumped `CATALOG_VERSION` 12→13 so a
    // pre-L14b build refuses to import a pipeline binding `agent_cli` to `llm_call`
    // (which it would reject at dispatch) rather than mis-run it — see version.ts.
    connectionKinds: ['anthropic_api', 'openai_api', 'ollama', 'agent_cli'],
    outputs: [out('text', 'string'), out('stopReason', 'string')],
    // #2 L1 — the SSOT config schema, shared with the three LLM adapters so the
    // palette metadata and the live request validation can never desync (the
    // same shared→server pattern `http_request` uses for `httpSecretHeadersSchema`).
    configSchema: llmCallConfigSchema,
  },
  {
    type: AGENT_TASK_ACTIVITY_TYPE,
    title: 'Agent Task',
    kind: 'execution',
    // Spec #4 files `agent_task` under "Execution — AI (Spec #2)" next to
    // `llm_call`: an external CLI agent is an AI activity, not its own class.
    category: 'ai',
    idempotent: false,
    connectionKinds: ['agent_cli'],
    outputs: [out('output', 'string'), out('exitCode', 'number')],
    configSchema: agentTaskConfigSchema,
  },
  {
    // #4 A1 — the `if` CONTROL activity. `kind:'control'` = engine-evaluated: the
    // reducer routes it STRUCTURALLY by `type` (the `call_pipeline`/`Node.call`
    // precedent), never a connector, so `connectionKinds` is empty and the
    // executor REFUSES a dispatched control node (`CONTROL_NOT_DISPATCHABLE`).
    // `idempotent` is inert for the same reason (nothing dispatches it), and
    // there are no `outputs` — an `if` produces a branch, not data. The
    // `configSchema` is palette metadata; the save-time condition rule is
    // `validateDoc`'s whole-value check. Cataloguing the TYPE (per D6's note)
    // bumped `CATALOG_VERSION` 2→3 so an older build refuses an if-doc it cannot
    // route rather than silently stranding its branch edges.
    type: IF_ACTIVITY_TYPE,
    title: 'If Condition',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ condition: z.string().min(1) }),
  },
  {
    // #4 A2 — the `switch` CONTROL activity. Same engine-evaluated shape as `if`
    // (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on dispatch, no
    // `outputs` — it produces a branch, not data): the reducer routes it
    // STRUCTURALLY by `type`. It matches the `${}` `on` value against declared
    // `cases` labels → the matching case's branch, or the implicit `default`.
    // `configSchema` is palette metadata (not the save-time validator, per the
    // A1 rebuttal — `validateDoc`'s `validateSwitchConfig` is the real gate);
    // `cases` carries no `.min(1)` here for the same reason. Cataloguing the TYPE
    // bumped `CATALOG_VERSION` 3→4 so an older build refuses a switch-doc it
    // cannot route rather than silently stranding its branch edges.
    type: SWITCH_ACTIVITY_TYPE,
    title: 'Switch',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ on: z.string().min(1), cases: z.array(z.string()) }),
  },
  {
    // #4 A7 — the `fail` CONTROL activity. Same engine-evaluated shape as `if`/
    // `switch` (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on
    // dispatch): the reducer routes it STRUCTURALLY by `type`. UNLIKE `if`/`switch`
    // it produces a FAILURE, not a branch — a ready `fail` resolves its `${}`
    // `message` PURELY and holds `ready` while the driver appends `node.failed`
    // (`kind:'permanent'`, `code:'forced_fail'`), which the graph's `failure` edges
    // then handle (unhandled → the run fails, ADF Fail's "fail the pipeline"). No
    // `outputs` (a fail produces no data) and no branch labels (a branch edge off a
    // `fail` is correctly invalid). `configSchema` is palette metadata; the
    // save-time rule is `validateDoc`'s `validateFailConfig`. Cataloguing the TYPE
    // bumped `CATALOG_VERSION` 4→5 so an older build refuses a fail-doc it cannot
    // route rather than silently treating the fail node as inert.
    type: FAIL_ACTIVITY_TYPE,
    title: 'Fail',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ message: z.string().min(1) }),
  },
  {
    // #4 A8 — the `filter` CONTROL activity. Engine-evaluated like `if`/`switch`/
    // `fail` (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on
    // dispatch): the reducer routes it STRUCTURALLY by `type`. UNLIKE `if`/`switch`
    // (a branch) and `fail` (a failure) it produces a normal SUCCESS carrying a
    // `result` output — the input `items` array filtered by the whole-value `${}`
    // `predicate`, order-preserved. The reducer composes the two config fields into
    // the INERT expression language's existing `filter(items, predicate)` closed-fn
    // (evaluated under ONE element budget) and holds `ready` while the driver
    // appends `node.succeeded{outputs:{result}}` via the `succeedControl` command.
    // `outputs`/`configSchema` are palette metadata; the save-time rules are
    // `validateDoc`'s `validateFilterConfig` (shape/whole-value) and `validateRefs`'
    // composed-expr scan (which gives the predicate lambda `${item}` scope).
    // Cataloguing the TYPE bumped `CATALOG_VERSION` 5→6.
    type: FILTER_ACTIVITY_TYPE,
    title: 'Filter',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [out('result', 'json')],
    configSchema: z.object({ items: z.string().min(1), predicate: z.string().min(1) }),
  },
  {
    // #4 A5+A6 — the `wait` CONTROL activity. Engine-evaluated like `if`/`switch`/
    // `fail`/`filter` (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on
    // dispatch): the reducer routes it STRUCTURALLY by `type`. UNLIKE the four
    // synchronous control activities it is DURABLE — a ready `wait` resolves its
    // whole-value `${}` `seconds` PURELY, and the driver ARMS S1's alarm then
    // appends `timer.waitScheduled`, parking the node `wait_pending` until the alarm
    // clock fires `timer.due` (which SUCCEEDS the node with no output). No `outputs`
    // (a wait produces no data) and no branch labels (a branch edge off a `wait` is
    // correctly invalid). `seconds` is a WHOLE-VALUE `${}` number field like
    // `if.condition`/`filter.items` (an embedded template can only be a string, so
    // `validateWaitConfig` refuses it at save); `configSchema` is palette metadata,
    // the save-time rule is `validateDoc`'s `validateWaitConfig`, and the run-time
    // type gate is `evalWaitSeconds` (finite, non-negative). `idempotent:false` is
    // inert (a control node is never dispatched, so no `node.dispatched.idempotent`
    // is ever written). Cataloguing the TYPE bumped `CATALOG_VERSION` 6→7 so an
    // older build refuses a wait-doc it cannot route rather than treating it inert.
    type: WAIT_ACTIVITY_TYPE,
    title: 'Wait',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ seconds: z.string().min(1) }),
  },
  {
    // #4 A13 — the `webhook` external-wait CONTROL activity. Engine-evaluated like
    // `wait` (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on
    // dispatch): the reducer routes it STRUCTURALLY by `type`. Like `wait` it is
    // DURABLE, but a DIFFERENT suspend/resume source — a ready `webhook` resolves
    // its whole-value `${}` `timeoutSeconds` PURELY, and the driver ARMS S1's
    // EXPIRY alarm (+ a correlation row) then appends `externalWait.created`,
    // parking the node `external_wait_pending`. It resumes when an inbound,
    // correlated + authed + replay-protected HTTP callback appends
    // `externalWait.completed` (SUCCEEDS the node) OR the expiry alarm fires
    // `externalWait.expired` (FOLDS the node to `failure`, so its `failure` edge is
    // the timeout/default path). #4 A16 (LANDED): the callback body is a TYPED
    // output — validated at the HTTP boundary against the webhook's declared generic
    // `config.outputs` and lowered onto `externalWait.completed.outputs`, so
    // `${nodes.w.output.decision}` resolves downstream (a webhook that declares no
    // outputs still succeeds with `{}`). The static `outputs:[]` here is the CATALOG
    // default (webhook outputs are AUTHOR-declared via `config.outputs`, like
    // `execute_pipeline`'s child-projected outputs — not catalog-fixed); no branch
    // labels. `timeoutSeconds` is a WHOLE-VALUE `${}` number field like
    // `wait.seconds` (an embedded template can only be a string, so
    // `validateWebhookConfig` refuses it at save); `configSchema` is palette
    // metadata, the save-time rule is `validateDoc`'s `validateWebhookConfig`, and
    // the run-time type gate is `evalWebhookTimeoutSeconds` (finite, non-negative,
    // bounded). A REQUIRED timeout guarantees a parked webhook always has a live
    // alarm (it can never stall). `idempotent:false` is inert (a control node is
    // never dispatched). Cataloguing the TYPE bumped `CATALOG_VERSION` 9→10 so an
    // older build refuses a webhook-doc it cannot route rather than treating it
    // inert. Config rides `Node.config` (not `Node.call`), so it is NOT a
    // structural-call and is generically authorable (no palette exclusion).
    type: WEBHOOK_ACTIVITY_TYPE,
    title: 'Webhook (external wait)',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ timeoutSeconds: z.string().min(1) }),
  },
  {
    // #4 A9 — the `execute_pipeline` CONTROL activity. It does NOT introduce a new
    // mechanism: it SURFACES the pre-existing structural `call_pipeline` (P2c) as a
    // first-class catalog TYPE. The reducer routes a call node STRUCTURALLY by the
    // presence of `Node.call` (`reduce.ts`), NEVER by this `type` — so no reducer
    // branch is added, and a legacy call node carrying any other `type` still
    // routes unchanged (back-compat). It reaches the executor only as a `startChild`
    // command (the real child spawn is P3b); the `kind:'control'` +
    // `CONTROL_NOT_DISPATCHABLE` guard only ever fires for a MIS-authored call-less
    // node, which `validateDoc` refuses to save.
    //
    // THE STRUCTURAL-CALL EXCEPTION: `configSchema` here types the `Node.call` blob
    // (reused from `CallConfigSchema`, the SSOT), NOT `Node.config` like every other
    // entry — so `isStructuralCallActivity` flags it and the generic palette/inspector
    // exclude it (call-node authoring is #425). `outputs:[]`: a call node's outputs
    // come from the CHILD projection, never a catalog template, so `lowerNodeOutputs`
    // skips call nodes (seeding `[]` would flip the contract absent→declared-empty and
    // silently drop every child output). Cataloguing this TYPE does NOT bump
    // `CATALOG_VERSION` (structural routing = no older build mis-runs it; see
    // `schemas/version.ts` + `catalog/types.ts`).
    type: EXECUTE_PIPELINE_ACTIVITY_TYPE,
    title: 'Execute Pipeline',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: CallConfigSchema,
  },
  {
    // #4 A11 — the `file_read` EXECUTION activity. The FIRST non-http/LLM
    // connector (`fs`): connector-dispatched I/O (`kind:'execution'`), so it
    // REQUIRES a bound `fs` connection whose non-secret `config.roots` the
    // server-side adapter confines the read to (path-traversal + symlink guard).
    // `idempotent:true` — a read is side-effect-free, so the boot reconciler may
    // safely RESUME an in-flight read after a crash (re-reading yields the same
    // bytes); it is the first activity to opt into the read-only idempotent case
    // the fail-safe `false` default anticipates. Outputs the file `content` (as
    // UTF-8 text) and the canonical `path` actually read. `configSchema` is
    // palette metadata; the adapter validates the live request (the `${}`-
    // substituted `path`). No `secretSinkFields` — `fs` is credential-less.
    type: FILE_READ_ACTIVITY_TYPE,
    title: 'Read File',
    kind: 'execution',
    category: 'general',
    idempotent: true,
    connectionKinds: ['fs'],
    outputs: [out('content', 'string'), out('path', 'string')],
    configSchema: fileReadConfigSchema,
  },
  {
    // #4 A11 — the `file_write` EXECUTION activity. Same `fs` connector as
    // `file_read`, but `idempotent:false`: a write is a SIDE EFFECT, so the boot
    // reconciler FREEZES an in-flight write after a crash rather than risk a
    // double write on resume (fail-safe). Overwrites the target (truncate) with
    // the `${}`-substituted `content` as UTF-8 text; outputs the `bytesWritten`
    // and the canonical `path`. Bounded by the same server-side root/traversal
    // guard as the read. `configSchema` is palette metadata; the adapter
    // validates the live request. No `secretSinkFields` — `fs` is credential-less.
    type: FILE_WRITE_ACTIVITY_TYPE,
    title: 'Write File',
    kind: 'execution',
    category: 'general',
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [out('bytesWritten', 'number'), out('path', 'string')],
    configSchema: fileWriteConfigSchema,
  },
  {
    // #4 A12 — `file_copy`. Copies `source` → `dest`, both confined to the `fs`
    // connection's roots by the same server-side guard. `idempotent:false` — a
    // copy overwrites `dest` (a side effect), so the reconciler FREEZES an
    // in-flight copy rather than risk a partial re-copy on resume. The adapter
    // STREAMS source→temp→rename (no in-memory size cap, unlike `file_read`), so
    // an arbitrarily large file copies without OOM. `configSchema` is palette
    // metadata; the adapter validates the live `${}`-substituted request.
    type: FILE_COPY_ACTIVITY_TYPE,
    title: 'Copy File',
    kind: 'execution',
    category: 'general',
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [out('bytesWritten', 'number'), out('source', 'string'), out('dest', 'string')],
    configSchema: fileCopyConfigSchema,
  },
  {
    // #4 A12 — `file_move`. Atomic same-filesystem `rename(source, dest)`, both
    // confined to the roots. `idempotent:false` — the source is GONE after a
    // successful move, so a resume of a completed move would fail (source
    // missing); the reconciler must freeze it. A move ACROSS filesystems throws
    // `EXDEV` → `permanent` (the operator composes `file_copy`+`file_delete` for
    // that); documented same-filesystem-only. Outputs the canonical source/dest.
    type: FILE_MOVE_ACTIVITY_TYPE,
    title: 'Move File',
    kind: 'execution',
    category: 'general',
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [out('source', 'string'), out('dest', 'string')],
    configSchema: fileMoveConfigSchema,
  },
  {
    // #4 A12 — `file_delete`. `unlink`s a single regular file confined to the
    // roots. `idempotent:false` — a delete is a side effect (and a missing target
    // is a `permanent` failure, not a benign success), so a resume must not
    // re-run it. The target-symlink guard means a symlink AT the path is refused,
    // not followed. Outputs the canonical `path` deleted.
    type: FILE_DELETE_ACTIVITY_TYPE,
    title: 'Delete File',
    kind: 'execution',
    category: 'general',
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [out('path', 'string')],
    configSchema: fileDeleteConfigSchema,
  },
  {
    // #4 A12 — `file_list`. Lists the entries of a directory confined to the
    // roots (bounded by the connection's `maxEntries`, default 10000). Like
    // `file_read` it is side-effect-free, so `idempotent:true` — the reconciler
    // may safely RESUME an in-flight list (re-listing yields an equivalent
    // result). Each entry is `{name, type}` where `type` is
    // `file`|`directory`|`symlink`|`other` from the raw dirent (a symlink entry
    // is REPORTED, never followed). Outputs the `entries` array (json) + the
    // canonical `path` listed.
    type: FILE_LIST_ACTIVITY_TYPE,
    title: 'List Directory',
    kind: 'execution',
    category: 'general',
    idempotent: true,
    connectionKinds: ['fs'],
    outputs: [out('entries', 'json'), out('path', 'string')],
    configSchema: fileListConfigSchema,
  },
];

/** The MVP activity catalog, keyed by `type`. Frozen (read-only) at module load. */
export const catalog: ActivityCatalog = new Map(ENTRIES.map((e) => [e.type, e]));

/** Look up an activity entry by `type`; `undefined` when the type is unknown. */
export function getActivity(type: string): ActivityCatalogEntry | undefined {
  return catalog.get(type);
}

/**
 * Whether an activity `type` stores its settings in `Node.call` (the structural
 * `call_pipeline` mechanism, P2c) rather than `Node.config`. Today this is
 * exactly `execute_pipeline` (#4 A9). It is the SSOT the generic authoring UI
 * consults to EXCLUDE such a type: the palette/inspector author `Node.config`, so
 * a call node needs the dedicated call-node authoring UI (#425), not a plain
 * config form. A magic per-type check in the web layer would desync from this
 * catalog fact, so the predicate lives here beside the entry.
 */
export function isStructuralCallActivity(type: string): boolean {
  return type === EXECUTE_PIPELINE_ACTIVITY_TYPE;
}
